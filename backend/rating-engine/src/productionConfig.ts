/**
 * The tuned constants the shipped model actually runs on.
 *
 * They live here, in the package both the ingestion pipeline and the read API
 * depend on, because they were previously re-declared in every file that
 * needed them and the copies drifted. checkModelQuality.ts carried a comment
 * saying it was "kept in lockstep with computeRatings.ts" while running
 * metaWeight 0.8 against a shipped 0.5 -- so the standing quality diagnostic
 * was measuring a model nobody ships, and every Brier figure it printed
 * described a hypothetical.
 *
 * A sweep script is free to pass its own values; that is its job. What must
 * not happen again is a file believing it mirrors production and being wrong.
 */

// MOV weighting is effectively disabled (marginScale set huge -> weight ~= 1
// for every game). Confirmed net-negative for predictive accuracy across two
// independent backtests (60.08% vs 60.48%, then 64.12% vs 64.26% with the
// fuller dataset) -- the plan's own caveat was "don't trust this enabled by
// construction," and it's now been checked twice, not once. The code path
// stays intact (see manualBacktest.ts) in case better calibration ever beats
// the no-op baseline.
export const MARGIN_SCALE = 1e9;
export const MOV_WEIGHT_CAP = 1.5;

/**
 * Weight on the league prior relative to a team's own record.
 *
 * Chosen by a joint 48-config grid (manualModelSweep) sweeping metaWeight x
 * seriesCorrelation x internationalWeightMultiplier together, because tuning
 * these one at a time is what left SERIES_CORRELATION stale for months.
 * Primary criterion is Brier -- a strictly proper scoring rule, so unlike
 * accuracy it cannot be improved by shading probabilities toward 50%.
 *
 * At 0.5: Brier 0.2254 and log loss 0.6434, both the grid minimum; the
 * >80%-confidence overconfidence gap falls to 5.3pp from 6.7pp at 0.8; and the
 * displayed league spread drops to 1.20x the Bradley-Terry fit from 1.45x.
 * Accuracy is 63.60% against a grid range of 60-64%, i.e. unchanged.
 *
 * One metric disagrees: per-league calibration on cross-league games prefers a
 * LARGER weight (2.93pp at 0.8 vs 3.96pp at 0.5). It is the weaker measure --
 * only ~870 observations, and a bigger league term matches aggregate per-league
 * win rates almost mechanically, which is the very over-attribution to region
 * this weight exists to limit.
 */
export const META_WEIGHT = 0.5;

/**
 * Intra-series correlation (rho): games inside a Bo3/Bo5 are not independent
 * observations, so each carries weight 1/(1+(n-1)*rho). At 0.6 a 3-0 counts as
 * 1.36 games rather than 3.
 *
 * From the same joint grid. Higher rho consistently improves the proper scoring
 * rules and, more importantly, overconfidence: the >80% band gap is 5.3pp at
 * 0.6 against 6.9pp at 0. It costs displayed RD (median contextual RD 95 at 0.6
 * vs 79 at 0), which is a real trade -- the model is still overconfident, so
 * narrowing RD further would make its probabilities worse, not better.
 */
export const SERIES_CORRELATION = 0.6;

/**
 * Daily. Rating periods are now a genuinely free knob: drift is scaled by
 * elapsed TIME (see updateRating's elapsedPeriods), so total uncertainty
 * growth over any span no longer depends on how finely that span is sliced.
 * Before that fix, shortening periods silently multiplied drift -- daily
 * pushed median RD to ~125 vs ~105 weekly. Now median RD is flat across
 * 1/3/7/14-day periods (114/115/118/113), and daily wins on every other
 * metric (Brier 0.2262 vs 0.2266, high-confidence gap 6.7pp vs 7.1pp).
 * Daily also matters for correctness during international events, where a
 * team can play several series in one week -- weekly buckets graded all of
 * them against a rating that ignored the earlier ones.
 */
export const RATING_PERIOD_DAYS = 1;

/**
 * International games count double in the CONTEXTUAL update. Regional games can
 * only move a team within its own league; international games are the only ones
 * carrying cross-region information, and there are roughly ten times fewer of
 * them (about 500 of 5,929 games here), so at equal weight a team's regional
 * schedule simply outvotes them.
 *
 * The motivating case: Bilibili Gaming went 3-2 against T1 and 5-4 against
 * Hanwha Life in 2026 international play and won First Stand outright, yet
 * ranked 103 points and four places below T1, because ~200 LPL regional games
 * outweighed ~100 international ones. At 2x, BLG and T1 sit adjacent.
 *
 * Chosen at 2 rather than higher on purpose. manualLeagueCalibration keeps
 * improving as this rises (3.47pp at 1x, 2.71pp at 5x) but that metric is
 * measured ON international games, so up-weighting them fits it better almost
 * by construction -- it is not a clean selection criterion for this knob.
 * Overall accuracy, which is dominated by the ~5,400 regional games, peaks
 * around 3x and falls by 4x, and the differences across 1x-3x are inside noise
 * (~0.13pp, about 8 games). 2x takes the defensible middle: enough to stop
 * regional volume drowning cross-region evidence, not enough to overfit the
 * handful of international events.
 */
export const INTERNATIONAL_WEIGHT_MULTIPLIER = 2;
