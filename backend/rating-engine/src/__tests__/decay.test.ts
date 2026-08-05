import { describe, it, expect } from 'vitest';
import { toGlicko2Scale, fromGlicko2Scale, GLICKO2_SCALE } from '../glicko2.js';
import {
  applyRosterChangeDecay,
  applySeasonalDecay,
  applyCoincidentDecay,
  computeRosterImpliedMu,
  confidenceFromGamesPlayed,
  type RosterDecayConfig,
} from '../decay.js';

const config: RosterDecayConfig = { phiInitMax: 350 / GLICKO2_SCALE, sigmaDefault: 0.06 };

describe('roster-change decay', () => {
  it('0% turnover is a no-op', () => {
    const current = toGlicko2Scale(1700, 80);
    const result = applyRosterChangeDecay(current, 0, toGlicko2Scale(1500, 0).mu, config);
    expect(result.mu).toBeCloseTo(current.mu, 10);
    expect(result.phi).toBeCloseTo(current.phi, 10);
    expect(result.sigma).toBeCloseTo(current.sigma, 10);
  });

  it('20% turnover only nudges the rating toward the roster-implied value', () => {
    const current = toGlicko2Scale(1700, 80);
    const rosterImpliedMu = toGlicko2Scale(1500, 0).mu; // league mean
    const result = applyRosterChangeDecay(current, 0.2, rosterImpliedMu, config);
    const display = fromGlicko2Scale(result);

    expect(display.rating).toBeLessThan(1700);
    expect(display.rating).toBeGreaterThan(1650); // small nudge, not a big swing
  });

  it('100% turnover (full 5-man swap) regresses fully to the roster-implied rating with fresh uncertainty', () => {
    const current = toGlicko2Scale(1700, 80);
    const rosterImpliedMu = toGlicko2Scale(1550, 0).mu;
    const result = applyRosterChangeDecay(current, 1, rosterImpliedMu, config);
    const display = fromGlicko2Scale(result);

    expect(display.rating).toBeCloseTo(1550, 5);
    expect(display.rd).toBeCloseTo(350, 5);
    expect(result.sigma).toBeCloseTo(0.06, 5);
  });

  it('confidenceFromGamesPlayed ramps 0->1 and a rookie collapses roster_implied to the league mean', () => {
    expect(confidenceFromGamesPlayed(0, 10)).toBe(0);
    expect(confidenceFromGamesPlayed(5, 10)).toBeCloseTo(0.5, 5);
    expect(confidenceFromGamesPlayed(20, 10)).toBe(1);

    const leagueMeanMu = toGlicko2Scale(1500, 0).mu;
    const rookieImplied = computeRosterImpliedMu(
      leagueMeanMu,
      [{ percentile: 95, confidence: confidenceFromGamesPlayed(0, 10) }],
      150,
    );
    expect(rookieImplied).toBeCloseTo(leagueMeanMu, 10);
  });

  it('an established high-percentile transfer pulls roster_implied above the league mean', () => {
    const leagueMeanMu = toGlicko2Scale(1500, 0).mu;
    const implied = computeRosterImpliedMu(
      leagueMeanMu,
      [{ percentile: 95, confidence: 1 }],
      150,
    );
    expect(implied).toBeGreaterThan(leagueMeanMu);
  });
});

describe('seasonal soft-decay', () => {
  it('regresses mu toward the league mean without touching phi/sigma', () => {
    const current = toGlicko2Scale(1800, 60);
    const leagueMeanMu = toGlicko2Scale(1500, 0).mu;
    const result = applySeasonalDecay(current, leagueMeanMu, 0.25);
    const display = fromGlicko2Scale(result);

    expect(display.rating).toBeLessThan(1800);
    expect(display.rating).toBeGreaterThan(1500);
    expect(result.phi).toBeCloseTo(current.phi, 10);
    expect(result.sigma).toBeCloseTo(current.sigma, 10);
  });
});

describe('coincident roster-change + split-boundary decay', () => {
  it('applies only the larger regression, not both stacked', () => {
    const current = toGlicko2Scale(1900, 60);
    const leagueMeanMu = toGlicko2Scale(1500, 0).mu;

    const rosterOnly = applyRosterChangeDecay(current, 0.2, leagueMeanMu, config);
    const seasonalOnly = applySeasonalDecay(current, leagueMeanMu, 0.25);
    const combined = applyCoincidentDecay(
      current,
      { turnover: 0.2, rosterImpliedMu: leagueMeanMu },
      { leagueMeanMu, kSeason: 0.25 },
      config,
    );

    const rosterShift = Math.abs(rosterOnly.mu - current.mu);
    const seasonalShift = Math.abs(seasonalOnly.mu - current.mu);
    const combinedShift = Math.abs(combined.mu - current.mu);

    expect(combinedShift).toBeCloseTo(Math.max(rosterShift, seasonalShift), 10);
    // and not the (larger) sum of both, which would be double-penalizing:
    expect(combinedShift).toBeLessThan(rosterShift + seasonalShift);
  });
});
