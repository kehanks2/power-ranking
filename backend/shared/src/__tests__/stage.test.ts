import { describe, it, expect } from 'vitest';
import { stageKind, resolveBoardAdvance, STAGE_STALL_DAYS, type StageStatus } from '../stage.js';

// Every distinct stage marker held for 2026, so a pattern change has to face
// the real vocabulary rather than invented examples.
const REGULAR_SEASON = [
  'LCK26Sp2W1', 'LCK26Sp2W9', 'LCK26Sp3W3', 'LCKCup26W1',
  'LEC26SprW7', 'LEC26SumW4', 'LEC26VsW01', 'LEC26VsW04',
  'LCS26SPRW7', 'LCS26SumW1', 'CBL26CupW3',
  'LPL26S1RS4', '26LPLS2RS7', '26LPLS3RS1',
  'LCP26S1RS1', 'LCP26S2RS7',
  'CBLOL26S11', 'CBLOL26S17', 'CBLOL26S25',
];

const BRACKET = [
  'LCKCup26PI', 'LCKCup26PO', 'LCKRtMSI26',
  'LEC26SprPO', 'LEC26VsPOB',
  'LCS26SPRPO', 'LCS26LINPO', 'LCS26LINR1', 'LCS26LIN2H', 'LCS26LIN3M',
  'LPL26S1KnO', 'LPL26S1KnR', '26LPLS2KOS', 'LPL26S1RST',
  'CBL26Entry', 'CBLOL26Cup', 'CBLOL26E1P',
  'LCP26S1POB', 'LCP26Sp2PO', 'LCP26SFSR1', 'LCP26SFS3M', 'LCP26SFSSe',
  'Tp3f1vvFcF', 'H9wqfyzALm',
];

describe('stageKind', () => {
  it('recognises every regular-season marker seen in 2026', () => {
    for (const id of REGULAR_SEASON) expect(stageKind(id), id).toBe('regular');
  });

  it('treats brackets, play-ins, tiebreakers and opaque ids as bracket play', () => {
    for (const id of BRACKET) expect(stageKind(id), id).toBe('bracket');
  });

  it('falls back to bracket play for a missing marker', () => {
    // Series predating migration 0016 keep the old per-game-day behaviour
    // rather than pinning a board to a stage it has no marker for.
    expect(stageKind(null)).toBe('bracket');
    expect(stageKind(undefined)).toBe('bracket');
    expect(stageKind('')).toBe('bracket');
  });

  it('does not mistake a playoff marker ending in a digit for a week', () => {
    // The failure that matters: reading a bracket as a week would freeze the
    // board until the whole playoff finished.
    expect(stageKind('LCS26LIN2H')).toBe('bracket');
    expect(stageKind('LCP26SFS4L')).toBe('bracket');
    expect(stageKind('LCKCup26PO')).toBe('bracket');
  });

  it('holds the stall window below the worst measured regular-season gap', () => {
    // 82 stages in 2026 across all six leagues, worst intra-stage gap 1 day.
    expect(STAGE_STALL_DAYS).toBeGreaterThan(1);
  });
});

const LCK = 1;
const stage = (bracketId: string | null, lastPlayedDay: string | null, unplayedSeries = 0): StageStatus => ({
  leagueId: LCK,
  bracketId,
  lastPlayedDay,
  unplayedSeries,
});

describe('resolveBoardAdvance', () => {
  it('holds a part-played week at the previous stage', () => {
    // The churn this whole mechanism exists to remove: Saturday's results are
    // in, Sunday's are not, and the board must not move on half a round.
    const [advance] = resolveBoardAdvance(
      [stage('LCK26Sp3W2', '2026-08-09'), stage('LCK26Sp3W3', '2026-08-15', 2)],
      '2026-08-16',
    );
    expect(advance.reason).toBe('holding');
    expect(advance.asOfDate).toBe('2026-08-09');
    expect(advance.stage).toBe('LCK26Sp3W2');
  });

  it('advances once the week owes nothing', () => {
    const [advance] = resolveBoardAdvance(
      [stage('LCK26Sp3W2', '2026-08-09'), stage('LCK26Sp3W3', '2026-08-15', 0)],
      '2026-08-16',
    );
    expect(advance.reason).toBe('stage-complete');
    expect(advance.asOfDate).toBe('2026-08-15');
  });

  it('advances per series during bracket play', () => {
    const [advance] = resolveBoardAdvance(
      [stage('LCK26Sp3W3', '2026-08-15'), stage('LCKCup26PO', '2026-08-16', 3)],
      '2026-08-16',
    );
    expect(advance.reason).toBe('bracket');
    expect(advance.asOfDate).toBe('2026-08-16');
  });

  it('releases a stalled week rather than freezing the board', () => {
    // A postponed fixture, or a schedule we have wrong. Fires only once the
    // stage has been quiet longer than any real week ever goes.
    const rows = [stage('LCK26Sp3W2', '2026-08-09'), stage('LCK26Sp3W3', '2026-08-13', 1)];
    expect(resolveBoardAdvance(rows, '2026-08-14')[0].reason).toBe('holding');
    const stalled = resolveBoardAdvance(rows, `2026-08-${13 + STAGE_STALL_DAYS}`)[0];
    expect(stalled.reason).toBe('stage-stalled');
    expect(stalled.asOfDate).toBe('2026-08-13');
  });

  it('keeps each league on its own clock', () => {
    const LEC = 2;
    const advances = resolveBoardAdvance(
      [
        stage('LCK26Sp3W3', '2026-08-15', 0),
        { leagueId: LEC, bracketId: 'LEC26SumW3', lastPlayedDay: '2026-08-10', unplayedSeries: 0 },
        { leagueId: LEC, bracketId: 'LEC26SumW4', lastPlayedDay: '2026-08-15', unplayedSeries: 4 },
      ],
      '2026-08-16',
    );
    expect(advances.find((a) => a.leagueId === LCK)).toMatchObject({ asOfDate: '2026-08-15', reason: 'stage-complete' });
    expect(advances.find((a) => a.leagueId === LEC)).toMatchObject({ asOfDate: '2026-08-10', reason: 'holding' });
  });

  it('reports no-data rather than guessing when nothing is showable', () => {
    expect(resolveBoardAdvance([stage('LCK26Sp3W1', null, 5)], '2026-08-16')[0].reason).toBe('no-data');
    expect(resolveBoardAdvance([stage('LCK26Sp3W1', '2026-08-15', 2)], '2026-08-16')[0]).toMatchObject({
      asOfDate: null,
      reason: 'no-data',
    });
  });
});

describe('resolveBoardAdvance previous stage', () => {
  const weeks = [
    stage('LCK26Sp3W1', '2026-08-02'),
    stage('LCK26Sp3W2', '2026-08-09'),
    stage('LCK26Sp3W3', '2026-08-16'),
  ];

  it('measures from the previous stage boundary, not from mid-week', () => {
    // The caret must compare the end of one week with the end of the last, or
    // it reintroduces the half-round comparison at one remove.
    const [advance] = resolveBoardAdvance(weeks, '2026-08-17');
    expect(advance.asOfDate).toBe('2026-08-16');
    expect(advance.previousAsOfDate).toBe('2026-08-09');
  });

  it('steps the baseline back too while holding', () => {
    const holding = [weeks[0], weeks[1], stage('LCK26Sp3W3', '2026-08-16', 2)];
    const [advance] = resolveBoardAdvance(holding, '2026-08-17');
    expect(advance.reason).toBe('holding');
    expect(advance.asOfDate).toBe('2026-08-09');
    expect(advance.previousAsOfDate).toBe('2026-08-02');
  });

  it('has no baseline for the first stage on record', () => {
    const [advance] = resolveBoardAdvance([weeks[0]], '2026-08-03');
    expect(advance.asOfDate).toBe('2026-08-02');
    expect(advance.previousAsOfDate).toBeNull();
  });
});
