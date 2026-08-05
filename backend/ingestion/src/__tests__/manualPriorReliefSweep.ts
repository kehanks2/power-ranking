/**
 * Manual one-off runner (read-only): sweep DEFAULT_PRIOR_CONFIDENCE_RELIEF.
 *
 * How much should a confident roster-implied prior damp the RD widening a
 * roster change causes? 0 reproduces the old behaviour (RD resets toward
 * phiInitMax on turnover alone, ignoring that we know who joined); 1 would let
 * a fully-known incoming five widen RD not at all.
 *
 * Reports both predictive accuracy AND the resulting RD spread, because the
 * motivating complaint was about displayed +/- being implausibly wide, not
 * about accuracy. Run with tsx.
 */
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import { runReplay, GLICKO2_SCALE, DEFAULT_VOLATILITY, type ReplayInput } from '@power-ranking/rating-engine';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
const RELIEFS = [0, 0.3, 0.5, 0.6, 0.75, 0.9];

const pool = createPool(DATABASE_URL);
const { teamIds, leagueIds, games, decayEvents } = await loadReplayData(pool);
console.log(`${games.length} games, ${decayEvents.length} decay events\n`);

const sortedGames = [...games].sort((a, b) => (a.datetimeUtc < b.datetimeUtc ? -1 : 1));

// Accuracy is NOT measured here -- manualBacktest.ts owns that, with a
// proper no-leakage walk-forward. This sweep answers the display question:
// how wide is the resulting +/- spread?
console.log('relief   medianRD  p90RD  maxRD');
for (const relief of RELIEFS) {
  const input: ReplayInput = {
    teamIds,
    leagueIds,
    games: sortedGames,
    decayEvents,
    config: {
      phiInitMax: PHI_INIT_MAX,
      sigmaDefault: DEFAULT_VOLATILITY,
      marginScale: 1e9,
      movWeightCap: 1.5,
      metaWeight: 0.8,
      seriesCorrelation: 0.8,
      ratingPeriodDays: 1,
      priorConfidenceRelief: relief,
    },
  };
  const result = runReplay(input);

  // Latest contextual phi per team, in display points.
  const latestPhi = new Map<string, number>();
  for (const snapshot of result.teamHistory) latestPhi.set(snapshot.teamId, snapshot.phi * GLICKO2_SCALE);
  const rds = [...latestPhi.values()].sort((a, b) => a - b);
  const at = (q: number) => rds[Math.min(rds.length - 1, Math.floor(rds.length * q))];

  console.log(
    `${relief.toFixed(2).padStart(5)}   ${at(0.5).toFixed(0).padStart(7)}  ${at(0.9).toFixed(0).padStart(5)}  ${rds[rds.length - 1].toFixed(0).padStart(5)}`,
  );
}

await pool.end();
