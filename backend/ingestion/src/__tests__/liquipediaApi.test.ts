import { describe, it, expect } from 'vitest';
import {
  checkCanCall,
  retryDelayMs,
  REQUESTS_PER_HOUR,
  RETRY_DELAYS_MS,
  teamLogoUrl,
  WINDOW_MS,
  type RateLimitState,
} from '../liquipediaApi.js';

function emptyState(): RateLimitState {
  return { requestTimestampsByEndpoint: {}, blockedUntilByEndpoint: {} };
}

describe('checkCanCall', () => {
  it('allows a call with no prior history', () => {
    const result = checkCanCall(emptyState(), 'v3/team', Date.now());
    expect(result.allowed).toBe(true);
  });

  it('blocks once the sliding-window budget is exhausted', () => {
    const now = Date.now();
    const state = emptyState();
    state.requestTimestampsByEndpoint['v3/squadplayer'] = Array.from({ length: REQUESTS_PER_HOUR }, (_, i) => now - i * 1000);

    const result = checkCanCall(state, 'v3/squadplayer', now);
    expect(result.allowed).toBe(false);
  });

  it('does not count requests that have aged out of the window', () => {
    const now = Date.now();
    const state = emptyState();
    // All of these are older than the window -- should not count against the budget.
    state.requestTimestampsByEndpoint['v3/team'] = Array.from({ length: REQUESTS_PER_HOUR }, () => now - WINDOW_MS - 1000);

    const result = checkCanCall(state, 'v3/team', now);
    expect(result.allowed).toBe(true);
  });

  it('respects an explicit hard block regardless of request count', () => {
    const now = Date.now();
    const state = emptyState();
    state.blockedUntilByEndpoint['v3/squadplayer'] = now + 30 * 60 * 1000; // 30 min from now

    const result = checkCanCall(state, 'v3/squadplayer', now);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toContain('hard-blocked');
  });

  it('allows calls again once a hard block has expired', () => {
    const now = Date.now();
    const state = emptyState();
    state.blockedUntilByEndpoint['v3/squadplayer'] = now - 1000; // expired 1s ago

    const result = checkCanCall(state, 'v3/squadplayer', now);
    expect(result.allowed).toBe(true);
  });

  it('tracks endpoints independently -- a block on one does not affect another', () => {
    const now = Date.now();
    const state = emptyState();
    state.blockedUntilByEndpoint['v3/squadplayer'] = now + 30 * 60 * 1000;

    const result = checkCanCall(state, 'v3/team', now);
    expect(result.allowed).toBe(true);
  });
});

describe('retryDelayMs', () => {
  it('grows with each attempt', () => {
    const mid = () => 0.5;
    const delays = RETRY_DELAYS_MS.map((_, i) => retryDelayMs(i, mid));
    expect(delays).toEqual([...delays].sort((a, b) => a - b));
    expect(new Set(delays).size).toBe(delays.length);
  });

  it('stays within +/-20% of the nominal delay', () => {
    for (const [i, base] of RETRY_DELAYS_MS.entries()) {
      expect(retryDelayMs(i, () => 0)).toBe(Math.round(base * 0.8));
      expect(retryDelayMs(i, () => 1)).toBe(Math.round(base * 1.2));
    }
  });

  it('returns 0 past the last attempt, so an exhausted retry cannot sleep', () => {
    expect(retryDelayMs(RETRY_DELAYS_MS.length, () => 0.5)).toBe(0);
    expect(retryDelayMs(99, () => 0.5)).toBe(0);
  });

  // The scheduled job's timeout is 30 min; every attempt sleeping its longest
  // must still leave room for the pull itself.
  it('cannot outlast the workflow timeout', () => {
    const worst = RETRY_DELAYS_MS.reduce((sum, _, i) => sum + retryDelayMs(i, () => 1), 0);
    expect(worst).toBeLessThan(15 * 60 * 1000);
  });
});

describe('teamLogoUrl', () => {
  it('prefers the dark variant, which is what a dark board wants', () => {
    expect(teamLogoUrl({ logourl: 'light.png', logodarkurl: 'dark.png' })).toBe('dark.png');
  });

  it('falls back to the light one, which most teams repeat anyway', () => {
    expect(teamLogoUrl({ logourl: 'light.png', logodarkurl: '' })).toBe('light.png');
  });

  // The API returns '' rather than null for a team with no logo, and an empty
  // string reaching the frontend renders a broken image rather than the crest.
  it('is null when the wiki holds no logo at all', () => {
    expect(teamLogoUrl({ logourl: '', logodarkurl: '' })).toBeNull();
    expect(teamLogoUrl({ logourl: '   ', logodarkurl: '  ' })).toBeNull();
  });
});
