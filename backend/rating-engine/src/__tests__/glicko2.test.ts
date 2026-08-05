import { describe, it, expect } from 'vitest';
import {
  toGlicko2Scale,
  fromGlicko2Scale,
  updateRating,
  DEFAULT_TAU,
  type GameResult,
} from '../glicko2.js';

describe('glicko2 core update', () => {
  // Glickman's own worked example from "Example of the Glicko-2 system":
  // player rating 1500, RD 200, sigma 0.06, tau 0.5, three games in the period.
  // Expected result: rating' ~= 1464.06, RD' ~= 151.52, sigma' ~= 0.05999.
  it('matches Glickman\'s published worked example', () => {
    const player = toGlicko2Scale(1500, 200);
    const games: GameResult[] = [
      { opponent: toGlicko2Scale(1400, 30), score: 1 },
      { opponent: toGlicko2Scale(1550, 100), score: 0 },
      { opponent: toGlicko2Scale(1700, 300), score: 0 },
    ];

    const updated = updateRating(player, games, DEFAULT_TAU);
    const display = fromGlicko2Scale(updated);

    expect(display.rating).toBeCloseTo(1464.06, 1);
    expect(display.rd).toBeCloseTo(151.52, 1);
    expect(updated.sigma).toBeCloseTo(0.05999, 4);
  });

  it('grows RD (widens uncertainty) automatically with no games in the period', () => {
    const player = toGlicko2Scale(1500, 200);
    const updated = updateRating(player, [], DEFAULT_TAU);
    const display = fromGlicko2Scale(updated);

    expect(display.rd).toBeGreaterThan(200);
    expect(display.rating).toBeCloseTo(1500, 5);
    expect(updated.sigma).toBeCloseTo(0.06, 5);
  });

  it('moves rating up on a win against a similarly-rated opponent', () => {
    const player = toGlicko2Scale(1500, 100);
    const games: GameResult[] = [{ opponent: toGlicko2Scale(1500, 100), score: 1 }];
    const updated = updateRating(player, games);
    const display = fromGlicko2Scale(updated);

    expect(display.rating).toBeGreaterThan(1500);
  });
});
