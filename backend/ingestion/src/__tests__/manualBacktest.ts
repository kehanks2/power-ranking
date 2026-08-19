/**
 * Manual walk-forward prediction-accuracy backtest. At each game, check whether
 * the rating each team had strictly before it (no leakage) predicted the
 * winner, over the same real data computeRatings runs on. Sweeps metaWeight:
 * an unweighted (1.0) sum let region swings dominate individual team merit.
 */
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import {
  runReplay,
  combineContextualAndMeta,
  internationalParticipationFactor,
  type ReplayGame,
  type ReplayInput,
  type ReplayResult,
} from '@power-ranking/rating-engine';

const GLICKO2_SCALE = 173.7178;
const PHI_INIT_MAX = 350 / GLICKO2_SCALE;

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
function weekBucket(dateIso: string): string {
  const epochWeek = Math.floor(new Date(dateIso).getTime() / MS_PER_WEEK);
  return new Date(epochWeek * MS_PER_WEEK).toISOString().slice(0, 10);
}

function buildSnapshotLookup<T extends { asOfDate: string; mu: number; phi: number }>(
  rows: T[],
  keyOf: (row: T) => string,
): Map<string, { asOfDate: string; mu: number; phi: number }[]> {
  const byKey = new Map<string, { asOfDate: string; mu: number; phi: number }[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({ asOfDate: row.asOfDate, mu: row.mu, phi: row.phi });
  }
  return byKey;
}

/** Last snapshot strictly before `period` -- guarantees no leakage from the game being predicted. */
function snapshotBefore(
  snapshots: { asOfDate: string; mu: number; phi: number }[] | undefined,
  period: string,
): { mu: number; phi: number } {
  if (!snapshots) return { mu: 0, phi: PHI_INIT_MAX };
  let result = { mu: 0, phi: PHI_INIT_MAX };
  for (const snap of snapshots) {
    if (snap.asOfDate < period) result = snap;
    else break;
  }
  return result;
}

/** Sorted ISO dates of each team's own international games -- for walk-forward "days since" lookups. */
function buildIntlDatesByTeam(games: ReplayGame[]): Map<string, string[]> {
  const byTeam = new Map<string, string[]>();
  for (const game of games) {
    if (game.team1LeagueId === game.team2LeagueId) continue;
    for (const teamId of [game.team1Id, game.team2Id]) {
      if (!byTeam.has(teamId)) byTeam.set(teamId, []);
      byTeam.get(teamId)!.push(game.datetimeUtc);
    }
  }
  for (const dates of byTeam.values()) dates.sort();
  return byTeam;
}

/** Days between a team's last international game strictly before `period` and `period` itself; null if none yet. */
function daysSinceLastIntlBefore(dates: string[] | undefined, period: string): number | null {
  if (!dates) return null;
  let last: string | null = null;
  for (const date of dates) {
    if (date.slice(0, 10) < period) last = date;
    else break;
  }
  if (last === null) return null;
  return (new Date(period).getTime() - new Date(last).getTime()) / (1000 * 60 * 60 * 24);
}

function evaluateAccuracy(
  games: ReplayGame[],
  result: ReplayResult,
  metaWeight: number,
  intlOnly: boolean,
  useParticipationFactor: boolean,
  intlDatesByTeam?: Map<string, string[]>,
): { correct: number; total: number } {
  const teamSnaps = buildSnapshotLookup(result.teamHistory, (r) => r.teamId);
  const leagueSnaps = buildSnapshotLookup(result.leagueHistory, (r) => r.leagueId);

  let correct = 0;
  let total = 0;
  for (const game of games) {
    if (intlOnly && game.team1LeagueId === game.team2LeagueId) continue;
    const period = weekBucket(game.datetimeUtc);
    const t1 = snapshotBefore(teamSnaps.get(game.team1Id), period);
    const t2 = snapshotBefore(teamSnaps.get(game.team2Id), period);
    const l1 = snapshotBefore(leagueSnaps.get(game.team1LeagueId), period);
    const l2 = snapshotBefore(leagueSnaps.get(game.team2LeagueId), period);

    const p1 = useParticipationFactor
      ? internationalParticipationFactor(daysSinceLastIntlBefore(intlDatesByTeam?.get(game.team1Id), period))
      : 1;
    const p2 = useParticipationFactor
      ? internationalParticipationFactor(daysSinceLastIntlBefore(intlDatesByTeam?.get(game.team2Id), period))
      : 1;

    const combined1 = combineContextualAndMeta({ mu: t1.mu, phi: t1.phi, sigma: 0.06 }, { mu: l1.mu, phi: l1.phi, sigma: 0.06 }, metaWeight, PHI_INIT_MAX, p1);
    const combined2 = combineContextualAndMeta({ mu: t2.mu, phi: t2.phi, sigma: 0.06 }, { mu: l2.mu, phi: l2.phi, sigma: 0.06 }, metaWeight, PHI_INIT_MAX, p2);

    const predictedWinner = combined1.mu >= combined2.mu ? game.team1Id : game.team2Id;
    if (predictedWinner === game.winnerTeamId) correct += 1;
    total += 1;
  }
  return { correct, total };
}

async function main() {
  const pool = createPool();

  console.log('Loading real replay data (games + roster + seasonal decay events)...');
  const { teamIds, leagueIds, games, decayEvents } = await loadReplayData(pool);
  console.log(`Loaded ${games.length} games, ${decayEvents.length} decay events.`);

  // seriesCorrelation matches computeRatings.ts, so sweeps tune around the
  // shipped config, not a stale one.
  const baseConfig = { phiInitMax: PHI_INIT_MAX, sigmaDefault: 0.06, marginScale: 15, movWeightCap: 1.5, seriesCorrelation: 0.8 };
  const intlDatesByTeam = buildIntlDatesByTeam(games);

  console.log('\n=== Sweeping metaWeight (now consistent with production: effectiveMetaWeight confidence shrinkage applied) ===');
  const metaWeightsToTry = [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1.0];
  let bestWeight = 1.0;
  let bestAccuracy = -1;
  for (const metaWeight of metaWeightsToTry) {
    const input: ReplayInput = { teamIds, leagueIds, games, decayEvents, config: { ...baseConfig, metaWeight } };
    const result = runReplay(input);
    const overall = evaluateAccuracy(games, result, metaWeight, false, false);
    const intlOnly = evaluateAccuracy(games, result, metaWeight, true, false);
    const overallAcc = (overall.correct / overall.total) * 100;
    const intlAcc = (intlOnly.correct / intlOnly.total) * 100;
    console.log(
      `metaWeight=${metaWeight.toFixed(2)}: overall ${overall.correct}/${overall.total} (${overallAcc.toFixed(2)}%) | intl-only ${intlOnly.correct}/${intlOnly.total} (${intlAcc.toFixed(2)}%)`,
    );
    if (overallAcc > bestAccuracy) {
      bestAccuracy = overallAcc;
      bestWeight = metaWeight;
    }
  }
  console.log(`\nBest metaWeight so far: ${bestWeight} (${bestAccuracy.toFixed(2)}%)`);

  console.log('\n=== MOV weighting, at the best metaWeight found ===');
  const movEnabledInput: ReplayInput = { teamIds, leagueIds, games, decayEvents, config: { ...baseConfig, metaWeight: bestWeight } };
  const movDisabledInput: ReplayInput = {
    teamIds,
    leagueIds,
    games,
    decayEvents,
    config: { ...baseConfig, marginScale: 1e9, metaWeight: bestWeight }, // huge marginScale -> weight approx 1 always
  };
  const withMov = evaluateAccuracy(games, runReplay(movEnabledInput), bestWeight, false, false);
  const withoutMov = evaluateAccuracy(games, runReplay(movDisabledInput), bestWeight, false, false);
  console.log(`With MOV weighting:    ${withMov.correct}/${withMov.total} (${((withMov.correct / withMov.total) * 100).toFixed(2)}%)`);
  console.log(`Without MOV weighting: ${withoutMov.correct}/${withoutMov.total} (${((withoutMov.correct / withoutMov.total) * 100).toFixed(2)}%)`);

  console.log('\n=== Per-team international-participation decay, at the best metaWeight found ===');
  const finalResult = runReplay({ teamIds, leagueIds, games, decayEvents, config: { ...baseConfig, metaWeight: bestWeight } });
  const withoutParticipation = evaluateAccuracy(games, finalResult, bestWeight, false, false);
  const withParticipation = evaluateAccuracy(games, finalResult, bestWeight, false, true, intlDatesByTeam);
  const withoutParticipationIntl = evaluateAccuracy(games, finalResult, bestWeight, true, false);
  const withParticipationIntl = evaluateAccuracy(games, finalResult, bestWeight, true, true, intlDatesByTeam);
  console.log(
    `Without participation decay: overall ${((withoutParticipation.correct / withoutParticipation.total) * 100).toFixed(2)}% | intl-only ${((withoutParticipationIntl.correct / withoutParticipationIntl.total) * 100).toFixed(2)}%`,
  );
  console.log(
    `With participation decay:    overall ${((withParticipation.correct / withParticipation.total) * 100).toFixed(2)}% | intl-only ${((withParticipationIntl.correct / withParticipationIntl.total) * 100).toFixed(2)}%`,
  );
  console.log('(Official Global Power Rankings self-reports ~65% predictive accuracy, for rough reference.)');

  console.log('\n=== Roster-change decay persistence threshold (games of a new player before it counts as real turnover) ===');
  const persistenceValuesToTry = [2, 3, 4, 5];
  for (const persistenceGames of persistenceValuesToTry) {
    const reloaded = await loadReplayData(pool, persistenceGames);
    const rosterEventCount = reloaded.decayEvents.filter((e) => e.kind === 'roster_change').length;
    const input: ReplayInput = { teamIds, leagueIds, games: reloaded.games, decayEvents: reloaded.decayEvents, config: { ...baseConfig, metaWeight: bestWeight } };
    const result = runReplay(input);
    const acc = evaluateAccuracy(reloaded.games, result, bestWeight, false, false);
    console.log(
      `persistence=${persistenceGames}: ${rosterEventCount} roster-decay events | accuracy ${acc.correct}/${acc.total} (${((acc.correct / acc.total) * 100).toFixed(2)}%)`,
    );
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
