import { describe, it, expect } from 'vitest';
import { checkCanCall, REQUESTS_PER_HOUR, WINDOW_MS, type RateLimitState } from '../liquipediaApi.js';

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
