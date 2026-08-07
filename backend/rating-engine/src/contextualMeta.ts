/**
 * Additive contextual + meta rating:
 *
 *   team_displayed = team_contextual + effectiveMetaWeight * league_meta
 *
 * Contextual updates from intra-league games; league meta from international
 * games (delta lands only on meta). metaWeight keeps the region term from
 * dominating team merit; effectiveMetaWeight shrinks it further by the meta's
 * own confidence.
 */

import { g, E, solveNewVolatility, DEFAULT_TAU, DEFAULT_VOLATILITY, GLICKO2_SCALE, fromGlicko2Scale, type RatingState, type DisplayRating } from './glicko2.js';

export const DEFAULT_META_WEIGHT = 1.0;

/**
 * Shrinks metaWeight by the meta's confidence: 0 at max uncertainty, metaWeight
 * at phi_meta=0. phiInitMax=undefined skips shrinkage (flat metaWeight).
 */
export function effectiveMetaWeight(meta: RatingState, metaWeight: number, phiInitMax?: number): number {
  if (phiInitMax === undefined || phiInitMax <= 0) return metaWeight;
  const confidence = 1 - Math.min(1, meta.phi / phiInitMax);
  return metaWeight * Math.max(0, confidence);
}

// A second shrinkage keyed on whether THIS team has played internationally
// lately (effectiveMetaWeight keys on the league's shared meta confidence).
// Full credit within six months, so it lapses only if a team misses the next
// international cycle (First Stand -> MSI -> Worlds).
export const META_PARTICIPATION_FULL_CREDIT_DAYS = 182;
export const META_PARTICIPATION_ZERO_CREDIT_DAYS = 730;
// Never zero -- a team too new to have played still gets some regional credit.
export const META_PARTICIPATION_FLOOR = 0.3;

/** 1.0 within full-credit days, decaying linearly to the floor by zero-credit days. */
export function internationalParticipationFactor(daysSinceLastInternational: number | null): number {
  if (daysSinceLastInternational === null) return META_PARTICIPATION_FLOOR;
  if (daysSinceLastInternational <= META_PARTICIPATION_FULL_CREDIT_DAYS) return 1;
  if (daysSinceLastInternational >= META_PARTICIPATION_ZERO_CREDIT_DAYS) return META_PARTICIPATION_FLOOR;
  const span = META_PARTICIPATION_ZERO_CREDIT_DAYS - META_PARTICIPATION_FULL_CREDIT_DAYS;
  const progress = (daysSinceLastInternational - META_PARTICIPATION_FULL_CREDIT_DAYS) / span;
  return 1 - progress * (1 - META_PARTICIPATION_FLOOR);
}

/** International games at which a team's own record replaces half the league prior. */
export const META_EVIDENCE_HALF_LIFE_GAMES = 30;

/**
 * NOT USED IN PRODUCTION -- tested and rejected (it worsened calibration, since a
 * contextual rating is still mostly earned in regional games), kept because
 * manualLeagueCalibration.ts scores it as one mode.
 */
export function internationalEvidenceShrink(
  internationalGames: number,
  halfLifeGames = META_EVIDENCE_HALF_LIFE_GAMES,
): number {
  if (halfLifeGames <= 0) return 0;
  const games = Math.max(0, internationalGames);
  return halfLifeGames / (halfLifeGames + games);
}

export interface InternationalGameResult {
  /** The team's own contextual mu (internal scale) at the time of this game. */
  ownContextualMu: number;
  /** Opponent's combined (contextual + meta) mu, internal scale. */
  opponentCombinedMu: number;
  /** Opponent's combined (contextual + meta) phi, internal scale. */
  opponentCombinedPhi: number;
  score: 0 | 0.5 | 1;
  weight?: number;
}

/** Combines a team's contextual rating with its league meta for display/expectancy. */
export function combineContextualAndMeta(
  contextual: RatingState,
  meta: RatingState,
  metaWeight: number = DEFAULT_META_WEIGHT,
  phiInitMax?: number,
  participationFactor: number = 1,
): RatingState {
  const weight = effectiveMetaWeight(meta, metaWeight, phiInitMax) * participationFactor;
  return {
    mu: contextual.mu + weight * meta.mu,
    phi: Math.hypot(contextual.phi, weight * meta.phi),
    sigma: contextual.sigma, // not meaningfully combined; display doesn't use it
  };
}

export function toDisplayRating(
  contextual: RatingState,
  meta: RatingState,
  metaWeight: number = DEFAULT_META_WEIGHT,
  phiInitMax?: number,
  participationFactor: number = 1,
): DisplayRating {
  return fromGlicko2Scale(combineContextualAndMeta(contextual, meta, metaWeight, phiInitMax, participationFactor));
}

/**
 * League-only display: meta.mu is an offset from neutral, so it's scaled but not
 * shifted by the 1500 center. Pass metaWeight/phiInitMax to report the credit
 * teams actually receive (raw mu is inflated by ~1/effectiveMetaWeight).
 */
export function metaToDisplayOffset(
  meta: RatingState,
  metaWeight?: number,
  phiInitMax?: number,
): DisplayRating {
  const weight = metaWeight === undefined ? 1 : effectiveMetaWeight(meta, metaWeight, phiInitMax);
  return {
    rating: weight * meta.mu * GLICKO2_SCALE,
    rd: weight * meta.phi * GLICKO2_SCALE,
  };
}

/**
 * Updates a league's meta rating from its teams' international games this period.
 * A 3-2 series is passed as 3 win + 2 loss games, each separate evidence.
 */
export function updateLeagueMeta(
  currentMeta: RatingState,
  games: InternationalGameResult[],
  tau = DEFAULT_TAU,
  metaWeight: number = DEFAULT_META_WEIGHT,
  phiInitMax?: number,
  /** Time this period represents, in SIGMA_REFERENCE_DAYS units -- see updateRating. */
  elapsedPeriods = 1,
): RatingState {
  if (games.length === 0) {
    const phiStar = Math.sqrt(currentMeta.phi * currentMeta.phi + currentMeta.sigma * currentMeta.sigma * elapsedPeriods);
    return { mu: currentMeta.mu, phi: phiStar, sigma: currentMeta.sigma };
  }

  const weightedMetaMu = effectiveMetaWeight(currentMeta, metaWeight, phiInitMax) * currentMeta.mu;
  let vInverse = 0;
  let deltaSum = 0;
  for (const game of games) {
    const weight = game.weight ?? 1;
    const ownCombinedMu = game.ownContextualMu + weightedMetaMu;
    const gPhiOpponent = g(game.opponentCombinedPhi);
    const eValue = E(ownCombinedMu, game.opponentCombinedMu, game.opponentCombinedPhi);
    vInverse += weight * gPhiOpponent * gPhiOpponent * eValue * (1 - eValue);
    deltaSum += weight * gPhiOpponent * (game.score - eValue);
  }
  const v = 1 / vInverse;
  const delta = v * deltaSum;

  const newSigma = solveNewVolatility(currentMeta.phi, currentMeta.sigma, v, delta, tau);
  const phiStar = Math.sqrt(currentMeta.phi * currentMeta.phi + newSigma * newSigma * elapsedPeriods);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const newMu = currentMeta.mu + newPhi * newPhi * deltaSum;

  return { mu: newMu, phi: newPhi, sigma: newSigma };
}

/** A league with zero recorded international games: neutral, maximally uncertain. */
export function initialLeagueMeta(phiInitMax: number): RatingState {
  return { mu: 0, phi: phiInitMax, sigma: DEFAULT_VOLATILITY };
}
