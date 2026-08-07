/**
 * Player rating: a role+league-normalized percentile composite per game, rolled
 * up via an exponentially-weighted moving average. Percentiles are within-league
 * only, so a transfer's percentile doesn't translate cross-league.
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

/** Averages the four stat percentiles into a 0-100 composite. `peers` = same role + league. */
export function computeCompositeScore(stats: PlayerGameStats, peers: PlayerGameStats[]): number {
  const kdaPercentile = percentile(stats.kda, peers.map((p) => p.kda));
  const goldPercentile = percentile(stats.goldShare, peers.map((p) => p.goldShare));
  const damagePercentile = percentile(stats.damageShare, peers.map((p) => p.damageShare));
  const kpPercentile = percentile(stats.killParticipation, peers.map((p) => p.killParticipation));
  return (kdaPercentile + goldPercentile + damagePercentile + kpPercentile) / 4;
}

/** EWMA "current form"; the first game has no prior, so it seeds the rating. */
export function updatePlayerRating(
  currentRating: number | null,
  newCompositeScore: number,
  alpha = 0.2,
): number {
  if (currentRating === null) return newCompositeScore;
  return alpha * newCompositeScore + (1 - alpha) * currentRating;
}

// --- Weighted season rating (method_version 2) -------------------------------
// v2 adds recency weighting, sample-size shrinkage, and a win term to v1's flat
// career percentile average.

// Half-weight age. ~120d ≈ one split, so the current split dominates without a
// cliff at a window boundary.
export const DEFAULT_HALF_LIFE_DAYS = 120;

// Games before a rating is trusted fully. At n_eff = K the score sits halfway
// between neutral 50 and its raw value, so a 1-game 88.6 lands near 53.
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

// How much of a player's standing in one league carries to another. Fit, not
// assumed: cross-league percentile slope 0.315 over 100 players, ~a third of the
// distance from neutral. NOT adjusted by league strength (that correlation is
// -0.19: weak and wrong-signed).
export const DEFAULT_TRANSFER_CARRYOVER = 0.3;

/**
 * Pulls a score toward `anchor` in proportion to how little evidence backs it.
 * `effectiveGames` is recency-weighted, so an old sample shrinks harder.
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
 * Where to anchor a player with a record in another league; neutral when there's
 * nothing to carry. An anchor, not a rating -- their own games still pull off it.
 */
export function transferAnchor(
  priorScore: number | null | undefined,
  carryover = DEFAULT_TRANSFER_CARRYOVER,
): number {
  if (priorScore === null || priorScore === undefined) return NEUTRAL_SCORE;
  return NEUTRAL_SCORE + (priorScore - NEUTRAL_SCORE) * carryover;
}

export type PlayerComponent = 'kda' | 'goldShare' | 'damageShare' | 'killParticipation' | 'winRate';

// Weight on "did your team win," the four box-score stats splitting the rest.
// 0.5 so the outcome can outvote a stat line (a support engaging into four reads
// as a death but wins the game); no higher, or winRate (a team stat) just
// re-ranks teams.
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
