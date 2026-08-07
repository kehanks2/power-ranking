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
 * Turns incoming starters' within-league percentiles into a roster-implied mu,
 * offset from the league mean. `offsetScaleRatingPoints` is in display points.
 * A low-confidence (few-games) player collapses the result toward the mean.
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

// How much a fully-confident roster-implied prior reduces the RD widening a
// roster change causes. 0 ignores the prior for uncertainty; 1 would widen not at
// all. 0.8, not 1 (Brier is worse at 1): five known players are still an unknown
// combination, so a fifth of the widening stays. Applied only at roster changes.
export const DEFAULT_PRIOR_CONFIDENCE_RELIEF = 0.8;

/**
 * Regresses a team's rating toward rosterImpliedMu proportional to turnover
 * (fraction of the 5 roles that changed), widening RD and volatility in step;
 * turnover=0 is a no-op. `priorConfidence` (0-1) damps the widening, so a team
 * that swapped known players isn't reset to "we know nothing"; an unknown prior
 * (rookies) still gives the full reset.
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
 * Split-boundary soft decay: regress mu toward the league mean by kSeason. Leaves
 * phi/sigma alone -- offseason RD growth already happens via updateRating([]).
 */
export function applySeasonalDecay(current: RatingState, leagueMeanMu: number, kSeason: number): RatingState {
  return {
    ...current,
    mu: current.mu + kSeason * (leagueMeanMu - current.mu),
  };
}

/**
 * When a roster change and a split boundary coincide, apply only the
 * larger-magnitude mu regression, not both stacked.
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
