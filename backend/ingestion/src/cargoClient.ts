/**
 * Thin client for Leaguepedia's Cargo API (MediaWiki API on lol.fandom.com).
 * Cargo doesn't handle complex joins well and caps ~500 rows/query, so callers
 * query one table at a time and correlate results in application code via the
 * shared OverviewPage key -- see plan's "Ingestion pipeline" section.
 *
 * Leaguepedia's actual documented limit (confirmed via
 * action=query&meta=userinfo&uiprop=ratelimits): cargo-query is capped at
 * 5 requests per 60 seconds per IP for anonymous callers. A 200 OK with a
 * JSON {error:{code:"ratelimited"}} body is returned on overage, not a 429 --
 * so every request is self-throttled well under that, and rate-limit/
 * transient-error responses are retried with backoff as a safety net.
 */

const CARGO_ENDPOINT = 'https://lol.fandom.com/api.php';
const USER_AGENT = 'PowerRanking/0.1 (LoL esports power-ranking project; contact via GitHub repo)';
const DEFAULT_PAGE_SIZE = 500;
// 5 req/60s allowed; space requests at 60s/4 = 15s to stay comfortably under it.
const MIN_REQUEST_SPACING_MS = 15000;
const MAX_RETRIES = 5;

export interface CargoQueryOptions {
  tables: string;
  fields: string;
  where?: string;
  orderBy?: string;
  joinOn?: string;
  limit?: number;
  offset?: number;
}

export function buildCargoQueryUrl(options: CargoQueryOptions): string {
  const params = new URLSearchParams({
    action: 'cargoquery',
    format: 'json',
    tables: options.tables,
    fields: options.fields,
    limit: String(options.limit ?? DEFAULT_PAGE_SIZE),
    offset: String(options.offset ?? 0),
  });
  if (options.where) params.set('where', options.where);
  if (options.orderBy) params.set('order_by', options.orderBy);
  if (options.joinOn) params.set('join_on', options.joinOn);
  return `${CARGO_ENDPOINT}?${params.toString()}`;
}

interface CargoQueryResponse<T> {
  cargoquery?: { title: T }[];
  error?: { code: string; info: string };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Module-level so spacing is enforced across all callers sharing this process,
// not just within a single cargoQueryAll loop.
let lastRequestAt = 0;

async function throttle(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt;
  if (elapsed < MIN_REQUEST_SPACING_MS) {
    await sleep(MIN_REQUEST_SPACING_MS - elapsed);
  }
  lastRequestAt = Date.now();
}

async function cargoQueryPage<T>(options: CargoQueryOptions): Promise<T[]> {
  const url = buildCargoQueryUrl(options);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
    const json = (await res.json()) as CargoQueryResponse<T>;

    const isRateLimited = json.error?.code === 'ratelimited' || res.status === 429 || res.status === 503;
    if (isRateLimited) {
      if (attempt === MAX_RETRIES) {
        throw new Error(`Cargo query rate-limited after ${MAX_RETRIES} retries (${url})`);
      }
      const backoffMs = MIN_REQUEST_SPACING_MS * 2 ** attempt + Math.random() * 500;
      await sleep(backoffMs);
      continue;
    }

    if (json.error) {
      throw new Error(`Cargo query error: ${json.error.code} - ${json.error.info} (${url})`);
    }
    if (!res.ok) {
      throw new Error(`Cargo query failed: ${res.status} ${res.statusText} (${url})`);
    }

    return (json.cargoquery ?? []).map((row) => row.title);
  }

  // Unreachable, but keeps TS happy about a guaranteed return.
  throw new Error(`Cargo query failed unexpectedly (${url})`);
}

/** Pages through offset/limit until a short page signals the end. */
export async function cargoQueryAll<T>(options: CargoQueryOptions): Promise<T[]> {
  const pageSize = options.limit ?? DEFAULT_PAGE_SIZE;
  let offset = options.offset ?? 0;
  const results: T[] = [];

  for (;;) {
    const page = await cargoQueryPage<T>({ ...options, limit: pageSize, offset });
    results.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  return results;
}
