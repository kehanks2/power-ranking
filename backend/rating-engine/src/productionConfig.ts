/**
 * The tuned constants the shipped model runs on.
 *
 * Central because they used to be re-declared per file and drifted:
 * checkModelQuality claimed to mirror computeRatings while running metaWeight
 * 0.8 against a shipped 0.5, so every Brier figure it printed described a model
 * nobody ships. Sweep scripts may pass their own values; that is their job.
 */

// MOV weighting is effectively off (marginScale huge -> weight ~= 1 everywhere).
// Net-negative for accuracy in two independent backtests (60.08 vs 60.48%, then
// 64.12 vs 64.26%). Path kept intact (manualBacktest.ts) in case better
// calibration ever beats the no-op baseline.
export const MARGIN_SCALE = 1e9;
export const MOV_WEIGHT_CAP = 1.5;

/**
 * Weight on the league prior relative to a team's own record.
 *
 * From a joint 48-config grid (manualModelSweep) over metaWeight x
 * seriesCorrelation x internationalWeightMultiplier -- tuning these one at a
 * time is what left SERIES_CORRELATION stale for months. Judged on Brier, which
 * unlike accuracy cannot be improved by shading toward 50%.
 *
 * 0.5 is the grid minimum (Brier 0.2254) and cuts the >80%-confidence
 * overconfidence gap to 5.3pp from 6.7pp at 0.8. Per-league calibration prefers
 * a larger weight, but on only ~870 observations, and a bigger league term
 * matches per-league win rates almost mechanically -- the over-attribution to
 * region this weight exists to limit.
 */
export const META_WEIGHT = 0.5;

/**
 * Intra-series correlation (rho): games inside a Bo3/Bo5 are not independent, so
 * each carries weight 1/(1+(n-1)*rho) -- at 0.6 a 3-0 counts as 1.36 games.
 *
 * Higher rho improves overconfidence (>80% gap 5.3pp at 0.6 vs 6.9pp at 0) at
 * the cost of displayed RD (median 95 vs 79). A real trade, taken because the
 * model is still overconfident: narrowing RD would make probabilities worse.
 */
export const SERIES_CORRELATION = 0.6;

/**
 * Daily. A free knob since drift became a function of elapsed TIME rather than
 * period count (see updateRating's elapsedPeriods) -- median RD is now flat
 * across 1/3/7/14-day periods, and daily wins every other metric.
 *
 * Daily also matters during international events, where a team plays several
 * series in a week and weekly buckets graded all of them against a rating that
 * ignored the earlier ones.
 */
export const RATING_PERIOD_DAYS = 1;

/**
 * International games count double in the CONTEXTUAL update. They are the only
 * ones carrying cross-region information and there are ~10x fewer of them (about
 * 500 of 5,929), so at equal weight a team's regional schedule outvotes them:
 * Bilibili Gaming won First Stand 2026 yet ranked four places below T1. At 2x
 * they sit adjacent.
 *
 * 2 rather than higher on purpose. manualLeagueCalibration keeps improving as
 * this rises, but it is measured ON international games, so up-weighting them
 * fits it almost by construction. Overall accuracy peaks near 3x and falls by
 * 4x, with 1x-3x inside noise (~8 games).
 */
export const INTERNATIONAL_WEIGHT_MULTIPLIER = 2;
