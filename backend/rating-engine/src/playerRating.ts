/**
 * Simple Phase-1 player rating: a role+league-normalized percentile composite
 * per game, rolled up via an exponentially-weighted moving average.
 *
 * Deliberately not a trained ML model or a full Bayesian (OpenSkill) engine --
 * see plan's "Player rating (Phase 1, simple version)" for why, and the known
 * limitation that percentiles are computed within-league only (a transfer's
 * percentile doesn't yet translate cross-league).
 */

export interface PlayerGameStats {
  kda: number;
  /** This player's share of their team's total gold in the game, 0-1. */
  goldShare: number;
  /** This player's share of their team's total damage to champions, 0-1. */
  damageShare: number;
  /** Fraction of team kills this player was involved in, 0-1. */
  killParticipation: number;
}

/** Percentile of `value` within `peerValues` (same role, same league, same period), 0-100. */
export function percentile(value: number, peerValues: number[]): number {
  if (peerValues.length === 0) return 50;
  const countBelow = peerValues.filter((v) => v < value).length;
  return (countBelow / peerValues.length) * 100;
}

/**
 * Averages percentiles across the four stats into a single 0-100 composite.
 * `peers` should be every player in the same role + league for this game/period
 * (i.e. not global -- see the plan's within-league-only decision).
 */
export function computeCompositeScore(stats: PlayerGameStats, peers: PlayerGameStats[]): number {
  const kdaPercentile = percentile(stats.kda, peers.map((p) => p.kda));
  const goldPercentile = percentile(stats.goldShare, peers.map((p) => p.goldShare));
  const damagePercentile = percentile(stats.damageShare, peers.map((p) => p.damageShare));
  const kpPercentile = percentile(stats.killParticipation, peers.map((p) => p.killParticipation));
  return (kdaPercentile + goldPercentile + damagePercentile + kpPercentile) / 4;
}

/**
 * Exponentially-weighted rolling average -- "current form." The first game
 * has no prior to blend against, so it seeds the rating directly.
 */
export function updatePlayerRating(
  currentRating: number | null,
  newCompositeScore: number,
  alpha = 0.2,
): number {
  if (currentRating === null) return newCompositeScore;
  return alpha * newCompositeScore + (1 - alpha) * currentRating;
}

// --- Weighted season rating (method_version 2) -------------------------------
//
// v1 was a flat career average of four stats, percentiled within (league,
// role). Confirmed against real data that this had four distinct failures:
//   1. It emitted one row per (player, role, league), so anyone who changed
//      role or league got 2-3 rows all stamped with the same as_of_date, and
//      every consumer picks between them with `DISTINCT ON ... ORDER BY
//      as_of_date DESC` -- i.e. arbitrarily. Malrang scored 20.8 / 58.0 / 42.4
//      depending on which row won the tie; 61 players were affected.
//   2. `games_played` was stored but never used, so a 1-game sample could
//      score 88.6 alongside a 40-game veteran (24 players had <=3 games).
//   3. A flat average over 2.5 years made current form invisible.
//   4. Winning was not an input at all -- farm/damage/KDA only, which is a
//      stat-padding metric and the likely reason the top 10 was four supports
//      and no Faker or Chovy.
// The functions below address 2, 3 and 4; the one-row-per-player selection is
// done by the caller (see computePlayerRatings.ts) using `effectiveGames` to
// pick a player's primary peer group.

/**
 * A game this many days old counts half as much as one played today. ~120d is
 * roughly one split, so the current split dominates while prior splits still
 * carry real signal instead of dropping off a cliff at a window boundary.
 */
export const DEFAULT_HALF_LIFE_DAYS = 120;

/**
 * Games needed before a rating is trusted at full strength. At n_eff = K the
 * score sits halfway between the peer-neutral 50 and its raw value, so a
 * 1-game 88.6 lands near 53 rather than topping the table.
 */
export const DEFAULT_SHRINKAGE_GAMES = 10;

/** Recency weight for a game played `ageDays` ago. 1.0 today, 0.5 at one half-life. */
export function recencyWeight(ageDays: number, halfLifeDays = DEFAULT_HALF_LIFE_DAYS): number {
  if (halfLifeDays <= 0) return 1;
  return Math.pow(0.5, Math.max(ageDays, 0) / halfLifeDays);
}

/** Mean of `values` weighted by `weights`; 0 when the weights sum to nothing. */
export function weightedMean(values: number[], weights: number[]): number {
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < values.length; i += 1) {
    weightedSum += values[i] * weights[i];
    weightTotal += weights[i];
  }
  return weightTotal > 0 ? weightedSum / weightTotal : 0;
}

/** The peer-neutral score: by construction every peer group centres here. */
export const NEUTRAL_SCORE = 50;

/**
 * How much of a player's standing in one league carries to another.
 *
 * Fit from our own data, not assumed: across 100 observations of players with
 * 15+ games in two different leagues at the same role, regressing one
 * percentile on the other gives a slope of 0.315 (r^2 = 0.099). So past-league
 * standing is real evidence but weak -- worth about a third of the distance
 * from neutral, and no more.
 *
 * Deliberately NOT adjusted by league strength. The obvious theory is that
 * moving to a stronger league should cost you percentile, but the correlation
 * between the league-rating gap and the percentile change is -0.19 -- weak,
 * and pointing the WRONG way. Applying a strength term would be adding noise
 * with a rigorous-looking justification. See MODEL.md.
 */
export const DEFAULT_TRANSFER_CARRYOVER = 0.3;

/**
 * Pulls a percentile score toward `anchor` in proportion to how little
 * evidence backs it. `effectiveGames` is the recency-weighted game count, so
 * an old sample shrinks harder than a fresh one of the same size -- which is
 * the intended interaction with `recencyWeight`, not a side effect.
 */
export function shrinkToward(
  score: number,
  effectiveGames: number,
  anchor = NEUTRAL_SCORE,
  k = DEFAULT_SHRINKAGE_GAMES,
): number {
  const confidence = effectiveGames / (effectiveGames + k);
  return anchor + (score - anchor) * confidence;
}

/** Shrinks toward the peer-neutral 50 -- the case where nothing else is known. */
export function shrinkToNeutral(score: number, effectiveGames: number, k = DEFAULT_SHRINKAGE_GAMES): number {
  return shrinkToward(score, effectiveGames, NEUTRAL_SCORE, k);
}

/**
 * Where to anchor a player who has a record in another league.
 *
 * Returns the neutral score when there is nothing to carry, so a caller can
 * use this unconditionally. Note the result is an ANCHOR, not a rating: the
 * player's own games in this league still pull the final number away from it
 * exactly as before, and do so faster the more they play.
 */
export function transferAnchor(
  priorScore: number | null | undefined,
  carryover = DEFAULT_TRANSFER_CARRYOVER,
): number {
  if (priorScore === null || priorScore === undefined) return NEUTRAL_SCORE;
  return NEUTRAL_SCORE + (priorScore - NEUTRAL_SCORE) * carryover;
}

export type PlayerComponent = 'kda' | 'goldShare' | 'damageShare' | 'killParticipation' | 'winRate';

/**
 * How much of the composite is "did your team actually win," with the four
 * box-score stats splitting the remainder equally.
 *
 * Set to 0.5 deliberately. A player can make a play that wrecks their own
 * stat line -- a dive that trades their life for the objective, a support
 * engaging into four people -- and the team wins because of it. The box score
 * records that as a death; the scoreboard records it as a win. Weighting
 * winRate at half the composite means the outcome can outvote the stat line
 * rather than merely nudging it, which is the whole point: the play worked.
 *
 * It stops at 0.5 rather than going higher because winRate is a TEAM
 * statistic. Every player on a strong roster shares it, so past ~0.5 the
 * rating stops discriminating between teammates and just re-ranks teams --
 * you'd be reading team strength off a player page. At 0.5 a player still has
 * to be individually credible to top their peer group.
 */
export const DEFAULT_WIN_WEIGHT = 0.5;

/** Component weights summing to 1, given how much weight winning should carry. */
export function componentWeights(winWeight = DEFAULT_WIN_WEIGHT): Record<PlayerComponent, number> {
  const boxScoreShare = (1 - winWeight) / 4;
  return {
    kda: boxScoreShare,
    goldShare: boxScoreShare,
    damageShare: boxScoreShare,
    killParticipation: boxScoreShare,
    winRate: winWeight,
  };
}

/** Blends already-percentiled (0-100) components into one composite. */
export function blendComponentPercentiles(
  percentiles: Record<PlayerComponent, number>,
  weights: Record<PlayerComponent, number> = componentWeights(),
): number {
  let total = 0;
  for (const [component, weight] of Object.entries(weights)) {
    total += percentiles[component as PlayerComponent] * weight;
  }
  return total;
}
