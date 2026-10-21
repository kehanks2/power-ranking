import { describe, it, expect } from 'vitest';
import { GLICKO2_SCALE } from '../glicko2.js';
import { runReplay, seriesEvidenceWeight, type ReplayInput, type ReplayGame, type RosterDecayEvent } from '../replay.js';

const config = { phiInitMax: 350 / GLICKO2_SCALE, sigmaDefault: 0.06, marginScale: 15, movWeightCap: 1.5 };

describe('runReplay', () => {
  it('cold-starts every team and league with an initial snapshot', () => {
    const input: ReplayInput = {
      teamIds: ['teamA', 'teamB'],
      leagueIds: ['LCS'],
      games: [],
      decayEvents: [],
      config,
    };
    const result = runReplay(input);
    expect(result.teamHistory).toHaveLength(2);
    for (const snapshot of result.teamHistory) {
      expect(snapshot.reason).toBe('initial');
      expect(snapshot.mu).toBe(0);
      expect(snapshot.phi).toBeCloseTo(config.phiInitMax, 10);
    }
  });

  it('an intra-league game moves the winner up and loser down, and does not touch league meta', () => {
    const games: ReplayGame[] = [
      {
        gameId: 'g1',
        datetimeUtc: '2026-01-15T18:00:00Z',
        team1Id: 'teamA',
        team2Id: 'teamB',
        winnerTeamId: 'teamA',
        team1LeagueId: 'LCS',
        team2LeagueId: 'LCS',
        team1Gold: null,
        team2Gold: null,
        gamelengthSeconds: null,
      },
    ];
    const input: ReplayInput = { teamIds: ['teamA', 'teamB'], leagueIds: ['LCS'], games, decayEvents: [], config };
    const result = runReplay(input);

    const teamAFinal = [...result.teamHistory].reverse().find((s) => s.teamId === 'teamA')!;
    const teamBFinal = [...result.teamHistory].reverse().find((s) => s.teamId === 'teamB')!;
    expect(teamAFinal.mu).toBeGreaterThan(0);
    expect(teamBFinal.mu).toBeLessThan(0);

    // league meta should have no post-initial rows -- no international games occurred.
    const leagueUpdates = result.leagueHistory.filter((h) => h.leagueId === 'LCS');
    expect(leagueUpdates).toHaveLength(1); // just the initial snapshot
  });

  it('an international game moves BOTH the winning team\'s own contextual rating and its league meta', () => {
    // A team winning internationally (HLE at MSI 2026) must gain on its own
    // rating, not only via a league-wide meta bump -- see replay.ts's
    // ownContextualGamesByTeam.
    const games: ReplayGame[] = [
      {
        gameId: 'g1',
        datetimeUtc: '2026-05-01T18:00:00Z',
        team1Id: 'teamA',
        team2Id: 'teamC',
        winnerTeamId: 'teamA',
        team1LeagueId: 'LCS',
        team2LeagueId: 'LCK',
        team1Gold: null,
        team2Gold: null,
        gamelengthSeconds: null,
      },
    ];
    const input: ReplayInput = {
      teamIds: ['teamA', 'teamC'],
      leagueIds: ['LCS', 'LCK'],
      games,
      decayEvents: [],
      config,
    };
    const result = runReplay(input);

    const teamAContextualEntries = result.teamHistory.filter((h) => h.teamId === 'teamA');
    const teamCContextualEntries = result.teamHistory.filter((h) => h.teamId === 'teamC');
    expect(teamAContextualEntries[teamAContextualEntries.length - 1].reason).toBe('game_update');
    expect(teamAContextualEntries[teamAContextualEntries.length - 1].mu).toBeGreaterThan(0); // teamA won -> own rating up
    expect(teamCContextualEntries[teamCContextualEntries.length - 1].mu).toBeLessThan(0); // teamC lost -> own rating down

    const lcsMetaEntries = result.leagueHistory.filter((h) => h.leagueId === 'LCS');
    const lckMetaEntries = result.leagueHistory.filter((h) => h.leagueId === 'LCK');
    expect(lcsMetaEntries.length).toBeGreaterThan(1); // initial + post-game update
    expect(lcsMetaEntries[lcsMetaEntries.length - 1].mu).toBeGreaterThan(0); // LCS won
    expect(lckMetaEntries[lckMetaEntries.length - 1].mu).toBeLessThan(0); // LCK lost
  });

  it('applies a roster-change decay event at the right period', () => {
    const rosterEvent: RosterDecayEvent = {
      kind: 'roster_change',
      teamId: 'teamA',
      effectiveDate: '2026-03-02',
      turnover: 1,
      rosterImpliedMu: 0.5,
    };
    const input: ReplayInput = {
      teamIds: ['teamA'],
      leagueIds: [],
      games: [],
      decayEvents: [rosterEvent],
      config,
    };
    const result = runReplay(input);
    const decayRow = result.teamHistory.find((h) => h.reason === 'roster_decay');
    expect(decayRow).toBeDefined();
    expect(decayRow!.mu).toBeCloseTo(0.5, 10);
    expect(decayRow!.rosterImpliedMu).toBeCloseTo(0.5, 10);
  });

  it('is a pure function: identical input produces identical output', () => {
    const games: ReplayGame[] = [
      {
        gameId: 'g1',
        datetimeUtc: '2026-02-10T18:00:00Z',
        team1Id: 'teamA',
        team2Id: 'teamB',
        winnerTeamId: 'teamB',
        team1LeagueId: 'LCS',
        team2LeagueId: 'LCS',
        team1Gold: 40000,
        team2Gold: 48000,
        gamelengthSeconds: 1900,
      },
    ];
    const input: ReplayInput = { teamIds: ['teamA', 'teamB'], leagueIds: ['LCS'], games, decayEvents: [], config };
    const resultA = runReplay(input);
    const resultB = runReplay(input);
    expect(resultA).toEqual(resultB);
  });

  it('accrues drift across a gap with no games, not just per occupied period', () => {
    // Offseason bug: sortedPeriods holds only occupied periods, so a long gap
    // used to contribute no uncertainty growth.
    const game = (gameId: string, datetimeUtc: string): ReplayGame => ({
      gameId,
      datetimeUtc,
      team1Id: 'teamA',
      team2Id: 'teamB',
      winnerTeamId: 'teamA',
      team1LeagueId: 'LCS',
      team2LeagueId: 'LCS',
      team1Gold: null,
      team2Gold: null,
      gamelengthSeconds: null,
    });

    const base = { teamIds: ['teamA', 'teamB'], leagueIds: ['LCS'], decayEvents: [], config };
    // Same two games, same rating periods occupied -- only the GAP differs.
    const backToBack = runReplay({
      ...base,
      games: [game('g1', '2026-01-05T18:00:00Z'), game('g2', '2026-01-06T18:00:00Z')],
    } as ReplayInput);
    const acrossOffseason = runReplay({
      ...base,
      games: [game('g1', '2026-01-05T18:00:00Z'), game('g2', '2026-03-20T18:00:00Z')],
    } as ReplayInput);

    const lastPhi = (result: ReturnType<typeof runReplay>) =>
      result.teamHistory.filter((s) => s.teamId === 'teamA' && s.reason === 'game_update').at(-1)!.phi;

    // A 74-day layoff must leave the team less certain than a one-day turnaround.
    expect(lastPhi(acrossOffseason)).toBeGreaterThan(lastPhi(backToBack));
  });

  it('accumulates the same total drift regardless of rating-period length', () => {
    // ratingPeriodDays is a free knob: slicing the same span finer must not
    // change accumulated uncertainty.
    const games: ReplayGame[] = [
      {
        gameId: 'g1',
        datetimeUtc: '2026-01-05T18:00:00Z',
        team1Id: 'teamA',
        team2Id: 'teamB',
        winnerTeamId: 'teamA',
        team1LeagueId: 'LCS',
        team2LeagueId: 'LCS',
        team1Gold: null,
        team2Gold: null,
        gamelengthSeconds: null,
      },
      {
        gameId: 'g2',
        datetimeUtc: '2026-02-16T18:00:00Z',
        team1Id: 'teamA',
        team2Id: 'teamB',
        winnerTeamId: 'teamA',
        team1LeagueId: 'LCS',
        team2LeagueId: 'LCS',
        team1Gold: null,
        team2Gold: null,
        gamelengthSeconds: null,
      },
    ];
    const phiFor = (ratingPeriodDays: number) => {
      const result = runReplay({
        teamIds: ['teamA', 'teamB'],
        leagueIds: ['LCS'],
        games,
        decayEvents: [],
        config: { ...config, ratingPeriodDays },
      } as ReplayInput);
      return result.teamHistory.filter((s) => s.teamId === 'teamA' && s.reason === 'game_update').at(-1)!.phi;
    };

    expect(phiFor(1)).toBeCloseTo(phiFor(7), 6);
  });
});

describe('seriesEvidenceWeight', () => {
  it('is a no-op at rho=0 (fully independent observations)', () => {
    expect(seriesEvidenceWeight(3, 0)).toBe(1);
    expect(seriesEvidenceWeight(5, 0)).toBe(1);
  });

  it('collapses a whole series to one observation at rho=1', () => {
    expect(seriesEvidenceWeight(3, 1)).toBeCloseTo(1 / 3, 10);
    expect(seriesEvidenceWeight(5, 1)).toBeCloseTo(1 / 5, 10);
  });

  it('interpolates between those extremes for partial correlation', () => {
    // design effect: 1 / (1 + (n-1)*rho)
    expect(seriesEvidenceWeight(3, 0.5)).toBeCloseTo(1 / 2, 10);
    expect(seriesEvidenceWeight(5, 0.25)).toBeCloseTo(1 / 2, 10);
  });

  it('never down-weights a single-game series', () => {
    expect(seriesEvidenceWeight(1, 1)).toBe(1);
    expect(seriesEvidenceWeight(0, 1)).toBe(1);
  });

  it('is monotonically decreasing in both series length and rho', () => {
    expect(seriesEvidenceWeight(5, 0.5)).toBeLessThan(seriesEvidenceWeight(3, 0.5));
    expect(seriesEvidenceWeight(3, 0.9)).toBeLessThan(seriesEvidenceWeight(3, 0.3));
  });
});

describe('runReplay with an international deviation', () => {
  const init = 75 / GLICKO2_SCALE;
  const deviationConfig = {
    ...config,
    ratingPeriodDays: 1,
    contextualLearnsInternational: false,
    teamInternationalPhiInit: init,
    teamInternationalHalfLifeDays: 365,
    teamInternationalRosterReset: true,
  };
  const game = (id: string, at: string, team1: [string, string], team2: [string, string], extra: Partial<ReplayGame> = {}): ReplayGame => ({
    gameId: id,
    datetimeUtc: at,
    team1Id: team1[0],
    team2Id: team2[0],
    winnerTeamId: team1[0],
    team1LeagueId: team1[1],
    team2LeagueId: team2[1],
    team1Gold: null,
    team2Gold: null,
    gamelengthSeconds: null,
    ...extra,
  });
  const run = (games: ReplayGame[], extraConfig = {}, decayEvents: RosterDecayEvent[] = []) =>
    runReplay({ teamIds: ['A', 'B', 'C', 'D'], leagueIds: ['LCK', 'LCS'], games, decayEvents, config: { ...deviationConfig, ...extraConfig } });
  const lastOf = <T extends { teamId: string }>(rows: T[], teamId: string) => [...rows].reverse().find((r) => r.teamId === teamId)!;

  it('moves the deviation, not contextual, on a cross-region game', () => {
    const result = run([game('g1', '2026-05-01T10:00:00Z', ['A', 'LCK'], ['B', 'LCS'])]);
    expect(result.teamHistory.filter((s) => s.reason === 'game_update')).toEqual([]);
    expect(lastOf(result.teamInternationalHistory!, 'A').mu).toBeGreaterThan(0);
    expect(lastOf(result.teamInternationalHistory!, 'B').mu).toBeLessThan(0);
  });

  it('gives a side from an unknown league no league term, and trains no league from it', () => {
    const result = run([game('g1', '2026-05-01T10:00:00Z', ['A', 'unknown:A'], ['B', 'LCS'])]);
    expect(result.leagueHistory.filter((s) => s.leagueId === 'LCK')).toHaveLength(1);
    expect(result.leagueHistory.filter((s) => s.leagueId === 'LCS')).toHaveLength(2);
  });

  it('halves the deviation over its half-life', () => {
    const result = run(
      [
        game('g1', '2025-05-01T10:00:00Z', ['A', 'LCK'], ['B', 'LCS']),
        game('g2', '2026-05-01T10:00:00Z', ['C', 'LCK'], ['D', 'LCK']),
      ],
      { metaWeight: 0 },
    );
    const afterGame = lastOf(result.teamInternationalHistory!, 'A').mu;
    expect(lastOf(result.combinedHistory!, 'A').mu).toBeCloseTo(afterGame / 2, 10);
  });

  it('clears the deviation on a full roster change', () => {
    const result = run(
      [game('g1', '2026-05-01T10:00:00Z', ['A', 'LCK'], ['B', 'LCS'])],
      {},
      [{ kind: 'roster_change', teamId: 'A', effectiveDate: '2026-06-01', turnover: 1, rosterImpliedMu: 0 }],
    );
    expect(lastOf(result.teamInternationalHistory!, 'A')).toMatchObject({ reason: 'roster_decay', mu: 0 });
  });

  it('weights a play-in game by playInWeight', () => {
    const playIn = [game('g1', '2026-05-01T10:00:00Z', ['A', 'LCK'], ['B', 'LCS'], { playIn: true })];
    const full = lastOf(run(playIn).teamInternationalHistory!, 'A').mu;
    const quarter = lastOf(run(playIn, { playInWeight: 0.25 }).teamInternationalHistory!, 'A').mu;
    expect(quarter).toBeGreaterThan(0);
    expect(quarter).toBeLessThan(full);
  });

  it('builds the combined RD from contextual as last recorded, not as drifted while idle', () => {
    const result = run(
      [
        game('g1', '2025-05-01T10:00:00Z', ['C', 'LCK'], ['B', 'LCK']),
        game('g2', '2026-05-01T10:00:00Z', ['A', 'LCK'], ['B', 'LCK']),
      ],
      { metaWeight: 0 },
    );
    const recorded = lastOf(result.teamHistory, 'C');
    expect(lastOf(result.combinedHistory!, 'C').phi).toBeCloseTo(Math.hypot(recorded.phi, init), 10);
  });
});
