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

export type PlayerComponent =
  | 'kda' | 'goldShare' | 'damageShare' | 'killParticipation'
  | 'csMin' | 'goldDiff' | 'objControl' | 'dpm' | 'winRate';

// Weight on "did your team win," the box-score stats splitting the rest.
//
// 0.4, down from 0.5 (2026-08-16). This corrects a double-count rather than
// re-weighting the model's priorities. 0.5 was chosen when the box score was
// four uniform stats; v3 then added goldDiff and re-weighted kda, both of which
// are 0.8-0.9 correlated with winning, so outcome exposure rose without anyone
// choosing it -- measured as correlation with the player's own team win rate,
// 0.653 under the old model against 0.681 under v3. 0.4 measures 0.652, which
// is the original balance restored.
//
// Held-out accuracy cannot arbitrate the choice: it rises monotonically to a
// win weight of 1.0, the degenerate "rank players by their team's record". See
// MODEL.md.
export const DEFAULT_WIN_WEIGHT = 0.4;

/** Legacy uniform weights (winRate + four box stats). Kept for callers/tests without a role. */
export function componentWeights(winWeight = DEFAULT_WIN_WEIGHT): Partial<Record<PlayerComponent, number>> {
  const boxScoreShare = (1 - winWeight) / 4;
  return { kda: boxScoreShare, goldShare: boxScoreShare, damageShare: boxScoreShare, killParticipation: boxScoreShare, winRate: winWeight };
}

// Per-role component weights (each sums to 1). winRate is DEFAULT_WIN_WEIGHT;
// the rest is distributed over the stats that reflect each role's job -- jungle
// on objective control, top on lane gold-diff, support on kill participation,
// etc. The stats not listed for a role carry no weight there.
//
// The box-score terms are the 0.5-era figures scaled by 1.2, so lowering the win
// weight did not quietly re-tune the role balance alongside it, then by a
// further 2/3 to make room for dpm at 0.20 -- again preserving each role's
// internal balance, and leaving winRate untouched at 0.4.
//
// DPM earns 0.20 on two independent diagnostics that bracket it from both
// sides: face validity peaks there (the anchors are better placed than at any
// other setting) and collapses by 0.30, while transfer carry-over keeps
// improving past it. Neither could pick the value alone -- carry-over rises
// monotonically toward "rank players by damage", which would put every support
// last. See MODEL.md.
export const ROLE_COMPONENT_WEIGHTS: Record<string, Partial<Record<PlayerComponent, number>>> = {
  TOP: { winRate: 0.4, dpm: 0.2, goldDiff: 0.12, csMin: 0.072, goldShare: 0.064, damageShare: 0.056, kda: 0.048, killParticipation: 0.04 },
  JNG: { winRate: 0.4, dpm: 0.2, objControl: 0.104, killParticipation: 0.088, goldDiff: 0.072, kda: 0.056, csMin: 0.032, damageShare: 0.024, goldShare: 0.024 },
  MID: { winRate: 0.4, dpm: 0.2, damageShare: 0.096, goldDiff: 0.08, csMin: 0.072, killParticipation: 0.056, kda: 0.048, goldShare: 0.048 },
  BOT: { winRate: 0.4, dpm: 0.2, damageShare: 0.088, kda: 0.08, csMin: 0.072, goldShare: 0.064, goldDiff: 0.056, killParticipation: 0.04 },
  SUP: { winRate: 0.4, dpm: 0.2, killParticipation: 0.2, kda: 0.104, damageShare: 0.056, objControl: 0.04 },
};

/** Per-role weights, falling back to the legacy uniform set for an unknown role. */
export function componentWeightsForRole(role: string): Partial<Record<PlayerComponent, number>> {
  return ROLE_COMPONENT_WEIGHTS[role] ?? componentWeights();
}

/**
 * A role's weights restated at a different outcome weight: winRate becomes
 * `winWeight` and the box-score terms are rescaled to fill what is left, so the
 * role keeps its own internal balance and the set still sums to 1. Sweeping the
 * win weight needs this, since per-role weights hardcode winRate at 0.5.
 *
 * Returns the role's weights by identity when the weight is unchanged, so the
 * shipped path cannot drift by a rounding step.
 */
export function componentWeightsForRoleAtWinWeight(
  role: string,
  winWeight: number,
): Partial<Record<PlayerComponent, number>> {
  const base = componentWeightsForRole(role);
  if (winWeight === (base.winRate ?? 0)) return base;

  const rest = Object.entries(base).filter(([component]) => component !== 'winRate');
  const restTotal = rest.reduce((sum, [, weight]) => sum + (weight ?? 0), 0);
  const scale = restTotal === 0 ? 0 : (1 - winWeight) / restTotal;

  const rescaled: Partial<Record<PlayerComponent, number>> = { winRate: winWeight };
  for (const [component, weight] of rest) {
    rescaled[component as PlayerComponent] = (weight ?? 0) * scale;
  }
  return rescaled;
}

/** Blends already-percentiled (0-100) components into one composite; a component with no percentile is treated as neutral 50. */
export function blendComponentPercentiles(
  percentiles: Partial<Record<PlayerComponent, number>>,
  weights: Partial<Record<PlayerComponent, number>> = componentWeights(),
): number {
  let total = 0;
  for (const [component, weight] of Object.entries(weights)) {
    total += (percentiles[component as PlayerComponent] ?? NEUTRAL_SCORE) * (weight ?? 0);
  }
  return total;
}
