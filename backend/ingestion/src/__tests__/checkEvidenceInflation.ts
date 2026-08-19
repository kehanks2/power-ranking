/**
 * Diagnostic for the overconfidence found in checkModelQuality.ts (says 90%,
 * wins 75%). Two suspects that inflate evidence per rating period and shrink phi
 * too fast: MOV weight saturating at its cap on ~every game, and Bo3/Bo5 games
 * counted as independent observations when they're one matchup on one day.
 */
import { createPool } from '../db.js';

const BACKTEST_MARGIN_SCALE = 15; // what manualBacktest.ts sweeps with
const MOV_CAP = 1.5;

function movWeight(goldDiff: number, seconds: number, marginScale: number): number {
  const minutes = seconds / 60;
  if (minutes <= 0) return 1;
  return Math.min(1 + Math.log(1 + Math.abs(goldDiff) / minutes / marginScale), MOV_CAP);
}

async function main() {
  const pool = createPool();

  const rows = await pool.query<{ team1_gold: number | null; team2_gold: number | null; gamelength_seconds: number | null }>(
    `SELECT team1_gold, team2_gold, gamelength_seconds FROM games`,
  );
  let atCap = 0;
  let usable = 0;
  let weightSum = 0;
  for (const r of rows.rows) {
    if (r.team1_gold === null || r.team2_gold === null || !r.gamelength_seconds) continue;
    usable += 1;
    const w = movWeight(r.team1_gold - r.team2_gold, r.gamelength_seconds, BACKTEST_MARGIN_SCALE);
    weightSum += w;
    if (w >= MOV_CAP - 1e-9) atCap += 1;
  }
  console.log('=== MOV weight distribution (backtest marginScale=15, cap=1.5) ===');
  console.log(`games with gold+length data: ${usable}/${rows.rows.length}`);
  console.log(`pinned at the 1.5 cap:       ${atCap} (${((100 * atCap) / usable).toFixed(1)}%)`);
  console.log(`mean weight:                 ${(weightSum / usable).toFixed(3)}`);
  console.log('(If ~everything is at the cap, MOV is not measuring dominance -- it is a flat 1.5x evidence multiplier.)');

  const seriesStats = await pool.query<{ games_per_series: string; n: string }>(`
    SELECT games_per_series::text, COUNT(*)::text AS n FROM (
      SELECT series_id, COUNT(*) AS games_per_series FROM games GROUP BY series_id
    ) s GROUP BY games_per_series ORDER BY games_per_series
  `);
  console.log('\n=== Games per series (Glicko-2 treats each as an INDEPENDENT observation) ===');
  let totalGames = 0;
  let totalSeries = 0;
  for (const r of seriesStats.rows) {
    const gps = Number(r.games_per_series);
    const n = Number(r.n);
    totalGames += gps * n;
    totalSeries += n;
    console.log(`${gps} game(s): ${n} series`);
  }
  const avg = totalGames / totalSeries;
  console.log(`\nmean games/series: ${avg.toFixed(2)}`);
  console.log(`=> evidence per matchup is inflated ~${avg.toFixed(2)}x vs treating a series as one observation,`);
  console.log(`   which shrinks phi by ~sqrt(${avg.toFixed(2)}) = ${Math.sqrt(avg).toFixed(2)}x too much -> overconfidence.`);

  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
