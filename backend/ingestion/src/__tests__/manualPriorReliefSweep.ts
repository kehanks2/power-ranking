/**
 * Manual read-only sweep of DEFAULT_PRIOR_CONFIDENCE_RELIEF: how much a
 * confident roster-implied prior should damp the RD widening a roster change
 * causes. 0 = old behaviour (RD resets toward phiInitMax on turnover alone);
 * 1 = a fully-known incoming five widens RD not at all. Reports the RD spread,
 * since the complaint was about implausibly wide displayed +/-.
 */
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import {
  runReplay,
  GLICKO2_SCALE,
  DEFAULT_VOLATILITY,
  MARGIN_SCALE,
  MOV_WEIGHT_CAP,
  META_WEIGHT,
  SERIES_CORRELATION,
  RATING_PERIOD_DAYS,
  INTERNATIONAL_WEIGHT_MULTIPLIER,
  type ReplayInput,
} from '@power-ranking/rating-engine';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
const RELIEFS = [0, 0.3, 0.6, 0.8, 1.0];

const pool = createPool();
const { teamIds, leagueIds, games, decayEvents } = await loadReplayData(pool);
console.log(`${games.length} games, ${decayEvents.length} decay events\n`);

const sortedGames = [...games].sort((a, b) => (a.datetimeUtc < b.datetimeUtc ? -1 : 1));

// Accuracy is manualBacktest.ts's job; this sweep answers only the display
// question: how wide is the resulting +/- spread?
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
      // Imported, not restated, so the sweep runs on the shipped config.
      marginScale: MARGIN_SCALE,
      movWeightCap: MOV_WEIGHT_CAP,
      metaWeight: META_WEIGHT,
      seriesCorrelation: SERIES_CORRELATION,
      ratingPeriodDays: RATING_PERIOD_DAYS,
      internationalWeightMultiplier: INTERNATIONAL_WEIGHT_MULTIPLIER,
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
