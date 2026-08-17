import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchMatches, RETRY_DELAYS_MS, type RateLimitState } from '../liquipediaApi.js';

/**
 * The 429 retry loop, end to end. Only the delay maths was covered before; the
 * loop itself could not be, because the budget file was a fixed path in the
 * working copy -- a test would have spent the desktop's real allowance and
 * could have hard-blocked it for an hour. LIQUIPEDIA_RATE_LIMIT_FILE moves it.
 *
 * Timers are faked: the real backoff is 1/3/7 minutes.
 */
describe('liquipediaGet 429 handling', () => {
  let dir: string;
  let stateFile: string;

  const response = (status: number, body: unknown = { result: [] }) =>
    ({ status, ok: status >= 200 && status < 300, json: async () => body }) as Response;

  const readState = (): RateLimitState => JSON.parse(readFileSync(stateFile, 'utf8'));

  /**
   * Runs `work` while draining every pending backoff, so nothing waits in real
   * time. Both outcomes are captured immediately rather than chained off, or a
   * rejection surfaces as an unhandled error while the timers are still being
   * advanced and vitest fails the run around passing tests.
   */
  async function withTimersDrained<T>(work: Promise<T>): Promise<T> {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
    work.then(
      (value) => (outcome = { ok: true, value }),
      (error) => (outcome = { ok: false, error }),
    );
    while (outcome === undefined) {
      await vi.advanceTimersByTimeAsync(60_000);
    }
    if (outcome.ok) return outcome.value;
    throw outcome.error;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'liquipedia-rate-'));
    stateFile = join(dir, 'budget.json');
    vi.stubEnv('LIQUIPEDIA_RATE_LIMIT_FILE', stateFile);
    vi.stubEnv('LIQUIPEDIA_API_KEY', 'test-key');
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes its budget to the overridden path, never the working copy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(200)));

    await withTimersDrained(fetchMatches('[[series::LEC]]'));

    expect(existsSync(stateFile)).toBe(true);
    expect(readState().requestTimestampsByEndpoint['v3/match']).toHaveLength(1);
  });

  it('retries a 429 and succeeds, rather than failing the whole pull on one refusal', async () => {
    // The bug this exists for: one 429 used to hard-block the endpoint, so the
    // remaining nine series failed instantly and the day's pull was lost.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(429))
      .mockResolvedValueOnce(response(200, { result: [{ match2id: 'x' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const rows = await withTimersDrained(fetchMatches('[[series::LEC]]'));

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(rows).toHaveLength(1);
    // A success must leave no hard block behind, or the next series fails for free.
    expect(readState().blockedUntilByEndpoint['v3/match']).toBeUndefined();
  });

  it('hard-blocks the endpoint only after every attempt is spent', async () => {
    const attempts = RETRY_DELAYS_MS.length + 1;
    const fetchMock = vi.fn(async () => response(429));
    vi.stubGlobal('fetch', fetchMock);

    await expect(withTimersDrained(fetchMatches('[[series::LEC]]'))).rejects.toThrow(
      new RegExp(`429 on ${attempts} attempts`),
    );

    expect(fetchMock).toHaveBeenCalledTimes(attempts);
    const blockedUntil = readState().blockedUntilByEndpoint['v3/match'];
    expect(blockedUntil).toBeGreaterThan(Date.now());
  });

  it('refuses to call again while the hard block stands', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(429)));
    await expect(withTimersDrained(fetchMatches('[[series::LEC]]'))).rejects.toThrow();

    // The cascade is deliberate once the retries are genuinely spent: the point
    // is to stop hammering an endpoint that has just refused us four times.
    const second = vi.fn(async () => response(200));
    vi.stubGlobal('fetch', second);
    await expect(withTimersDrained(fetchMatches('[[series::LCS]]'))).rejects.toThrow(/hard-blocked/);
    expect(second).not.toHaveBeenCalled();
  });

  it('counts a refused request against the budget, so a 429 storm cannot spend it all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(429)));
    await expect(withTimersDrained(fetchMatches('[[series::LEC]]'))).rejects.toThrow();

    expect(readState().requestTimestampsByEndpoint['v3/match']).toHaveLength(RETRY_DELAYS_MS.length + 1);
  });

  it('does not retry a non-429 failure', async () => {
    // Only a 429 is transient. Retrying a 500 four times wastes the budget.
    const fetchMock = vi.fn(async () => response(503));
    vi.stubGlobal('fetch', fetchMock);

    await expect(withTimersDrained(fetchMatches('[[series::LEC]]'))).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(readState().blockedUntilByEndpoint['v3/match']).toBeUndefined();
  });
});
