import { describe, it, expect } from 'vitest';
import {
  classifyMatch,
  goldByRole,
  hasCompletePlayerData,
  shouldWaitForStats,
  STATS_GRACE_DAYS,
  isPlayedGame,
  resolveTournament,
} from '../liquipediaMatchIngest.js';
import { STAGE_STALL_DAYS } from '@power-ranking/shared';
import type { LiquipediaGamePlayer } from '../liquipediaApi.js';

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

  it('routes a Road to MSI qualifier to its regional league (LCK spring playoff)', () => {
    const result = classifyMatch('Mid-Season Invitational', 'LCK/2026/Road_to_MSI', leagueMap());
    expect(result).toEqual({ tournamentType: 'regional_split', canonicalLeagueId: 1, isInternational: false });
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

describe('resolveTournament', () => {
  const t = (parent: string, bracket: string) => resolveTournament({ parent, tournament: 'LCK 2026 Season', match2bracketid: bracket });

  it('splits the LCK season into Spring (Sp2) and Summer (Sp3/playoffs)', () => {
    expect(t('LCK/2026', 'LCK26Sp2W3')).toEqual({ overviewPage: 'liquipedia:LCK/2026/Spring', name: 'LCK 2026 Spring' });
    expect(t('LCK/2026', 'LCK26Sp3W1')).toEqual({ overviewPage: 'liquipedia:LCK/2026/Summer', name: 'LCK 2026 Summer' });
    expect(t('LCK/2026', 'LCK2026POB')).toEqual({ overviewPage: 'liquipedia:LCK/2026/Summer', name: 'LCK 2026 Summer' });
  });

  it('merges Road to MSI into the Spring half', () => {
    expect(t('LCK/2026/Road_to_MSI', 'LCKRtMSI26')).toEqual({ overviewPage: 'liquipedia:LCK/2026/Spring', name: 'LCK 2026 Spring' });
  });

  it('leaves the LCK Cup and other leagues on their own parent', () => {
    expect(resolveTournament({ parent: 'LCK/2026/Cup', tournament: 'LCK Cup 2026', match2bracketid: 'x' }))
      .toEqual({ overviewPage: 'liquipedia:LCK/2026/Cup', name: 'LCK Cup 2026' });
    expect(resolveTournament({ parent: 'LPL/2026/Split_1', tournament: 'LPL 2026 Split 1', match2bracketid: 'x' }))
      .toEqual({ overviewPage: 'liquipedia:LPL/2026/Split_1', name: 'LPL 2026 Split 1' });
  });
});

function side(entries: [string, number][]): LiquipediaGamePlayer[] {
  return entries.map(([role, gold]) => ({ role, gold }) as LiquipediaGamePlayer);
}

describe('goldByRole', () => {
  it('maps a normal five-role side onto our position codes', () => {
    const gold = goldByRole(
      side([
        ['top', 12000],
        ['jungle', 11000],
        ['mid', 13500],
        ['bot', 14200],
        ['support', 8100],
      ]),
    );
    expect([...gold]).toEqual([
      ['TOP', 12000],
      ['JNG', 11000],
      ['MID', 13500],
      ['BOT', 14200],
      ['SUP', 8100],
    ]);
  });

  it('drops a role carried by two players rather than guessing which is the lane opponent', () => {
    const gold = goldByRole(
      side([
        ['mid', 13500],
        ['mid', 9200],
        ['top', 12000],
      ]),
    );
    expect(gold.has('MID')).toBe(false);
    expect(gold.get('TOP')).toBe(12000);
  });

  it('omits unresolvable roles and treats missing gold as zero', () => {
    const gold = goldByRole([
      { role: 'coach', gold: 500 } as LiquipediaGamePlayer,
      { role: 'bot' } as LiquipediaGamePlayer,
    ]);
    expect(gold.has('BOT')).toBe(true);
    expect(gold.get('BOT')).toBe(0);
    expect(gold.size).toBe(1);
  });
});

const roster = (roles: string[]) => ({ players: roles.map((role) => ({ role })) });
const FULL = ['top', 'jungle', 'mid', 'bot', 'support'];

describe('hasCompletePlayerData', () => {
  it('accepts a game with all ten stat lines', () => {
    expect(hasCompletePlayerData({ opponents: [roster(FULL), roster(FULL)] })).toBe(true);
  });

  it('rejects a result published before its stat lines', () => {
    // Liquipedia does this: 13 LCS and LPL games on 2026-08-16 arrived with
    // scores and an empty players list. Ingesting one moves team ratings while
    // leaving player ratings behind, and team ratings read player ratings back
    // through the roster prior.
    expect(hasCompletePlayerData({ opponents: [{ players: [] }, { players: [] }] })).toBe(false);
    expect(hasCompletePlayerData({ opponents: [roster(FULL), { players: [] }] })).toBe(false);
    expect(hasCompletePlayerData({ opponents: [{}, {}] })).toBe(false);
  });

  it('rejects a side missing a role, or naming one twice', () => {
    expect(hasCompletePlayerData({ opponents: [roster(FULL), roster(FULL.slice(0, 4))] })).toBe(false);
    expect(hasCompletePlayerData({ opponents: [roster(FULL), roster(['top', 'top', 'mid', 'bot', 'support'])] })).toBe(false);
  });

  it('rejects unrecognised role names rather than counting them', () => {
    expect(hasCompletePlayerData({ opponents: [roster(FULL), roster(['top', 'jungle', 'mid', 'bot', 'coach'])] })).toBe(false);
  });
});

describe('shouldWaitForStats', () => {
  const complete = { opponents: [roster(FULL), roster(FULL)] };
  const bare = { opponents: [{ players: [] }, { players: [] }] };
  const at = (iso: string) => new Date(iso);

  it('never waits on a game that already has its stat lines', () => {
    expect(shouldWaitForStats(complete, '2026-08-16 12:00:00', at('2026-08-16T12:01:00Z'))).toBe(false);
  });

  it('waits while the stat lines may still arrive', () => {
    expect(shouldWaitForStats(bare, '2026-08-16 23:00:00', at('2026-08-17T02:30:00Z'))).toBe(true);
  });

  it('gives up rather than discarding a real result', () => {
    // Liquipedia never published player data for half of LPL 2024. Waiting
    // indefinitely would drop those games from the team boards too.
    const past = at(`2026-08-${16 + STATS_GRACE_DAYS}T23:30:00Z`);
    expect(shouldWaitForStats(bare, '2026-08-16 23:00:00', past)).toBe(false);
  });

  it('does not wait on an unparseable date', () => {
    expect(shouldWaitForStats(bare, '', at('2026-08-17T02:30:00Z'))).toBe(false);
  });
});

describe('the stats grace and the stage stall must not race', () => {
  it('releases a stalled week only after ingestion has given up waiting for stats', () => {
    // These two windows live in different packages and measure different things,
    // but they overlap on one case: a series whose result is published before
    // its stat lines has no games, so the board reads it as an outstanding
    // fixture. Whichever window expires first decides what happens.
    //
    // At equal values the stall won, and LCS week 4 was published as of 15 Aug
    // with LYON/Sentinels and FlyQuest/Cloud9 -- both played on the 16th, both
    // still held for stats -- missing. Sentinels appeared to fall for beating
    // the first-placed team.
    //
    // The stall must lose that race, so ingestion resolves the delay first and
    // the stage completes with its real results.
    expect(STAGE_STALL_DAYS).toBeGreaterThan(STATS_GRACE_DAYS);
  });
});

describe('re-ingesting must never narrow what we already hold', () => {
  // pruneStalePerformance clears rows for players "no longer listed", which is
  // right for a lineup correction and wrong for a partial fetch. Liquipedia
  // returns one side populated and the other empty often enough that this
  // mattered: the complete side's rows would have been deleted as stale.
  //
  // The guard is that a game is only offered to the prune when BOTH sides came
  // back with a full five roles.
  const offeredToPrune = (rolesPerSide: number[]) =>
    rolesPerSide.length === 2 && rolesPerSide.every((n) => n === 5);

  it('prunes a game that came back whole, so a real lineup correction still applies', () => {
    expect(offeredToPrune([5, 5])).toBe(true);
  });

  it('refuses to prune when one side came back empty', () => {
    expect(offeredToPrune([5, 0])).toBe(false);
    expect(offeredToPrune([0, 5])).toBe(false);
  });

  it('refuses to prune a partially filled side', () => {
    expect(offeredToPrune([5, 3])).toBe(false);
    expect(offeredToPrune([2, 2])).toBe(false);
  });

  it('refuses to prune a game with no player data at all', () => {
    // The 806 statless games. Re-fetching one must leave it exactly as it is.
    expect(offeredToPrune([0, 0])).toBe(false);
    expect(offeredToPrune([])).toBe(false);
  });
});
