/**
 * Client for Liquipedia's LiquipediaDB API v3 (https://api.liquipedia.net/api/v3).
 * Used as the authoritative source for CURRENT roster data -- see
 * populateRosterFromLiquipedia.ts for why this replaced the OE-lineup-derived
 * heuristic entirely: it independently confirms real "shared role" rosters
 * (e.g. Cloud9 running two players at MID) that a starter/substitute-only
 * model can't represent.
 *
 * Rate limit, per Liquipedia's published API Terms of Use: 60 requests/hour
 * for the LiquipediaDB API (v3 endpoints here). Confirmed the hard way this
 * session that a naive one-request-per-team loop blows through that in
 * minutes, and that an in-memory-only limiter is not good enough: every
 * fresh `tsx` process starts a NEW empty counter with zero memory of
 * requests a prior run already made, so it can walk straight into a window
 * Liquipedia's own server-side counter still considers exhausted. State here
 * is persisted to disk (RATE_LIMIT_STATE_FILE) specifically so that doesn't
 * happen again. On top of the sliding-window estimate, any endpoint that
 * actually receives a 429 gets a hard one-hour block from that moment,
 * because we've seen the estimate be wrong -- trust their explicit signal
 * over our own math. There is deliberately NO auto-retry on 429 anywhere in
 * this file: a retry loop still issues real requests against an endpoint
 * that just said stop, which made things worse in practice, not better.
 *
 * Also per their terms for this key: don't scrape (use documented
 * conditions/query filtering, which this client does), query BROADLY and
 * paginate instead of looping per team/player/game (every call site here
 * does this), re-use the HTTP client/connection (fetch's default keep-alive
 * agent handles this), accept gzip, use a descriptive User-Agent, credit
 * Liquipedia for the data (see frontend attribution), and keep this project
 * open source.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE_URL = 'https://api.liquipedia.net/api';
const WIKI = 'leagueoflegends';
const USER_AGENT = 'PowerRankingApp/1.0 (local research project; not yet publicly hosted)';
const MAX_RESULT_LIMIT = 1000; // documented per-request max

function apiKey(): string {
  const key = process.env.LIQUIPEDIA_API_KEY;
  if (!key) throw new Error('LIQUIPEDIA_API_KEY is not set');
  return key;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Repo root (this file is backend/ingestion/src/liquipediaApi.ts).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const RATE_LIMIT_STATE_FILE = join(REPO_ROOT, '.liquipedia-rate-limit.json');

export interface RateLimitState {
  requestTimestampsByEndpoint: Record<string, number[]>;
  blockedUntilByEndpoint: Record<string, number>;
}

function loadState(): RateLimitState {
  if (!existsSync(RATE_LIMIT_STATE_FILE)) {
    return { requestTimestampsByEndpoint: {}, blockedUntilByEndpoint: {} };
  }
  try {
    return JSON.parse(readFileSync(RATE_LIMIT_STATE_FILE, 'utf8'));
  } catch {
    return { requestTimestampsByEndpoint: {}, blockedUntilByEndpoint: {} };
  }
}

function saveState(state: RateLimitState): void {
  writeFileSync(RATE_LIMIT_STATE_FILE, JSON.stringify(state, null, 2));
}

// 60/hour is their documented ceiling; kept well under it for real margin,
// since our own count and their server-side count have already disagreed
// once this session.
export const REQUESTS_PER_HOUR = 40;
export const WINDOW_MS = 60 * 60 * 1000;

export type CallCheck = { allowed: true } | { allowed: false; reason: string };

/**
 * Pure decision function -- no I/O, no Date.now() side effects, so it's
 * directly unit-testable. Two independent gates: an explicit hard block
 * (set the moment we've actually seen a 429 -- trusted over our own count)
 * and the sliding-window request budget.
 */
export function checkCanCall(state: RateLimitState, endpoint: string, now: number): CallCheck {
  const blockedUntil = state.blockedUntilByEndpoint[endpoint];
  if (blockedUntil && now < blockedUntil) {
    const minsLeft = Math.ceil((blockedUntil - now) / 60000);
    return { allowed: false, reason: `hard-blocked for another ~${minsLeft} min (hit a real 429 recently)` };
  }

  const timestamps = state.requestTimestampsByEndpoint[endpoint] ?? [];
  const recent = timestamps.filter((t) => now - t < WINDOW_MS);
  if (recent.length >= REQUESTS_PER_HOUR) {
    const oldestInWindow = recent[0];
    const waitMins = Math.ceil((WINDOW_MS - (now - oldestInWindow)) / 60000);
    return { allowed: false, reason: `used ${recent.length}/${REQUESTS_PER_HOUR} of its budget this hour, wait ~${waitMins} min` };
  }

  return { allowed: true };
}

/** Throws if this endpoint isn't safe to call right now -- never silently waits out a long block. */
function assertCanCall(endpoint: string): void {
  const check = checkCanCall(loadState(), endpoint, Date.now());
  if (!check.allowed) {
    throw new Error(`Liquipedia API ${endpoint}: ${check.reason}. Not calling.`);
  }
}

function recordRequest(endpoint: string): void {
  const state = loadState();
  const now = Date.now();
  const timestamps = state.requestTimestampsByEndpoint[endpoint] ?? [];
  state.requestTimestampsByEndpoint[endpoint] = [...timestamps.filter((t) => now - t < WINDOW_MS), now];
  saveState(state);
}

function recordHardBlock(endpoint: string): void {
  const state = loadState();
  state.blockedUntilByEndpoint[endpoint] = Date.now() + WINDOW_MS;
  saveState(state);
}

/**
 * Deliberately NO auto-retry on 429 -- see module doc. Also deliberately
 * fails FAST (assertCanCall throws synchronously) rather than sleeping
 * through a wait internally, so a caller/script never silently blocks for
 * up to an hour without the person running it knowing that's what's
 * happening.
 */
async function liquipediaGet<T>(endpoint: string, params: Record<string, string>): Promise<T[]> {
  assertCanCall(endpoint);

  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set('wiki', WIKI);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  recordRequest(endpoint);
  const res = await fetch(url, {
    headers: { Authorization: `Apikey ${apiKey()}`, 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' },
  });
  if (res.status === 429) {
    recordHardBlock(endpoint);
    throw new Error(`Liquipedia API ${endpoint} returned 429. Hard-blocked for 1 hour from now. NOT retrying.`);
  }
  if (!res.ok) {
    throw new Error(`Liquipedia API ${endpoint} failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { result: T[]; error?: string[] };
  if (json.error) {
    throw new Error(`Liquipedia API ${endpoint} error: ${json.error.join('; ')}`);
  }
  return json.result;
}

/** Paginates a single condition set to exhaustion, respecting MAX_RESULT_LIMIT. */
async function liquipediaGetAll<T>(endpoint: string, params: Record<string, string>): Promise<T[]> {
  const results: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await liquipediaGet<T>(endpoint, { ...params, limit: String(MAX_RESULT_LIMIT), offset: String(offset) });
    results.push(...page);
    if (page.length < MAX_RESULT_LIMIT) break;
    offset += MAX_RESULT_LIMIT;
    await sleep(500); // still pace consecutive pages of the same pull, not back-to-back
  }
  return results;
}

export interface LiquipediaTeam {
  pagename: string;
  name: string;
  status: string;
}

/** All currently-active teams on the LoL wiki -- one broad paginated query, not one per team. */
export async function fetchActiveTeams(): Promise<LiquipediaTeam[]> {
  return liquipediaGetAll<LiquipediaTeam>('v3/team', {
    conditions: '[[status::active]]',
    query: 'pagename,name,status',
    order: 'pagename ASC',
  });
}

export interface LiquipediaMatchOpponent {
  name: string;
  score: number | null;
}

export interface LiquipediaGamePlayer {
  player: string; // Liquipedia's disambiguated page identity (e.g. "Tarzan_(Korean_player)") -- stable even if two people share a handle
  displayName: string; // the actual in-game handle fans use
  role: string; // lowercase position: top/jungle/mid/bot/support
  kills: number;
  deaths: number;
  assists: number;
  gold: number;
  damagedone: number;
  creepscore: number;
  killparticipation: number;
  character: string;
}

export interface LiquipediaGameOpponent {
  side: string;
  score: number; // 0 or 1 -- did this side win this individual game
  players: LiquipediaGamePlayer[];
  stats: { gold: number };
}

export interface LiquipediaMatchGame {
  match2gameid: number;
  length: string; // "MM:SS", per-game duration; "" for games that were never played
  /** "1" | "2" for a decisive result; "" for an unplayed placeholder slot -- see isPlayedGame. */
  winner: string;
  scores: number[];
  opponents: LiquipediaGameOpponent[];
}

export interface LiquipediaMatch {
  match2id: string;
  bestof: number;
  date: string; // series-level date; individual games don't carry their own timestamp
  tournament: string;
  parent: string;
  series: string; // the field to classify by -- e.g. "LoL Pro League", "Esports World Cup"
  liquipediatier: string;
  finished: number;
  match2opponents: LiquipediaMatchOpponent[];
  match2games: LiquipediaMatchGame[];
}

/** Broad, paginated match/series pull -- caller supplies the full `conditions` string (date range + series filter). */
export async function fetchMatches(conditions: string): Promise<LiquipediaMatch[]> {
  return liquipediaGetAll<LiquipediaMatch>('v3/match', { conditions });
}

export interface LiquipediaSquadPlayer {
  pagename: string; // team page
  id: string; // in-game handle
  name: string; // real name
  nationality: string;
  position: string; // "Top" | "Jungle" | "Mid" | "Bot" | "Support" for players; role/title text for staff
  role: string; // "" for a normal starter, "Substitute"/"Loan"/etc. otherwise
  type: string; // "player" | "staff"
  status: string;
  joindate: string;
}

/**
 * EVERY currently-active player across the whole wiki, in one broad paginated
 * pull -- callers filter by team pagename client-side. Replaces what used to
 * be one request per team (55+ requests) with a small, fixed number of
 * requests regardless of how many teams are being resolved.
 */
export async function fetchAllActiveSquadPlayers(): Promise<LiquipediaSquadPlayer[]> {
  return liquipediaGetAll<LiquipediaSquadPlayer>('v3/squadplayer', {
    conditions: '[[status::active]] AND [[type::player]]',
  });
}

/**
 * A row from `v3/player` -- a different dataset from `v3/squadplayer`, keyed on
 * the PLAYER's page rather than the team's, and carrying the player's current
 * team directly.
 *
 * Note the case difference: squadplayer uses status "active", player uses
 * "Active". They are separate Cargo tables, not two views of one table.
 */
export interface LiquipediaPlayer {
  pagename: string; // the player's own page
  id: string; // in-game handle
  name: string; // real name
  nationality: string;
  status: string; // "Active" | "Retired" | ... (capitalised, unlike squadplayer)
  type: string; // "player" | "staff" -- staff are coaches/managers, never roster slots
  teampagename: string | null; // the team page they currently belong to
  /** Position lives here, not as a top-level column: `{ role: "mid", roles: { "1": "mid" } }`. */
  extradata: { role?: string; roles?: Record<string, string> } | null;
}

/**
 * Current active players for specific teams, read from `v3/player`.
 *
 * Exists because `v3/squadplayer` is NOT complete: it has zero rows -- not even
 * historical ones -- for some teams whose rosters are plainly visible on the
 * rendered wiki page. Confirmed against Leviatán (CBLOL), where `v3/team`
 * returns the team as active but `v3/squadplayer` knows nothing about its
 * squad, while `v3/player` returns all five starters with the correct
 * positions in `extradata.role`.
 *
 * Deliberately queried per-team rather than pulled wiki-wide like
 * squadplayer: this is a fallback for the handful of teams squadplayer misses,
 * and every active player across the whole wiki is a far larger result set
 * than we need.
 */
export async function fetchActivePlayersForTeams(pagenames: string[]): Promise<LiquipediaPlayer[]> {
  if (pagenames.length === 0) return [];

  const results: LiquipediaPlayer[] = [];
  // Chunked so the OR-condition string stays a sane URL length.
  const CHUNK_SIZE = 10;
  for (let i = 0; i < pagenames.length; i += CHUNK_SIZE) {
    const chunk = pagenames.slice(i, i + CHUNK_SIZE);
    const teamClause = chunk.map((pagename) => `[[teampagename::${pagename}]]`).join(' OR ');
    const page = await liquipediaGetAll<LiquipediaPlayer>('v3/player', {
      conditions: `(${teamClause}) AND [[status::Active]]`,
    });
    results.push(...page);
    if (i + CHUNK_SIZE < pagenames.length) await sleep(500);
  }
  return results;
}
