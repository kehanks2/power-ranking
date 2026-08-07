/**
 * Diagnostic: is the model actually weak, or is the METRIC misleading?
 * Reports game-level accuracy, SERIES-level accuracy (what the official GPR's
 * ~65% is most likely measuring), and calibration (Brier/log-loss + buckets),
 * which matters more than raw accuracy for a probabilistic rating system.
 */
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import {
  runReplay,
  combineContextualAndMeta,
  E,
  MARGIN_SCALE,
  MOV_WEIGHT_CAP,
  META_WEIGHT,
  SERIES_CORRELATION,
  RATING_PERIOD_DAYS,
  INTERNATIONAL_WEIGHT_MULTIPLIER,
  type ReplayGame,
} from '@power-ranking/rating-engine';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
// Override so a knob sweeps through this same evaluation, not a drifting copy.
const RELIEF_OVERRIDE = process.argv.includes('--relief')
  ? Number(process.argv[process.argv.indexOf('--relief') + 1])
  : undefined;
// --window-months N replays only the last N months. --eval-since holds the
// evaluated games fixed, so a windowed and an unbounded model score on the same
// fixtures rather than the window grading itself on an easier set.
const WINDOW_MONTHS = process.argv.includes('--window-months')
  ? Number(process.argv[process.argv.indexOf('--window-months') + 1])
  : undefined;
const EVAL_SINCE = process.argv.includes('--eval-since')
  ? process.argv[process.argv.indexOf('--eval-since') + 1]
  : undefined;
const GLICKO2_SCALE = 173.7178;
const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
// Constants imported, not restated: hand-copied values once drifted from the
// shipped config, so every printed figure described a model nobody ships.

const MS_PER_DAY = 24 * 60 * 60 * 1000;
function weekBucket(dateIso: string): string {
  const periodMs = RATING_PERIOD_DAYS * MS_PER_DAY;
  const epochPeriod = Math.floor(new Date(dateIso).getTime() / periodMs);
  return new Date(epochPeriod * periodMs).toISOString().slice(0, 10);
}
function buildSnapshotLookup<T extends { asOfDate: string; mu: number; phi: number }>(rows: T[], keyOf: (row: T) => string) {
  const byKey = new Map<string, { asOfDate: string; mu: number; phi: number }[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({ asOfDate: row.asOfDate, mu: row.mu, phi: row.phi });
  }
  return byKey;
}
function snapshotBefore(snaps: { asOfDate: string; mu: number; phi: number }[] | undefined, period: string) {
  if (!snaps) return { mu: 0, phi: PHI_INIT_MAX };
  let result = { mu: 0, phi: PHI_INIT_MAX };
  for (const s of snaps) {
    if (s.asOfDate < period) result = s;
    else break;
  }
  return result;
}

async function main() {
  const pool = createPool(DATABASE_URL);
  const { teamIds, leagueIds, games: allGames, decayEvents } = await loadReplayData(pool);
  const latest = allGames.reduce((max, g) => (g.datetimeUtc > max ? g.datetimeUtc : max), allGames[0].datetimeUtc);
  const windowStart =
    WINDOW_MONTHS === undefined
      ? null
      : new Date(new Date(latest).getTime() - WINDOW_MONTHS * 30.44 * 86400000).toISOString();
  const games = windowStart === null ? allGames : allGames.filter((g) => g.datetimeUtc >= windowStart);
  if (windowStart !== null) {
    console.log(`window: last ${WINDOW_MONTHS} months -> ${games.length} of ${allGames.length} games
`);
  }

  // Same ORDER BY as loadReplayData, so index i lines up with games[i].
  const seriesRows = await pool.query<{ series_id: number }>(`
    SELECT g.series_id
    FROM games g
    JOIN team_league_memberships tlm1 ON tlm1.team_id = g.team1_id AND tlm1.end_date IS NULL
    JOIN team_league_memberships tlm2 ON tlm2.team_id = g.team2_id AND tlm2.end_date IS NULL
    ORDER BY g.datetime_utc
  `);
  if (seriesRows.rows.length !== games.length) {
    console.warn(`WARN: series row count ${seriesRows.rows.length} != games ${games.length}; series-level numbers may be off`);
  }

  const result = runReplay({
    teamIds,
    leagueIds,
    games,
    decayEvents,
    config: {
      phiInitMax: PHI_INIT_MAX,
      sigmaDefault: 0.06,
      marginScale: MARGIN_SCALE,
      movWeightCap: MOV_WEIGHT_CAP,
      metaWeight: META_WEIGHT,
      seriesCorrelation: SERIES_CORRELATION,
      ratingPeriodDays: RATING_PERIOD_DAYS,
      internationalWeightMultiplier: INTERNATIONAL_WEIGHT_MULTIPLIER,
      ...(RELIEF_OVERRIDE === undefined ? {} : { priorConfidenceRelief: RELIEF_OVERRIDE }),
    },
  });
  const teamSnaps = buildSnapshotLookup(result.teamHistory, (r) => r.teamId);
  const leagueSnaps = buildSnapshotLookup(result.leagueHistory, (r) => r.leagueId);

  let correct = 0;
  let total = 0;
  let brier = 0;
  let logLoss = 0;
  const buckets = new Map<number, { predSum: number; wins: number; n: number }>();
  // seriesId -> {probSum, n, team1Id, winnerTeamId, team1Wins, team2Wins}
  const bySeries = new Map<number, { p1Sum: number; n: number; team1Id: string; team1GameWins: number; team2GameWins: number }>();

  for (const [i, game] of (games as ReplayGame[]).entries()) {
    if (EVAL_SINCE !== undefined && game.datetimeUtc < EVAL_SINCE) continue;
    const period = weekBucket(game.datetimeUtc);
    const t1 = snapshotBefore(teamSnaps.get(game.team1Id), period);
    const t2 = snapshotBefore(teamSnaps.get(game.team2Id), period);
    const l1 = snapshotBefore(leagueSnaps.get(game.team1LeagueId), period);
    const l2 = snapshotBefore(leagueSnaps.get(game.team2LeagueId), period);
    const c1 = combineContextualAndMeta({ mu: t1.mu, phi: t1.phi, sigma: 0.06 }, { mu: l1.mu, phi: l1.phi, sigma: 0.06 }, META_WEIGHT, PHI_INIT_MAX);
    const c2 = combineContextualAndMeta({ mu: t2.mu, phi: t2.phi, sigma: 0.06 }, { mu: l2.mu, phi: l2.phi, sigma: 0.06 }, META_WEIGHT, PHI_INIT_MAX);

    // P(team1 wins), accounting for opponent uncertainty the same way the engine does.
    const combinedPhi = Math.hypot(c1.phi, c2.phi);
    const p1 = E(c1.mu, c2.mu, combinedPhi);
    const team1Won = game.winnerTeamId === game.team1Id ? 1 : 0;

    total += 1;
    if ((p1 >= 0.5 ? 1 : 0) === team1Won) correct += 1;
    brier += (p1 - team1Won) ** 2;
    logLoss += -(team1Won * Math.log(Math.max(p1, 1e-12)) + (1 - team1Won) * Math.log(Math.max(1 - p1, 1e-12)));

    // Calibration bucket on the confident side, so buckets are 0.5..1.0
    const pConf = Math.max(p1, 1 - p1);
    const wonConf = p1 >= 0.5 ? team1Won : 1 - team1Won;
    const b = Math.min(9, Math.floor(pConf * 20) - 10); // 0.50-0.55 -> 0, ... 0.95-1.0 -> 9
    if (!buckets.has(b)) buckets.set(b, { predSum: 0, wins: 0, n: 0 });
    const bucket = buckets.get(b)!;
    bucket.predSum += pConf;
    bucket.wins += wonConf;
    bucket.n += 1;

    const seriesId = seriesRows.rows[i]?.series_id;
    if (seriesId !== undefined) {
      if (!bySeries.has(seriesId)) bySeries.set(seriesId, { p1Sum: 0, n: 0, team1Id: game.team1Id, team1GameWins: 0, team2GameWins: 0 });
      const s = bySeries.get(seriesId)!;
      // games within a series can have team1/team2 flipped; normalize to s.team1Id
      const p1ForSeriesTeam1 = game.team1Id === s.team1Id ? p1 : 1 - p1;
      s.p1Sum += p1ForSeriesTeam1;
      s.n += 1;
      if (game.winnerTeamId === s.team1Id) s.team1GameWins += 1;
      else s.team2GameWins += 1;
    }
  }

  console.log('=== GAME level ===');
  console.log(`accuracy:  ${correct}/${total} (${((correct / total) * 100).toFixed(2)}%)`);
  console.log(`Brier:     ${(brier / total).toFixed(4)}  (0.25 = always guessing 50/50; lower is better)`);
  console.log(`log loss:  ${(logLoss / total).toFixed(4)}  (0.6931 = always 50/50; lower is better)`);

  let sCorrect = 0;
  let sTotal = 0;
  for (const s of bySeries.values()) {
    if (s.team1GameWins === s.team2GameWins) continue; // no decisive series winner
    const predTeam1 = s.p1Sum / s.n >= 0.5;
    const actualTeam1 = s.team1GameWins > s.team2GameWins;
    sTotal += 1;
    if (predTeam1 === actualTeam1) sCorrect += 1;
  }
  console.log('\n=== SERIES level (likely what the official ~65% measures) ===');
  console.log(`accuracy:  ${sCorrect}/${sTotal} (${((sCorrect / sTotal) * 100).toFixed(2)}%)`);

  console.log('\n=== Calibration (confident-side probability vs actual win rate) ===');
  for (const b of [...buckets.keys()].sort((a, z) => a - z)) {
    const { predSum, wins, n } = buckets.get(b)!;
    const lo = (50 + b * 5).toFixed(0);
    const hi = (55 + b * 5).toFixed(0);
    console.log(`${lo}-${hi}%: predicted ${(100 * predSum / n).toFixed(1)}%  actual ${(100 * wins / n).toFixed(1)}%  (n=${n})`);
  }

  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
