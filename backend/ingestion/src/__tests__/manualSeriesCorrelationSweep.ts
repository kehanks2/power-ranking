/**
 * Tunes ReplayConfig.seriesCorrelation (rho) -- see seriesEvidenceWeight in
 * replay.ts. Judged on calibration (Brier / log loss / high-confidence error),
 * not accuracy: down-weighting correlated evidence barely reorders predictions,
 * so accuracy is flat by construction; the fix is the model claiming 90% and
 * delivering 79%.
 */
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import { runReplay, combineContextualAndMeta, E, type ReplayGame } from '@power-ranking/rating-engine';

const GLICKO2_SCALE = 173.7178;
const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
const META_WEIGHT = 0.8;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
function periodBucket(dateIso: string, periodDays: number): string {
  const periodMs = periodDays * MS_PER_DAY;
  const epochPeriod = Math.floor(new Date(dateIso).getTime() / periodMs);
  return new Date(epochPeriod * periodMs).toISOString().slice(0, 10);
}
function buildSnapshotLookup<T extends { asOfDate: string; mu: number; phi: number }>(rows: T[], keyOf: (r: T) => string) {
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
  const pool = createPool();
  const { teamIds, leagueIds, games, decayEvents } = await loadReplayData(pool);
  console.log(`Loaded ${games.length} games.\n`);

  const header = 'days  rho    accuracy   Brier    logloss  |  >80% band: predicted vs actual (n)';
  console.log(header);
  console.log('-'.repeat(header.length));

  const combos: { periodDays: number; rho: number }[] = [];
  for (const periodDays of [1]) {
    for (const rho of [0, 0.2, 0.4, 0.6, 0.8, 0.95]) combos.push({ periodDays, rho });
  }

  for (const { periodDays, rho } of combos) {
    const result = runReplay({
      teamIds,
      leagueIds,
      games,
      decayEvents,
      config: {
        phiInitMax: PHI_INIT_MAX,
        sigmaDefault: 0.06,
        marginScale: 1e9, // MOV disabled, matching production
        movWeightCap: 1.5,
        metaWeight: META_WEIGHT,
        seriesCorrelation: rho,
        ratingPeriodDays: periodDays,
      },
    });
    const teamSnaps = buildSnapshotLookup(result.teamHistory, (r) => r.teamId);
    const leagueSnaps = buildSnapshotLookup(result.leagueHistory, (r) => r.leagueId);

    let correct = 0;
    let total = 0;
    let brier = 0;
    let logLoss = 0;
    let hiPredSum = 0;
    let hiWins = 0;
    let hiN = 0;

    for (const game of games as ReplayGame[]) {
      const period = periodBucket(game.datetimeUtc, periodDays);
      const t1 = snapshotBefore(teamSnaps.get(game.team1Id), period);
      const t2 = snapshotBefore(teamSnaps.get(game.team2Id), period);
      const l1 = snapshotBefore(leagueSnaps.get(game.team1LeagueId), period);
      const l2 = snapshotBefore(leagueSnaps.get(game.team2LeagueId), period);
      const c1 = combineContextualAndMeta({ mu: t1.mu, phi: t1.phi, sigma: 0.06 }, { mu: l1.mu, phi: l1.phi, sigma: 0.06 }, META_WEIGHT, PHI_INIT_MAX);
      const c2 = combineContextualAndMeta({ mu: t2.mu, phi: t2.phi, sigma: 0.06 }, { mu: l2.mu, phi: l2.phi, sigma: 0.06 }, META_WEIGHT, PHI_INIT_MAX);
      const p1 = E(c1.mu, c2.mu, Math.hypot(c1.phi, c2.phi));
      const won = game.winnerTeamId === game.team1Id ? 1 : 0;

      total += 1;
      if ((p1 >= 0.5 ? 1 : 0) === won) correct += 1;
      brier += (p1 - won) ** 2;
      logLoss += -(won * Math.log(Math.max(p1, 1e-12)) + (1 - won) * Math.log(Math.max(1 - p1, 1e-12)));

      const pConf = Math.max(p1, 1 - p1);
      if (pConf >= 0.8) {
        hiPredSum += pConf;
        hiWins += p1 >= 0.5 ? won : 1 - won;
        hiN += 1;
      }
    }

    // Final RD per team -- the thing that used to balloon when periods shortened.
    const lastPhiByTeam = new Map<string, number>();
    for (const snap of result.teamHistory) lastPhiByTeam.set(snap.teamId, snap.phi);
    const rds = [...lastPhiByTeam.values()].map((phi) => phi * GLICKO2_SCALE).sort((a, b) => a - b);
    const medianRd = rds.length ? rds[Math.floor(rds.length / 2)] : 0;

    const hiPred = hiN ? (100 * hiPredSum) / hiN : 0;
    const hiAct = hiN ? (100 * hiWins) / hiN : 0;
    console.log(
      `${String(periodDays).padStart(4)}  ${rho.toFixed(2)}   ${((100 * correct) / total).toFixed(2)}%    ${(brier / total).toFixed(4)}   ${(logLoss / total).toFixed(4)}   |  ` +
        `${hiPred.toFixed(1)}% vs ${hiAct.toFixed(1)}%  gap ${(hiPred - hiAct).toFixed(1)}pp  | medianRD ${medianRd.toFixed(0)}`,
    );
  }

  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
