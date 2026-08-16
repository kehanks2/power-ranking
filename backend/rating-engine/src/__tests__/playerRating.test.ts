import { describe, it, expect } from 'vitest';
import {
  percentile,
  computeCompositeScore,
  updatePlayerRating,
  recencyWeight,
  weightedMean,
  shrinkToNeutral,
  shrinkToward,
  transferAnchor,
  blendComponentPercentiles,
  componentWeights,
  componentWeightsForRole,
  componentWeightsForRoleAtWinWeight,
  ROLE_COMPONENT_WEIGHTS,
  DEFAULT_WIN_WEIGHT,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_SHRINKAGE_GAMES,
  type PlayerGameStats,
} from '../playerRating.js';

describe('percentile', () => {
  it('returns 50 with no peers to compare against', () => {
    expect(percentile(5, [])).toBe(50);
  });

  it('returns 0 for the worst value in the peer group', () => {
    expect(percentile(1, [1, 2, 3, 4, 5])).toBe(0);
  });

  it('returns 80 for a value better than 4 of 5 peers', () => {
    expect(percentile(10, [1, 2, 3, 4, 10])).toBe(80);
  });
});

describe('computeCompositeScore', () => {
  it('averages the four stat percentiles', () => {
    const stats: PlayerGameStats = { kda: 5, goldShare: 0.3, damageShare: 0.3, killParticipation: 0.7 };
    const peers: PlayerGameStats[] = [
      { kda: 1, goldShare: 0.1, damageShare: 0.1, killParticipation: 0.1 },
      { kda: 2, goldShare: 0.2, damageShare: 0.2, killParticipation: 0.2 },
    ];
    // stats is better than both peers on all four axes -> 100th percentile on each -> composite 100.
    expect(computeCompositeScore(stats, peers)).toBe(100);
  });

  it('is not comparing across roles/leagues implicitly -- caller controls the peer pool', () => {
    const stats: PlayerGameStats = { kda: 3, goldShare: 0.2, damageShare: 0.2, killParticipation: 0.5 };
    const midLanePeers: PlayerGameStats[] = [
      { kda: 5, goldShare: 0.25, damageShare: 0.3, killParticipation: 0.6 },
    ];
    const supportPeers: PlayerGameStats[] = [
      { kda: 1, goldShare: 0.05, damageShare: 0.05, killParticipation: 0.3 },
    ];
    // Same raw stats score differently depending on which peer pool the caller supplies.
    expect(computeCompositeScore(stats, midLanePeers)).toBeLessThan(
      computeCompositeScore(stats, supportPeers),
    );
  });
});

describe('updatePlayerRating', () => {
  it('seeds directly from the first game with no prior rating', () => {
    expect(updatePlayerRating(null, 70)).toBe(70);
  });

  it('blends toward the new score, weighted by alpha', () => {
    const updated = updatePlayerRating(50, 90, 0.2);
    expect(updated).toBeCloseTo(58, 5); // 0.2*90 + 0.8*50
  });

  it('reacts more to recent games than a simple all-time average would', () => {
    let rating: number | null = null;
    // A long cold streak of 40s, then a hot streak of 90s.
    for (let i = 0; i < 10; i++) rating = updatePlayerRating(rating, 40);
    const afterColdStreak = rating!;
    for (let i = 0; i < 5; i++) rating = updatePlayerRating(rating, 90);
    const afterHotStreak = rating!;

    const simpleAverage = (40 * 10 + 90 * 5) / 15;
    expect(afterHotStreak).toBeGreaterThan(simpleAverage); // EWMA overweights the recent hot streak
    expect(afterHotStreak).toBeGreaterThan(afterColdStreak);
  });
});

describe('recencyWeight', () => {
  it('counts a game played today at full weight', () => {
    expect(recencyWeight(0)).toBe(1);
  });

  it('halves at exactly one half-life and quarters at two', () => {
    expect(recencyWeight(DEFAULT_HALF_LIFE_DAYS)).toBeCloseTo(0.5, 10);
    expect(recencyWeight(DEFAULT_HALF_LIFE_DAYS * 2)).toBeCloseTo(0.25, 10);
  });

  it('never rewards a future-dated game with more than full weight', () => {
    expect(recencyWeight(-30)).toBe(1);
  });

  it('decays continuously, so there is no window boundary to fall off', () => {
    expect(recencyWeight(119)).toBeGreaterThan(recencyWeight(121));
    expect(recencyWeight(119) - recencyWeight(121)).toBeLessThan(0.01);
  });
});

describe('weightedMean', () => {
  it('matches a plain average when all weights are equal', () => {
    expect(weightedMean([1, 2, 3], [1, 1, 1])).toBeCloseTo(2, 10);
  });

  it('pulls toward the heavily weighted sample', () => {
    expect(weightedMean([0, 100], [1, 9])).toBeCloseTo(90, 10);
  });

  it('returns 0 rather than NaN when there is nothing to average', () => {
    expect(weightedMean([], [])).toBe(0);
    expect(weightedMean([5], [0])).toBe(0);
  });
});

describe('transferAnchor', () => {
  it('keeps about a third of the distance from neutral', () => {
    // Carryover 0.3, fit from data (cross-league percentile slope 0.315).
    expect(transferAnchor(80)).toBeCloseTo(59, 0);
    expect(transferAnchor(20)).toBeCloseTo(41, 0);
  });

  it('falls back to neutral when there is nothing to carry', () => {
    expect(transferAnchor(null)).toBe(50);
    expect(transferAnchor(undefined)).toBe(50);
  });

  it('never moves the anchor past the prior itself', () => {
    // A carryover above 1 would make a transfer more extreme than the prior.
    expect(transferAnchor(90)).toBeLessThan(90);
    expect(transferAnchor(90)).toBeGreaterThan(50);
  });
});

describe('shrinkToward', () => {
  it('pulls toward the anchor rather than neutral', () => {
    // At K games the score sits halfway between anchor and raw value.
    expect(shrinkToward(90, DEFAULT_SHRINKAGE_GAMES, 60)).toBeCloseTo(75, 10);
  });

  it('lands on the anchor when there is no evidence at all', () => {
    expect(shrinkToward(90, 0, 62)).toBeCloseTo(62, 10);
  });

  it('ignores the anchor once the sample is large', () => {
    // Evidence must win eventually, or the prior follows a player forever.
    expect(shrinkToward(90, 500, 50)).toBeCloseTo(shrinkToward(90, 500, 65), 0);
  });

  it('is exactly shrinkToNeutral when the anchor is 50', () => {
    expect(shrinkToward(88.6, 7, 50)).toBeCloseTo(shrinkToNeutral(88.6, 7), 10);
  });
});

describe('shrinkToNeutral', () => {
  it('lands halfway to neutral at exactly K effective games', () => {
    expect(shrinkToNeutral(90, DEFAULT_SHRINKAGE_GAMES)).toBeCloseTo(70, 10);
  });

  it('collapses a one-game sample close to neutral', () => {
    // The v1 bug this fixes: a 1-game player scored 88.6 and topped the table.
    const shrunk = shrinkToNeutral(88.6, 1);
    expect(shrunk).toBeGreaterThan(50);
    expect(shrunk).toBeLessThan(55);
  });

  it('barely moves a large sample', () => {
    expect(shrinkToNeutral(90, 200)).toBeGreaterThan(88);
  });

  it('shrinks a low score upward, not just a high score downward', () => {
    expect(shrinkToNeutral(10, 1)).toBeGreaterThan(10);
    expect(shrinkToNeutral(10, 1)).toBeLessThan(50);
  });

  it('shrinks a stale sample harder than a fresh one of the same raw size', () => {
    const tenFreshGames = 10 * recencyWeight(0);
    const tenOldGames = 10 * recencyWeight(DEFAULT_HALF_LIFE_DAYS * 3);
    expect(shrinkToNeutral(90, tenOldGames)).toBeLessThan(shrinkToNeutral(90, tenFreshGames));
  });
});

describe('componentWeights', () => {
  it('always sums to 1, at any win weight', () => {
    for (const winWeight of [0, 0.3, DEFAULT_WIN_WEIGHT, 0.7, 1]) {
      const total = Object.values(componentWeights(winWeight)).reduce((sum, w) => sum + w, 0);
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it('splits the non-win remainder evenly across the four box-score stats', () => {
    const weights = componentWeights(0.5);
    expect(weights.winRate).toBe(0.5);
    expect(weights.kda).toBeCloseTo(0.125, 10);
    expect(weights.goldShare).toBeCloseTo(0.125, 10);
    expect(weights.damageShare).toBeCloseTo(0.125, 10);
    expect(weights.killParticipation).toBeCloseTo(0.125, 10);
  });
});

describe('componentWeightsForRoleAtWinWeight', () => {
  const roles = Object.keys(ROLE_COMPONENT_WEIGHTS);

  it('returns the role weights unchanged at the shipped win weight', () => {
    for (const role of roles) {
      expect(componentWeightsForRoleAtWinWeight(role, DEFAULT_WIN_WEIGHT)).toBe(componentWeightsForRole(role));
    }
  });

  it('sets winRate to exactly what was asked for, and still sums to 1', () => {
    for (const role of roles) {
      for (const winWeight of [0, 0.3, 0.4, 0.45, 0.7, 1]) {
        const weights = componentWeightsForRoleAtWinWeight(role, winWeight);
        expect(weights.winRate).toBe(winWeight);
        const total = Object.values(weights).reduce((sum, w) => sum + (w ?? 0), 0);
        expect(total).toBeCloseTo(1, 10);
      }
    }
  });

  it('keeps the role internal balance, only rescaling it', () => {
    // SUP leans on kill participation; that shape must survive the rescale, or
    // sweeping the win weight would quietly be sweeping the role weights too.
    const base = componentWeightsForRole('SUP');
    const at40 = componentWeightsForRoleAtWinWeight('SUP', 0.4);
    const ratio = (at40.killParticipation ?? 0) / (base.killParticipation ?? 1);
    for (const component of ['killParticipation', 'kda', 'damageShare', 'objControl'] as const) {
      expect((at40[component] ?? 0) / (base[component] ?? 1)).toBeCloseTo(ratio, 10);
    }
    expect(ratio).toBeCloseTo((1 - 0.4) / (1 - (base.winRate ?? 0)), 10);
  });

  it('zeroes the box-score stats when the outcome takes all the weight', () => {
    const weights = componentWeightsForRoleAtWinWeight('TOP', 1);
    expect(weights.winRate).toBe(1);
    for (const [component, weight] of Object.entries(weights)) {
      if (component !== 'winRate') expect(weight).toBe(0);
    }
  });
});

describe('blendComponentPercentiles', () => {
  it('leaves an all-50 profile at 50', () => {
    expect(
      blendComponentPercentiles({ kda: 50, goldShare: 50, damageShare: 50, killParticipation: 50, winRate: 50 }),
    ).toBeCloseTo(50, 10);
  });

  it('lets winning move the composite -- the stat-padding fix', () => {
    // v1 had no win input at all: these two profiles were indistinguishable.
    const padder = blendComponentPercentiles({
      kda: 100, goldShare: 100, damageShare: 100, killParticipation: 100, winRate: 0,
    });
    const winner = blendComponentPercentiles({
      kda: 100, goldShare: 100, damageShare: 100, killParticipation: 100, winRate: 100,
    });
    expect(winner - padder).toBeCloseTo(DEFAULT_WIN_WEIGHT * 100, 10);
    expect(winner).toBeGreaterThan(padder);
  });

  // At the old 0.5 win weight the playmaker won this comparison outright. At 0.3
  // the stat line decides it, which is the deliberate trade: the board is meant
  // to show how good a player is rather than how good their team is, and a
  // player cannot be carried by their team's record. Kept as a guard on where
  // the balance actually sits, not as an endorsement of either side.
  it('lets a strong stat line outweigh a large win-rate gap at the shipped weight', () => {
    const playmaker = blendComponentPercentiles({
      kda: 20, goldShare: 40, damageShare: 40, killParticipation: 90, winRate: 95,
    });
    const padder = blendComponentPercentiles({
      kda: 95, goldShare: 90, damageShare: 90, killParticipation: 60, winRate: 15,
    });
    expect(padder).toBeGreaterThan(playmaker);

    // The 80-point win-rate gap is still worth exactly the win weight, so it
    // takes a box-score deficit wider than that to be overturned.
    expect(padder - playmaker).toBeLessThan(DEFAULT_WIN_WEIGHT * 100);
  });

  it('cannot be carried by winRate alone at the default weight', () => {
    const onlyWins = blendComponentPercentiles({
      kda: 0, goldShare: 0, damageShare: 0, killParticipation: 0, winRate: 100,
    });
    expect(onlyWins).toBeLessThanOrEqual(50);
  });

  it('honours an explicitly supplied weight set', () => {
    const percentiles = { kda: 0, goldShare: 0, damageShare: 0, killParticipation: 0, winRate: 100 };
    expect(blendComponentPercentiles(percentiles, componentWeights(0.3))).toBeCloseTo(30, 10);
    expect(blendComponentPercentiles(percentiles, componentWeights(0.7))).toBeCloseTo(70, 10);
  });
});
