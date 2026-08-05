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
 * Regresses a team's rating toward rosterImpliedMu proportional to turnover
 * (fraction of the 5 starting roles that changed), widening RD and volatility
 * in step. turnover=0 is a no-op; turnover=1 (full 5-man swap) regresses fully
 * to rosterImpliedMu with fresh uncertainty.
 */
export function applyRosterChangeDecay(
  current: RatingState,
  turnover: number,
  rosterImpliedMu: number,
  config: RosterDecayConfig,
): RatingState {
  const clampedTurnover = Math.max(0, Math.min(1, turnover));
  return {
    mu: current.mu + clampedTurnover * (rosterImpliedMu - current.mu),
    phi: Math.max(current.phi, current.phi + clampedTurnover * (config.phiInitMax - current.phi)),
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
  rosterChange: { turnover: number; rosterImpliedMu: number } | null,
  seasonal: { leagueMeanMu: number; kSeason: number } | null,
  config: RosterDecayConfig,
): RatingState {
  if (rosterChange && !seasonal) {
    return applyRosterChangeDecay(current, rosterChange.turnover, rosterChange.rosterImpliedMu, config);
  }
  if (seasonal && !rosterChange) {
    return applySeasonalDecay(current, seasonal.leagueMeanMu, seasonal.kSeason);
  }
  if (rosterChange && seasonal) {
    const rosterResult = applyRosterChangeDecay(current, rosterChange.turnover, rosterChange.rosterImpliedMu, config);
    const seasonalResult = applySeasonalDecay(current, seasonal.leagueMeanMu, seasonal.kSeason);
    const rosterShift = Math.abs(rosterResult.mu - current.mu);
    const seasonalShift = Math.abs(seasonalResult.mu - current.mu);
    return rosterShift >= seasonalShift ? rosterResult : seasonalResult;
  }
  return current;
}
