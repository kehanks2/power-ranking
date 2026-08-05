import { GLICKO2_SCALE, type RatingState } from './glicko2.js';

export interface IncomingPlayerSignal {
  /** 0-100 within-league performance percentile (see playerRating.ts). */
  percentile: number;
  /** 0-1 confidence weight, ramped by games played. */
  confidence: number;
}

/** Ramps 0->1 as a player accumulates games, so a rookie's signal collapses to the league mean. */
export function confidenceFromGamesPlayed(gamesPlayed: number, minGamesThreshold: number): number {
  if (minGamesThreshold <= 0) return 1;
  return Math.min(1, gamesPlayed / minGamesThreshold);
}

/**
 * Converts within-league percentile signals from the incoming starters into a
 * roster-implied mu (internal Glicko-2 scale), offset from the league mean.
 * `offsetScaleRatingPoints` is in *display* rating points (e.g. 150), converted
 * to internal units here. A player below the min-games threshold contributes a
 * near-zero-confidence offset, collapsing the result back toward the league mean.
 */
export function computeRosterImpliedMu(
  leagueMeanMu: number,
  incomingPlayers: IncomingPlayerSignal[],
  offsetScaleRatingPoints: number,
): number {
  if (incomingPlayers.length === 0) return leagueMeanMu;

  const offsetScaleInternal = offsetScaleRatingPoints / GLICKO2_SCALE;
  let weightedOffsetSum = 0;
  let weightSum = 0;
  for (const player of incomingPlayers) {
    const offset = ((player.percentile - 50) / 50) * offsetScaleInternal;
    weightedOffsetSum += offset * player.confidence;
    weightSum += player.confidence;
  }
  if (weightSum === 0) return leagueMeanMu;
  return leagueMeanMu + weightedOffsetSum / weightSum;
}

export interface RosterDecayConfig {
  phiInitMax: number;
  sigmaDefault: number;
}

/**
 * How much a fully-confident roster-implied prior is allowed to reduce the RD
 * widening. At 0 the prior is ignored for uncertainty (the original
 * behaviour); at 1 a well-known incoming five would widen RD not at all.
 *
 * Deliberately not 1: even five individually well-understood players are an
 * unknown *combination*. Team synergy is real, so signing five known stars
 * still leaves genuine uncertainty about the unit. This keeps 40% of the
 * widening at full confidence.
 */
export const DEFAULT_PRIOR_CONFIDENCE_RELIEF = 0.6;

/**
 * Regresses a team's rating toward rosterImpliedMu proportional to turnover
 * (fraction of the 5 starting roles that changed), widening RD and volatility
 * in step. turnover=0 is a no-op.
 *
 * `priorConfidence` (0-1) is the mean confidence of the incoming players'
 * ratings -- the same signal computeRosterImpliedMu already uses to shape
 * `mu`. Without it this function was internally inconsistent: it would assert
 * a specific new rating derived from player evidence, while simultaneously
 * widening RD as though the team were unknown. Confirmed against real data:
 * Vivo Keyd Stars swapped 4 of 5 starters and went from a converged RD of 131
 * to 306 out of a 350 maximum -- i.e. "we know almost nothing" -- even though
 * every incoming player had a rating we were confident enough to move mu with.
 *
 * A confident prior now damps the widening; an unknown one (rookies, no
 * rating) still produces the full original reset.
 */
export function applyRosterChangeDecay(
  current: RatingState,
  turnover: number,
  rosterImpliedMu: number,
  config: RosterDecayConfig,
  priorConfidence = 0,
  priorConfidenceRelief = DEFAULT_PRIOR_CONFIDENCE_RELIEF,
): RatingState {
  const clampedTurnover = Math.max(0, Math.min(1, turnover));
  const clampedConfidence = Math.max(0, Math.min(1, priorConfidence));
  const wideningScale = 1 - priorConfidenceRelief * clampedConfidence;
  return {
    mu: current.mu + clampedTurnover * (rosterImpliedMu - current.mu),
    phi: Math.max(
      current.phi,
      current.phi + clampedTurnover * wideningScale * (config.phiInitMax - current.phi),
    ),
    sigma: current.sigma + clampedTurnover * (config.sigmaDefault - current.sigma),
  };
}

/**
 * Split-boundary soft decay: regress mu toward the league mean by kSeason.
 * Deliberately does not touch phi/sigma -- RD growth across the offseason gap
 * already happens for free via updateRating([]) during periods with no games.
 */
export function applySeasonalDecay(current: RatingState, leagueMeanMu: number, kSeason: number): RatingState {
  return {
    ...current,
    mu: current.mu + kSeason * (leagueMeanMu - current.mu),
  };
}

/**
 * If a roster change and a split boundary land in the same period, apply only
 * the larger-magnitude mu regression, not both stacked (plan's explicit rule
 * to avoid double-penalizing a team that both swapped players and hit an
 * offseason gap at the same time).
 */
export function applyCoincidentDecay(
  current: RatingState,
  rosterChange: { turnover: number; rosterImpliedMu: number; priorConfidence?: number } | null,
  seasonal: { leagueMeanMu: number; kSeason: number } | null,
  config: RosterDecayConfig,
  priorConfidenceRelief = DEFAULT_PRIOR_CONFIDENCE_RELIEF,
): RatingState {
  const roster = (state: RatingState) =>
    applyRosterChangeDecay(
      state,
      rosterChange!.turnover,
      rosterChange!.rosterImpliedMu,
      config,
      rosterChange!.priorConfidence ?? 0,
      priorConfidenceRelief,
    );
  if (rosterChange && !seasonal) {
    return roster(current);
  }
  if (seasonal && !rosterChange) {
    return applySeasonalDecay(current, seasonal.leagueMeanMu, seasonal.kSeason);
  }
  if (rosterChange && seasonal) {
    const rosterResult = roster(current);
    const seasonalResult = applySeasonalDecay(current, seasonal.leagueMeanMu, seasonal.kSeason);
    const rosterShift = Math.abs(rosterResult.mu - current.mu);
    const seasonalShift = Math.abs(seasonalResult.mu - current.mu);
    return rosterShift >= seasonalShift ? rosterResult : seasonalResult;
  }
  return current;
}
