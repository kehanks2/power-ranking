/**
 * Margin-of-victory weighting. A heuristic bolt-on to Glicko-2, not part of
 * Glickman's published spec -- see the plan's "Backtest" verification step
 * before trusting this enabled by default in production.
 */

export interface MovWeightInput {
  team1Gold: number;
  team2Gold: number;
  gamelengthSeconds: number;
}

/**
 * weight_j = clamp(1 + ln(1 + margin/marginScale), 1.0, cap)
 * margin = gold-diff-per-minute. Symmetric by construction: both teams in a
 * game share the same margin, so callers must apply the same weight to both
 * sides' contributions for that game -- an asymmetric application would
 * silently bias the model (see plan finding F).
 */
export function computeMovWeight(
  input: MovWeightInput,
  marginScale: number,
  cap: number,
): number {
  const gamelengthMinutes = input.gamelengthSeconds / 60;
  if (gamelengthMinutes <= 0) return 1;

  const margin = Math.abs(input.team1Gold - input.team2Gold) / gamelengthMinutes;
  const raw = 1 + Math.log(1 + margin / marginScale);
  return Math.min(raw, cap);
}
