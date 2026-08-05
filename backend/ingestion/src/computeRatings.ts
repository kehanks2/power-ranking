import type { Pool } from 'pg';
import { runReplay, GLICKO2_SCALE, DEFAULT_VOLATILITY, type ReplayInput } from '@power-ranking/rating-engine';
import { loadReplayData } from './replayData.js';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
// MOV weighting is effectively disabled (marginScale set huge -> weight ~= 1
// for every game). Confirmed net-negative for predictive accuracy across two
// independent backtests (60.08% vs 60.48%, then 64.12% vs 64.26% with the
// fuller dataset) -- the plan's own caveat was "don't trust this enabled by
// construction," and it's now been checked twice, not once. The code path
// stays intact (see manualBacktest.ts) in case better calibration ever beats
// the no-op baseline.
const MARGIN_SCALE = 1e9;
const MOV_WEIGHT_CAP = 1.5;
// Empirically the best performer in a metaWeight sweep (backtest accuracy
// 64.12% at 0.8 vs 64.08% at 1.0, and both meaningfully ahead of low values)
// -- also directly addresses real feedback that an unweighted sum let a
// region's meta swing dominate individual team merit (a weak team in a
// strong region outranking a team that just beat top opponents in a weaker
// one). Re-sweep via manualBacktest.ts after any substantial data changes.
// Backtest-tuned. Exists at all because an unweighted sum let a region's meta
// dominate individual team merit -- a weak team in a strong region outranking a
// team that had just beaten top opponents in a weaker one.
//
// Briefly lowered to 0.65, which measured better at the time. That turned out
// to be compensating for a real bug rather than a genuine optimum: international
// games graded each side's bare contextual against the opponent's contextual +
// meta, so both teams were underdogs in the same game and the meta term was
// effectively over-applied. With that asymmetry fixed (see GameResult's
// ownExpectancyMu) the optimum moved back here: calibration weighted mean
// absolute gap is 3.47pp at 0.80 versus 3.83pp at 0.65.
//
// Do NOT tune this by intuition -- re-sweep manualBacktest and
// manualLeagueCalibration after substantial data changes, and keep this value
// identical in computeRatings.ts and repositories.ts or displayed ratings stop
// matching what the replay computed.
const META_WEIGHT = 0.8;
// Intra-series correlation (rho) -- see seriesEvidenceWeight in replay.ts.
// Games inside a Bo3/Bo5 are not independent observations, so each carries
// weight 1/(1+(n-1)*rho). At 0.4 a 3-0 counts as 1.67 games rather than 3.
//
// Was 0.8, chosen when down-weighting correlated evidence measurably fixed
// overconfidence (the >80% confidence band predicted ~86% and delivered ~77%,
// a gap rho=0.8 closed from ~8.6pp to ~7.1pp). That is no longer what the data
// says. After the offseason-drift, roster-prior-confidence, symmetric
// international expectancy and cross-region weighting fixes, calibration is
// FLAT across the whole rho range -- Brier 0.2253-0.2259, log loss
// 0.6430-0.6448, high-confidence gap 5.8-6.9pp, all inside noise -- while
// median displayed RD swings from 80 (rho=0) to 103 (rho=0.95).
//
// So 0.8 was buying 20 points of extra uncertainty on every team for no
// calibration benefit, and slightly worse accuracy (63.18% vs 63.45%). 0.4 is
// the measured optimum on Brier, log loss AND the high-confidence gap, keeps a
// real statistically-motivated correction rather than pretending series games
// are independent, and tightens the board. Re-check with
// manualSeriesCorrelationSweep after substantial data changes -- this value is
// contingent on the rest of the model being right, as its own history shows.
const SERIES_CORRELATION = 0.4;
// Daily. Rating periods are now a genuinely free knob: drift is scaled by
// elapsed TIME (see updateRating's elapsedPeriods), so total uncertainty
// growth over any span no longer depends on how finely that span is sliced.
// Before that fix, shortening periods silently multiplied drift -- daily
// pushed median RD to ~125 vs ~105 weekly. Now median RD is flat across
// 1/3/7/14-day periods (114/115/118/113), and daily wins on every other
// metric (Brier 0.2262 vs 0.2266, high-confidence gap 6.7pp vs 7.1pp).
// Daily also matters for correctness during international events, where a
// team can play several series in one week -- weekly buckets graded all of
// them against a rating that ignored the earlier ones.
const RATING_PERIOD_DAYS = 1;
// International games count double in the CONTEXTUAL update. Regional games can
// only move a team within its own league; international games are the only ones
// carrying cross-region information, and there are roughly ten times fewer of
// them (about 500 of 5,929 games here), so at equal weight a team's regional
// schedule simply outvotes them.
//
// The motivating case: Bilibili Gaming went 3-2 against T1 and 5-4 against
// Hanwha Life in 2026 international play and won First Stand outright, yet
// ranked 103 points and four places below T1, because ~200 LPL regional games
// outweighed ~100 international ones. At 2x, BLG and T1 sit adjacent.
//
// Chosen at 2 rather than higher on purpose. manualLeagueCalibration keeps
// improving as this rises (3.47pp at 1x, 2.71pp at 5x) but that metric is
// measured ON international games, so up-weighting them fits it better almost
// by construction -- it is not a clean selection criterion for this knob.
// Overall accuracy, which is dominated by the ~5,400 regional games, peaks
// around 3x and falls by 4x, and the differences across 1x-3x are inside noise
// (~0.13pp, about 8 games). 2x takes the defensible middle: enough to stop
// regional volume drowning cross-region evidence, not enough to overfit the
// handful of international events.
const INTERNATIONAL_WEIGHT_MULTIPLIER = 2;

/**
 * Loads all data needed for a full replay from Postgres (via loadReplayData),
 * runs the pure rating-engine replay, and persists the resulting history.
 * Safe to re-run from scratch at any time -- see plan's "full replay is
 * always the supported recovery path."
 *
 * Must run AFTER computePlayerRatings (player_ratings_history feeds the
 * roster-decay prior) -- see manualRecompute.ts for the pipeline order.
 */
export async function computeRatings(pool: Pool): Promise<{ teamRows: number; leagueRows: number }> {
  const { teamIds, leagueIds, games, decayEvents } = await loadReplayData(pool);

  const replayInput: ReplayInput = {
    teamIds,
    leagueIds,
    games,
    decayEvents,
    config: {
      phiInitMax: PHI_INIT_MAX,
      sigmaDefault: DEFAULT_VOLATILITY,
      marginScale: MARGIN_SCALE,
      movWeightCap: MOV_WEIGHT_CAP,
      metaWeight: META_WEIGHT,
      seriesCorrelation: SERIES_CORRELATION,
      ratingPeriodDays: RATING_PERIOD_DAYS,
      internationalWeightMultiplier: INTERNATIONAL_WEIGHT_MULTIPLIER,
    },
  };

  const result = runReplay(replayInput);

  // A real bug lived here: pool.query('BEGIN')/'COMMIT' issue each statement
  // through whatever connection the pool happens to hand back, which is NOT
  // guaranteed to be the same connection across calls -- so this was never
  // actually one atomic transaction. Under any concurrent pool usage (e.g.
  // running the test suite), the DELETEs could commit on one connection while
  // INSERTs landed on another (or failed silently), leaving the ratings
  // tables wiped with no replacement rows -- confirmed in practice: every
  // team fell back to cold-start display values after a test run. Fixed by
  // pinning the whole transaction to one dedicated client via pool.connect().
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM team_ratings_history');
    await client.query('DELETE FROM league_ratings_history');

    for (const snapshot of result.teamHistory) {
      await client.query(
        `INSERT INTO team_ratings_history (team_id, as_of_date, mu_ctx, phi_ctx, sigma_ctx, reason, roster_implied_mu, method_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
        [
          Number(snapshot.teamId),
          snapshot.asOfDate,
          snapshot.mu,
          snapshot.phi,
          snapshot.sigma,
          snapshot.reason,
          snapshot.rosterImpliedMu ?? null,
        ],
      );
    }
    for (const snapshot of result.leagueHistory) {
      await client.query(
        `INSERT INTO league_ratings_history (league_id, as_of_date, mu_meta, phi_meta, sigma_meta, method_version)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [Number(snapshot.leagueId), snapshot.asOfDate, snapshot.mu, snapshot.phi, snapshot.sigma],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return { teamRows: result.teamHistory.length, leagueRows: result.leagueHistory.length };
}
