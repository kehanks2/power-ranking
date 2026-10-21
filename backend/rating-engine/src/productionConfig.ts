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
 * Weight on the league term in a cross-region comparison. Owner's choice
 * (2026-10-20) over the Brier optimum of 0.5: cross-region Brier 0.2213 vs
 * 0.2157, 1.9 SE on 300 games, and 0.5 ranks mid-table LCK teams above LYON.
 * Score both on Worlds 26's main stage before revisiting (MODEL.md).
 */
export const META_WEIGHT = 0.2;

/** Cross-region games at which a team's league term counts half: weight x h / (h + games). */
export const LEAGUE_TERM_HALF_LIFE_GAMES = 30;

/**
 * Prior RD (display points) of a team's own international deviation, the term
 * only cross-region games move. Its variance relaxes back to this, and its mean
 * to 0, over TEAM_INTERNATIONAL_HALF_LIFE_DAYS.
 */
export const TEAM_INTERNATIONAL_RD = 75;
export const TEAM_INTERNATIONAL_HALF_LIFE_DAYS = 365;

/** Weight of a play-in game relative to any other international game. Owner's ruling (2026-10-20). */
export const PLAY_IN_WEIGHT = 0.25;

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
 * Weight of a cross-region game in the league and international-deviation
 * updates. Contextual no longer sees these games. 3x and 4x left the per-team
 * cross-region error unchanged (manualGlobalBoardWeightSweep, 2026-10-20).
 */
export const INTERNATIONAL_WEIGHT_MULTIPLIER = 2;

// Games an incoming player must play before their rating is trusted in full.
// Shared because two places need the same number: the replay, which weights a
// new player's carryover by it, and the board, which flags a team whose rating
// has not settled yet. Restating it in the API let the flag drift from the
// model it is describing.
export const ROSTER_CHANGE_MIN_GAMES = 10;

// A replaced starter who returns within this many days was covered by a
// substitute, not replaced: both roster-change events are dropped. Owner's
// ruling (2026-10-20). 66 stints produced 132 of 581 events, LYON's three-week
// jungle sub among them.
export const SUBSTITUTE_RETURN_DAYS = 60;
