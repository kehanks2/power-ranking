/**
 * Additive contextual + meta rating structure (adopted from the PandaSkill
 * paper's approach to cross-region player comparability, applied here at the
 * team/league level -- see plan section "Cross-region comparability").
 *
 * team_displayed_rating = team_contextual_rating + effectiveMetaWeight * league_meta_rating
 *
 * - team_contextual_rating updates only from intra-league games (plain updateRating).
 * - league_meta_rating updates only from international games, via updateLeagueMeta
 *   below: expectancy is computed from each side's full contextual+meta combined
 *   rating, but the resulting delta is applied only to the league_meta state.
 * - metaWeight (base weight, backtest-tuned) exists because an unweighted sum
 *   let the region-level swing dominate individual team merit -- a weak team
 *   in a strong region could outrank a genuinely strong team in a weak region
 *   even after the strong team just beat top opponents. The official Global
 *   Power Rankings deliberately blends team/league as an 80/20 WEIGHTED
 *   average rather than an unweighted sum, for the same reason.
 * - On top of that base weight, effectiveMetaWeight further shrinks by the
 *   meta's OWN confidence (phi_meta relative to phi_init_max). Confirmed
 *   against real data this matters, not just in theory: CBLOL's meta carried
 *   phi_meta ~124 (vs ~52-64 for every other league -- roughly double the
 *   uncertainty) while still swinging harder than any other league (-281),
 *   because a flat metaWeight has no way to make a *less certain* estimate
 *   count for *less*. A meta at maximum uncertainty (phi_meta = phi_init_max,
 *   i.e. no international games yet) contributes nothing; a well-established
 *   one (phi_meta near 0) gets the full base metaWeight.
 */

import { g, E, solveNewVolatility, DEFAULT_TAU, DEFAULT_VOLATILITY, GLICKO2_SCALE, fromGlicko2Scale, type RatingState, type DisplayRating } from './glicko2.js';

export const DEFAULT_META_WEIGHT = 1.0;

/**
 * Shrinks metaWeight by the meta's own confidence: 0 at max uncertainty,
 * metaWeight at phi_meta=0. Pass phiInitMax=undefined to skip shrinkage
 * entirely (flat metaWeight, the pre-shrinkage behavior).
 */
export function effectiveMetaWeight(meta: RatingState, metaWeight: number, phiInitMax?: number): number {
  if (phiInitMax === undefined || phiInitMax <= 0) return metaWeight;
  const confidence = 1 - Math.min(1, meta.phi / phiInitMax);
  return metaWeight * Math.max(0, confidence);
}

// A team's SHARE of its league's meta credit shouldn't stay full forever if
// THAT SPECIFIC team hasn't personally played internationally in a long time.
// Confirmed against real data this matters: Dplus Kia's last international
// game was Worlds 2024 (~2 years ago), yet they still received LCK's full,
// undiminished meta credit and out-ranked teams that had personally just
// played MSI/First Stand in a much weaker region's meta. effectiveMetaWeight
// already shrinks credit by the META's OWN confidence (shared, per-league) --
// this is a second, independent shrinkage keyed to the INDIVIDUAL team's own
// participation recency, since "the region is strong" and "this specific team
// personally proved it recently" are different claims.
// Six months, deliberately shorter than the year this started at. A year of
// undiminished credit spans an entire competitive season: a team that attended
// last year's First Stand still carried full regional credit through a whole
// domestic year in which the region's standing may have changed completely.
// Half a year means credit lapses if a team misses the next international
// cycle, which is roughly the real cadence (First Stand -> MSI -> Worlds).
export const META_PARTICIPATION_FULL_CREDIT_DAYS = 182;
export const META_PARTICIPATION_ZERO_CREDIT_DAYS = 730;
// Never fully zero -- a team that's simply never had the chance yet (too new)
// still gets partial regional credit, matching the original design intent
// that every team in a strong region gets "some benefit of the doubt."
export const META_PARTICIPATION_FLOOR = 0.3;

/**
 * 1.0 within six months of the team's own last international game, decaying
 * linearly to a floor (never zero) by two years, floor also applied if the
 * team has never played internationally at all.
 */
export function internationalParticipationFactor(daysSinceLastInternational: number | null): number {
  if (daysSinceLastInternational === null) return META_PARTICIPATION_FLOOR;
  if (daysSinceLastInternational <= META_PARTICIPATION_FULL_CREDIT_DAYS) return 1;
  if (daysSinceLastInternational >= META_PARTICIPATION_ZERO_CREDIT_DAYS) return META_PARTICIPATION_FLOOR;
  const span = META_PARTICIPATION_ZERO_CREDIT_DAYS - META_PARTICIPATION_FULL_CREDIT_DAYS;
  const progress = (daysSinceLastInternational - META_PARTICIPATION_FULL_CREDIT_DAYS) / span;
  return 1 - progress * (1 - META_PARTICIPATION_FLOOR);
}

/**
 * International games at which a team's own record has replaced half of the
 * league prior. Roughly one deep run at a major event.
 */
export const META_EVIDENCE_HALF_LIFE_GAMES = 30;

/**
 * How much of the league prior a team should still be carrying, given how much
 * international evidence it has of its OWN.
 *
 * NOT USED IN PRODUCTION -- kept because manualLeagueCalibration.ts scores it
 * as one mode, and because the hypothesis is tempting enough to be worth
 * recording as tested and rejected.
 *
 * The idea: the league meta is a *prior*, and a team's contextual rating is
 * updated against opponents' COMBINED (contextual + meta) strength, so a team
 * with many international games should already be cross-calibrated and need
 * less of the prior. It looked like it would fix two real observations --
 * Bilibili Gaming had the best international record of any team in 2026 (12-3
 * at First Stand, 11-6 at MSI, 72% overall vs T1's 71%) yet ranked below three
 * LCK teams, and LCS as a whole won 43.0% of cross-league games while the
 * model predicted 34.3%.
 *
 * Measured, it makes calibration WORSE: weighted mean absolute gap across
 * cross-league games goes from 3.62pp to 4.65pp, flipping LCK from -1.8pp to
 * +5.0pp and pushing LCP to -7.6pp. The reason is that a team's contextual
 * rating is still predominantly earned in REGIONAL games, so it is only
 * partially cross-calibrated no matter how many internationals it has played.
 * Dropping the prior entirely is worse still (8.49pp; LCK +15.9pp,
 * CBLOL -21.0pp), which is the same effect at full strength.
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

/**
 * Combines a team's contextual rating with its league's meta rating for
 * display/expectancy. phiInitMax is required to compute the meta's own
 * confidence shrinkage (see effectiveMetaWeight) -- pass the same
 * phi_init_max used everywhere else in the rating engine.
 */
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
    sigma: contextual.sigma, // sigma is not meaningfully combined; display doesn't use it
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
 * League-only display: meta.mu is a pure offset from neutral (0 = no league
 * assumed stronger than another), so it's scaled but NOT shifted by the
 * 1500 rating center -- unlike toDisplayRating, which combines with a team's
 * contextual rating that IS centered at 1500.
 *
 * Pass metaWeight/phiInitMax to report the credit a league's teams ACTUALLY
 * receive, rather than the raw internal parameter. They are different numbers,
 * and only the weighted one means anything outside the engine: a league's
 * stored mu only ever reaches a team through
 * `effectiveMetaWeight(meta, metaWeight, phiInitMax) * mu`, so the raw value is
 * inflated by roughly 1/effectiveMetaWeight relative to any real-world gap.
 *
 * Confirmed against real data. Displaying raw mu put LCK at +369 and CBLOL at
 * -371, a 740-point spread implying LCK wins 98.6% of games between them. A
 * Bradley-Terry model fitted directly to the 435 cross-league international
 * games puts the real spread at 332 points, or 87.1%.
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
 * Updates a league's meta rating from the international games any of its teams
 * played in the period. A 3-2 international series should be passed as 3 win
 * games + 2 loss games (not one series-level result) -- each individual game
 * is separate evidence.
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
