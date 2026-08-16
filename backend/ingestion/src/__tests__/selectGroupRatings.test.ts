import { describe, it, expect } from 'vitest';
import { selectGroupRatings } from '../computePlayerRatings.js';

/**
 * Guards the win weight actually reaching the blend. It did not for the whole
 * of v3: selectGroupRatings took the parameter as `_winWeight` and always used
 * the role's own weights, so manualWinWeightSweep.ts printed six identical
 * boards and reported that the win weight did not matter.
 */

// One peer group, two opposite profiles: outcome and box score disagree, so the
// ordering between them is decided purely by how the two are weighted.
const winner = {
  playerId: 1,
  role: 'TOP',
  leagueId: 1,
  winRate: 0.9,
  kda: 1,
  goldShare: 0.1,
  damageShare: 0.1,
  killParticipation: 0.1,
  csMin: 5,
  goldDiff: -1000,
  objControl: 0.1,
  gamesPlayed: 100,
  effectiveGames: 100,
};

const statPadder = {
  ...winner,
  playerId: 2,
  winRate: 0.1,
  kda: 9,
  goldShare: 0.9,
  damageShare: 0.9,
  killParticipation: 0.9,
  csMin: 10,
  goldDiff: 1000,
  objControl: 0.9,
};

const ratingOf = (rows: ReturnType<typeof selectGroupRatings>, playerId: number) =>
  rows.find((r) => r.playerId === playerId)!.rating;

describe('selectGroupRatings win weight', () => {
  it('lets the outcome decide when the win weight is high', () => {
    const rated = selectGroupRatings([winner, statPadder], 1);
    expect(ratingOf(rated, 1)).toBeGreaterThan(ratingOf(rated, 2));
  });

  it('lets the box score decide when the win weight is low', () => {
    const rated = selectGroupRatings([winner, statPadder], 0);
    expect(ratingOf(rated, 2)).toBeGreaterThan(ratingOf(rated, 1));
  });

  it('moves the ratings between neighbouring sweep steps', () => {
    const at40 = ratingOf(selectGroupRatings([winner, statPadder], 0.4), 1);
    const at50 = ratingOf(selectGroupRatings([winner, statPadder], 0.5), 1);
    const at60 = ratingOf(selectGroupRatings([winner, statPadder], 0.6), 1);

    expect(at40).not.toBeCloseTo(at50, 6);
    expect(at50).not.toBeCloseTo(at60, 6);
    expect(at40).toBeLessThan(at50);
    expect(at50).toBeLessThan(at60);
  });

  it('defaults to the shipped weights', () => {
    expect(selectGroupRatings([winner, statPadder])).toEqual(selectGroupRatings([winner, statPadder], 0.5));
  });
});
