import { describe, expect, it } from 'vitest';
import { ALL_SERIES, isTotalPullFailure, resolvePullStart } from '../dailyUpdate.js';

describe('resolvePullStart', () => {
  it('starts a day before the frontier when nothing is outstanding', () => {
    expect(resolvePullStart('2026-08-17', null)).toBe('2026-08-16');
  });

  it('reaches back to a decided series still missing its games', () => {
    // The 2026-08-16 stranding: LEC played the 17th and moved the frontier past
    // five LCS/LPL series whose games were held for stat lines.
    expect(resolvePullStart('2026-08-17', '2026-08-16')).toBe('2026-08-15');
  });

  it('clamps a pending series that never fills in', () => {
    expect(resolvePullStart('2026-08-17', '2025-01-01')).toBe('2026-08-02');
  });

  it('ignores a pending series newer than the frontier', () => {
    expect(resolvePullStart('2026-08-17', '2026-08-20')).toBe('2026-08-16');
  });

  it('crosses a month boundary in UTC', () => {
    expect(resolvePullStart('2026-09-01', null)).toBe('2026-08-31');
  });

  it('covers a match held back at the widest the frontier can run ahead', () => {
    // Worst case: a game on D waits out STATS_GRACE_DAYS while other leagues
    // play on, so the first run that may ingest it sees a frontier of D+3.
    const played = '2026-08-16';
    expect(resolvePullStart('2026-08-19', played) < played).toBe(true);
  });
});

describe('isTotalPullFailure', () => {
  it('stays quiet for a clean run', () => {
    expect(isTotalPullFailure([], ALL_SERIES)).toBe(false);
  });

  it('stays quiet for a partial pull, which the next run reaches back for', () => {
    expect(isTotalPullFailure(['LCS'], ALL_SERIES)).toBe(false);
    expect(isTotalPullFailure(ALL_SERIES.slice(1), ALL_SERIES)).toBe(false);
  });

  it('reports the blackout that a hard block produces', () => {
    // 2026-08-26: four attempts spent on 429s, then every remaining series
    // refused by our own limiter for the hour.
    expect(isTotalPullFailure(ALL_SERIES, ALL_SERIES)).toBe(true);
  });

  it('never reports success as failure when there was nothing to attempt', () => {
    expect(isTotalPullFailure([], [])).toBe(false);
  });
});
