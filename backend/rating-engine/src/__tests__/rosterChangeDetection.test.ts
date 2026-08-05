import { describe, it, expect } from 'vitest';
import { detectRosterChanges, computeTurnover, type LineupGame, type Role } from '../rosterChangeDetection.js';

const BASE_LINEUP: Record<Role, string> = { TOP: 'p1', JNG: 'p2', MID: 'p3', BOT: 'p4', SUP: 'p5' };

function makeGame(gameId: string, playedAt: number, overrides: Partial<Record<Role, string>> = {}): LineupGame {
  return { gameId, playedAt, lineup: { ...BASE_LINEUP, ...overrides } };
}

describe('detectRosterChanges', () => {
  it('does not trigger on a single one-off substitute appearance', () => {
    const games: LineupGame[] = [
      makeGame('g1', 1),
      makeGame('g2', 2),
      makeGame('g3', 3, { MID: 'sub1' }), // one-off sub, MID's usual starter returns after
      makeGame('g4', 4),
      makeGame('g5', 5),
    ];

    const events = detectRosterChanges(games, 2);
    expect(events).toHaveLength(0);
  });

  it('triggers a persistent swap, dated to the first game of the new lineup', () => {
    const games: LineupGame[] = [
      makeGame('g1', 1),
      makeGame('g2', 2),
      makeGame('g3', 3, { MID: 'newMid' }),
      makeGame('g4', 4, { MID: 'newMid' }),
      makeGame('g5', 5, { MID: 'newMid' }),
    ];

    const events = detectRosterChanges(games, 2);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      role: 'MID',
      previousPlayerId: 'p3',
      newPlayerId: 'newMid',
      effectiveGameId: 'g3',
    });
  });

  it('detects multiple simultaneous role changes and computes turnover correctly', () => {
    const games: LineupGame[] = [
      makeGame('g1', 1),
      makeGame('g2', 2, { TOP: 'newTop', JNG: 'newJng' }),
      makeGame('g3', 3, { TOP: 'newTop', JNG: 'newJng' }),
    ];

    const events = detectRosterChanges(games, 2);
    expect(events).toHaveLength(2);
    expect(computeTurnover(events)).toBeCloseTo(2 / 5, 5);
  });

  it('a full 5-man swap yields turnover of 1', () => {
    const games: LineupGame[] = [
      makeGame('g1', 1),
      makeGame('g2', 2, { TOP: 'n1', JNG: 'n2', MID: 'n3', BOT: 'n4', SUP: 'n5' }),
      makeGame('g3', 3, { TOP: 'n1', JNG: 'n2', MID: 'n3', BOT: 'n4', SUP: 'n5' }),
    ];

    const events = detectRosterChanges(games, 2);
    expect(computeTurnover(events)).toBe(1);
  });

  it('handles out-of-order input by sorting on playedAt first', () => {
    const games: LineupGame[] = [
      makeGame('g3', 3, { MID: 'newMid' }),
      makeGame('g1', 1),
      makeGame('g4', 4, { MID: 'newMid' }),
      makeGame('g2', 2),
    ];

    const events = detectRosterChanges(games, 2);
    expect(events).toHaveLength(1);
    expect(events[0].effectiveGameId).toBe('g3');
  });
});
