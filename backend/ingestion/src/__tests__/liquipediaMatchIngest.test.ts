import { describe, it, expect } from 'vitest';
import { classifyMatch, isPlayedGame } from '../liquipediaMatchIngest.js';

describe('isPlayedGame', () => {
  it('accepts a normal decisive game', () => {
    expect(isPlayedGame({ winner: '1', opponents: [{ score: 1 }, { score: 0 }] })).toBe(true);
    expect(isPlayedGame({ winner: '2', opponents: [{ score: 0 }, { score: 1 }] })).toBe(true);
  });

  it('rejects the unplayed placeholder slot an early-ending series still returns', () => {
    // Exactly the shape the API returns for game 3 of a 2-0 sweep.
    expect(isPlayedGame({ winner: '', opponents: [{ score: 0 }, { score: 0 }] })).toBe(false);
  });

  it('rejects a placeholder even though it carries a full player list', () => {
    // Regression guard: placeholders DO ship rosters, so player count must
    // never be used as the played/unplayed test.
    const placeholder = { winner: '', opponents: [{ score: 0, players: new Array(7) }, { score: 0, players: new Array(7) }] };
    expect(isPlayedGame(placeholder as never)).toBe(false);
  });

  it('rejects malformed games (both sides scoring, or not exactly two sides)', () => {
    expect(isPlayedGame({ winner: '1', opponents: [{ score: 1 }, { score: 1 }] })).toBe(false);
    expect(isPlayedGame({ winner: '1', opponents: [{ score: 1 }] })).toBe(false);
  });

  it('still accepts a decisive game when winner is absent entirely', () => {
    expect(isPlayedGame({ opponents: [{ score: 1 }, { score: 0 }] })).toBe(true);
  });
});

function leagueMap(): Map<string, number> {
  return new Map([
    ['LCK', 1],
    ['LPL', 2],
    ['LEC', 3],
    ['LCS', 4],
    ['CBLOL', 5],
    ['LCP', 6],
  ]);
}

describe('classifyMatch', () => {
  it('classifies a regional split game with its canonical league', () => {
    const result = classifyMatch('LoL Pro League', 'LPL/2026/Split_3', leagueMap());
    expect(result).toEqual({ tournamentType: 'regional_split', canonicalLeagueId: 2, isInternational: false });
  });

  it('classifies the real MSI bracket as international', () => {
    const result = classifyMatch('Mid-Season Invitational', 'Mid-Season_Invitational/2026', leagueMap());
    expect(result).toEqual({ tournamentType: 'international', canonicalLeagueId: null, isInternational: true });
  });

  it('classifies Worlds and First Stand as international', () => {
    expect(classifyMatch('World Championships', 'World_Championship/2025', leagueMap())?.isInternational).toBe(true);
    expect(classifyMatch('First Stand Tournament', 'First_Stand_Tournament/2026', leagueMap())?.isInternational).toBe(true);
  });

  it('excludes a regional MSI-qualifier bracket sharing the MSI series name', () => {
    const result = classifyMatch('Mid-Season Invitational', 'LCK/2026/Road_to_MSI', leagueMap());
    expect(result).toBeNull();
  });

  it('excludes non-Riot-official tournaments (Esports World Cup, KeSPA Cup) entirely', () => {
    expect(classifyMatch('Esports World Cup', 'Esports_World_Cup/2026', leagueMap())).toBeNull();
    expect(classifyMatch('KeSPA Cup', 'KeSPA_Cup/2026', leagueMap())).toBeNull();
  });

  it('excludes an unrecognized series by default (no denylist needed)', () => {
    expect(classifyMatch('Liga Regional Norte', 'Liga_Regional_Norte/2026/Split_2', leagueMap())).toBeNull();
  });

  it('returns null for a regional league whose id is missing from the map (defensive)', () => {
    const partialMap = new Map([['LPL', 2]]);
    expect(classifyMatch('LoL Champions Korea', 'LCK/2026', partialMap)).toBeNull();
  });
});
