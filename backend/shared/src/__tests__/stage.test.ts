import { describe, it, expect } from 'vitest';
import {
  stageKind,
  isPlayoffSection,
  isPlayoffSeries,
  resolveBoardAdvance,
  STAGE_STALL_DAYS,
  type StageStatus,
} from '../stage.js';

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
const stage = (
  bracketId: string | null,
  lastPlayedDay: string | null,
  unplayedSeries = 0,
  previousPlayedDay: string | null = null,
): StageStatus => ({
  leagueId: LCK,
  bracketId,
  lastPlayedDay,
  previousPlayedDay,
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
        { leagueId: LEC, bracketId: 'LEC26SumW3', lastPlayedDay: '2026-08-10', previousPlayedDay: null, unplayedSeries: 0 },
        { leagueId: LEC, bracketId: 'LEC26SumW4', lastPlayedDay: '2026-08-15', previousPlayedDay: null, unplayedSeries: 4 },
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

describe('bracket carets', () => {
  it('measures from the previous day inside the bracket, not the previous stage', () => {
    // Every series of a playoff shares one bracket id, so taking the previous
    // stage would compare across the whole run -- LCP's semifinal stage alone
    // spans three days, and brackets reach 28.
    const [advance] = resolveBoardAdvance(
      [stage('LCP26SFSR5', '2026-08-13'), stage('LCP26SFSSe', '2026-08-16', 0, '2026-08-15')],
      '2026-08-17',
    );
    expect(advance.reason).toBe('bracket');
    expect(advance.asOfDate).toBe('2026-08-16');
    expect(advance.previousAsOfDate).toBe('2026-08-15');
    expect(advance.previousStage).toBe('LCP26SFSSe');
  });

  it('falls back to the previous stage on a bracket opening day', () => {
    const [advance] = resolveBoardAdvance(
      [stage('LCP26SFSR5', '2026-08-13'), stage('LCP26SFSSe', '2026-08-14')],
      '2026-08-15',
    );
    expect(advance.previousAsOfDate).toBe('2026-08-13');
    expect(advance.previousStage).toBe('LCP26SFSR5');
  });

  it('leaves regular-season carets on the stage boundary', () => {
    // Only brackets step within a stage; a week must still compare whole.
    const [advance] = resolveBoardAdvance(
      [stage('LCK26Sp3W2', '2026-08-09'), stage('LCK26Sp3W3', '2026-08-16', 0, '2026-08-15')],
      '2026-08-17',
    );
    expect(advance.previousAsOfDate).toBe('2026-08-09');
  });

  it('orders two stages ending the same day toward the bracket', () => {
    // A regular season's last game and its first bracket series routinely share
    // a date; which counted as current used to be arbitrary.
    const [advance] = resolveBoardAdvance(
      [stage('LCK26Sp3W3', '2026-08-16', 2), stage('LCKCup26PO', '2026-08-16')],
      '2026-08-17',
    );
    expect(advance.reason).toBe('bracket');
    expect(advance.stage).toBe('LCKCup26PO');
  });
});

describe('isPlayoffSection', () => {
  // Liquipedia's own wording, confirmed against v3/match: LCKCup26PO reads
  // "Playoffs", LCKCup26PI "Play-In", LCKCup26W2 "Week 2".
  it('recognises knockout play however the event words it', () => {
    for (const name of [
      'Playoffs',
      'Playoffs - Bracket Stage',
      'Knockout Stage',
      'Finals',
      'Season Finals',
      'Regional Finals',
      'Grand Final',
      'Semifinals',
      'Quarterfinals',
      'Bracket Stage',
    ]) {
      expect(isPlayoffSection(name), name).toBe(true);
    }
  });

  it('calls regular season play not a playoff', () => {
    for (const name of ['Week 1', 'Week 9', 'Week 03', 'Regular Season']) {
      expect(isPlayoffSection(name), name).toBe(false);
    }
  });

  it('does not call a play-in, tiebreaker or promotion a playoff', () => {
    // Decisive, but not the playoff -- and "Play-In" would otherwise fall
    // through to unknown, while a tiebreaker sits inside the regular season.
    for (const name of ['Play-In', 'Play In', 'Play-In Stage', 'Tiebreaker', 'Promotion']) {
      expect(isPlayoffSection(name), name).toBe(false);
    }
  });

  it('says "unknown" rather than guessing', () => {
    // Swiss rounds and group stages are neither, and nothing is drawn for them.
    for (const name of ['Group Stage', 'Swiss Stage', 'Entry Stage', '']) {
      expect(isPlayoffSection(name), name).toBeNull();
    }
    expect(isPlayoffSection(null)).toBeNull();
    expect(isPlayoffSection(undefined)).toBeNull();
  });

  it('is case-insensitive, since the wording is Liquipedia editors, not an enum', () => {
    expect(isPlayoffSection('PLAYOFFS')).toBe(true);
    expect(isPlayoffSection('playoffs')).toBe(true);
    expect(isPlayoffSection('week 4')).toBe(false);
  });

  it('reads the stages the bracket-id rule got wrong, which is why it replaced it', () => {
    // LCK Road to MSI IS the spring playoff but is spelled LCKRtMSI26; LCS
    // Lock-In's group stages matched no pattern and were painted as playoffs;
    // LPL 2024 Spring's playoff id is opaque (tl2OVsUfyX). All three are
    // unambiguous in words.
    expect(isPlayoffSection('Playoffs')).toBe(true);
    expect(isPlayoffSection('Group Stage')).toBeNull();
    expect(isPlayoffSection('Week 2')).toBe(false);
  });
});

describe('isPlayoffSeries', () => {
  it('takes the section when it is decisive, whatever the id says', () => {
    // LCS Lock-In: the id looks like nothing, the words are clear.
    expect(isPlayoffSeries('Playoffs', 'LCS26LINPO')).toBe(true);
    expect(isPlayoffSeries('Week 2', 'LCKCup26W2')).toBe(false);
    expect(isPlayoffSeries('Play-In', 'LCKCup26PI')).toBe(false);
  });

  it('falls back to the id where the section says nothing', () => {
    // 69 series are sectioned "Results". These are the ones hiding behind it.
    expect(isPlayoffSeries('Results', 'LCKRtMSI26')).toBe(true);
    expect(isPlayoffSeries('Results', 'LCKRtMSI25')).toBe(true);
    expect(isPlayoffSeries('Results', 'LCK2024RFB')).toBe(true);
    expect(isPlayoffSeries('Results', 'LPL2025RFB')).toBe(true);
    expect(isPlayoffSeries('Results', 'LEC24Final')).toBe(true);
    expect(isPlayoffSeries('Results', 'LCP25S1POB')).toBe(true);
  });

  it('leaves LTA 2025 unknown, which is the recorded decision', () => {
    // Split 1's id covers a whole split; Split 2's playoff would need a pattern
    // that also catches it. Deliberately not drawn.
    for (const id of ['LTANth25S1', 'LTASth25S1', 'LTANth25S2', 'LTASth25S2']) {
      expect(isPlayoffSeries('Results', id), id).toBeNull();
    }
  });

  it('never guesses a playoff from an unrecognised id', () => {
    // The old rule read "unrecognised" as bracket play and invented playoffs.
    for (const id of ['LCS26LIN2H', 'LCS26LIN3M', 'LCS26LINR1', 'Tp3f1vvFcF', 'tl2OVsUfyX']) {
      expect(isPlayoffSeries(null, id), id).toBeNull();
    }
  });

  it('is null when we know nothing at all', () => {
    expect(isPlayoffSeries(null, null)).toBeNull();
    expect(isPlayoffSeries('', '')).toBeNull();
  });
});
