/**
 * Client for Liquipedia's LiquipediaDB API v3, the authoritative source for
 * current rosters. Rate limit is 60 requests/hour; an in-memory limiter isn't
 * enough because every fresh `tsx` process starts an empty counter, so state is
 * persisted to RATE_LIMIT_STATE_FILE.
 *
 * A 429 is retried on a bounded backoff before it hard-blocks the endpoint for
 * an hour. It is not always our own volume that earns one: the scheduled job
 * shares an egress IP with every other GitHub Actions tenant, and on
 * 2026-08-17 its FIRST v3/match call took a 429 while the same key answered 200
 * from a desktop 23 minutes later. Failing fast there cost the whole day's
 * pull, because one hard block on this endpoint fails all ten series.
 *
 * Liquipedia sends no rate-limit headers at all — no X-RateLimit-*, no
 * Retry-After — so a 429 is the only signal there is, and the delays below are
 * a guess at a throttle we cannot observe.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BASE_URL = 'https://api.liquipedia.net/api';
const WIKI = 'leagueoflegends';
// Liquipedia's API terms require a User-Agent identifying the project WITH
// contact info; generic agents are blocked. Keep the URL reachable.
const USER_AGENT = 'PowerRanking/1.0 (https://github.com/kehanks2/power-ranking)';
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

/**
 * Where the budget lives. Overridable because the default is a fixed path in
 * the working copy, which makes it unusable in two places: a test exercising the
 * retry loop would spend the desktop's real budget and could hard-block it for
 * an hour, and an Actions runner discards the file with itself, so a scheduled
 * run starts blind. Read per call rather than frozen at import, so setting the
 * variable after this module loads still takes effect.
 */
function stateFilePath(): string {
  return process.env.LIQUIPEDIA_RATE_LIMIT_FILE ?? join(REPO_ROOT, '.liquipedia-rate-limit.json');
}

export interface RateLimitState {
  requestTimestampsByEndpoint: Record<string, number[]>;
  blockedUntilByEndpoint: Record<string, number>;
}

function loadState(): RateLimitState {
  const path = stateFilePath();
  if (!existsSync(path)) {
    return { requestTimestampsByEndpoint: {}, blockedUntilByEndpoint: {} };
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { requestTimestampsByEndpoint: {}, blockedUntilByEndpoint: {} };
  }
}

function saveState(state: RateLimitState): void {
  writeFileSync(stateFilePath(), JSON.stringify(state, null, 2));
}

// 40, under the documented 60/hour ceiling, since our count and theirs have
// disagreed before.
export const REQUESTS_PER_HOUR = 40;
export const WINDOW_MS = 60 * 60 * 1000;

export type CallCheck = { allowed: true } | { allowed: false; reason: string };

// Two gates: a hard block set on a real 429, and the sliding-window budget.
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
 * Waits between 429 retries. Bounded so a run cannot outlive the scheduled
 * job's 30-minute timeout: three waits plus jitter is ~11 min worst case, and
 * once these are spent the endpoint hard-blocks and every later series in the
 * same run fails immediately.
 */
export const RETRY_DELAYS_MS = [60_000, 180_000, 420_000];

/** ±20% jitter, so a fleet of clients retrying on one clock does not resynchronise. */
export function retryDelayMs(attempt: number, random = Math.random): number {
  const base = RETRY_DELAYS_MS[attempt];
  if (base === undefined) return 0;
  return Math.round(base * (0.8 + 0.4 * random()));
}

async function liquipediaGet<T>(endpoint: string, params: Record<string, string>): Promise<T[]> {
  const url = new URL(`${BASE_URL}/${endpoint}`);
  url.searchParams.set('wiki', WIKI);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  for (let attempt = 0; ; attempt += 1) {
    // Re-checked per attempt: the sliding-window budget can run out while we wait.
    assertCanCall(endpoint);
    recordRequest(endpoint);
    const res = await fetch(url, {
      headers: { Authorization: `Apikey ${apiKey()}`, 'User-Agent': USER_AGENT, 'Accept-Encoding': 'gzip' },
    });

    if (res.status === 429) {
      if (attempt >= RETRY_DELAYS_MS.length) {
        recordHardBlock(endpoint);
        throw new Error(
          `Liquipedia API ${endpoint} returned 429 on ${attempt + 1} attempts. Hard-blocked for 1 hour from now.`,
        );
      }
      const wait = retryDelayMs(attempt);
      console.warn(`  Liquipedia ${endpoint} 429; retrying in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
      continue;
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
}

// Rows per page. v3/match rows are huge (every game, two ten-player stat lines),
// so they page smaller; the ceiling is payload size, not row count.
const PAGE_SIZE_BY_ENDPOINT: Record<string, number> = { 'v3/match': 200 };

/** Paginates a single condition set to exhaustion, a page at a time. */
async function liquipediaGetAll<T>(endpoint: string, params: Record<string, string>): Promise<T[]> {
  const pageSize = PAGE_SIZE_BY_ENDPOINT[endpoint] ?? MAX_RESULT_LIMIT;
  const results: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await liquipediaGet<T>(endpoint, { ...params, limit: String(pageSize), offset: String(offset) });
    results.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
    await sleep(500); // still pace consecutive pages of the same pull, not back-to-back
  }
  return results;
}

export interface LiquipediaTeam {
  pagename: string;
  name: string;
  status: string;
  /** Wordmark on a light ground. Empty string when the wiki holds no logo. */
  logourl: string;
  /** The same wordmark tuned for a dark ground; most teams repeat logourl here. */
  logodarkurl: string;
}

/** All currently-active teams on the LoL wiki -- one broad paginated query, not one per team. */
export async function fetchActiveTeams(): Promise<LiquipediaTeam[]> {
  return liquipediaGetAll<LiquipediaTeam>('v3/team', {
    conditions: '[[status::active]]',
    query: 'pagename,name,status,logourl,logodarkurl',
    order: 'pagename ASC',
  });
}

/**
 * The crest to show on a dark board.
 *
 * `logodarkurl` is the variant drawn for a dark ground, but most teams repeat
 * their light one there and some leave both blank, so this falls back rather
 * than assuming a dark variant exists. Empty string, not null, is what the API
 * returns for a team with no logo at all.
 */
export function teamLogoUrl(team: Pick<LiquipediaTeam, 'logourl' | 'logodarkurl'>): string | null {
  return team.logodarkurl?.trim() || team.logourl?.trim() || null;
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
  // Team totals for the game. Objective counts are absent on some rows and 0 for
  // types that did not exist that patch; both read as "no neutrals of that kind".
  stats: { gold: number; dragons?: number; barons?: number; heralds?: number; grubs?: number; atakhans?: number };
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
  match2bracketid: string; // stage marker, e.g. "LCK26Sp2W1" -- Sp2/Sp3 splits the LCK season
  // The stage in words: "Playoffs", "Play-In", "Week 9", "Group Stage". What a
  // series is LABELLED by -- match2bracketid spells the same thing differently
  // per league ("LCKCup26PO", "LCKRtMSI26", "tl2OVsUfyX") and cannot be parsed.
  section: string;
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
  position: string; // "Top" | "Jungle" | ... for players; role/title text for staff
  role: string; // "" (starter), "Substitute", or "Loan" on active rows
  type: string; // "player" | "staff"
  status: string;
  joindate: string;
  // loanedto true = this player is loaned OUT, not part of this squad (the role
  // string alone can't tell the direction).
  extradata?: { loanedto?: boolean } | null;
}

/** Every active player wiki-wide in one paginated pull; callers filter by team. */
export async function fetchAllActiveSquadPlayers(): Promise<LiquipediaSquadPlayer[]> {
  return liquipediaGetAll<LiquipediaSquadPlayer>('v3/squadplayer', {
    conditions: '[[status::active]] AND [[type::player]]',
  });
}

// A `v3/player` row, keyed on the player's page. A separate Cargo table from
// squadplayer, with different status casing ("Active" vs "active").
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

// Fallback for teams v3/squadplayer returns nothing for (e.g. Leviatán), read
// per-team from v3/player rather than a wiki-wide pull.
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

/** A final standing at one tournament, from `v3/placement`. */
export interface LiquipediaPlacement {
  tournament: string;
  /** Team name as Liquipedia writes it -- not necessarily how we store it. */
  opponentname: string;
  /** "team" or "solo"; solo rows are individual awards, not standings. */
  opponenttype: string;
  /**
   * "1", "2", "5-6" ... A range where a bracket has no third-place or
   * consolation match, so the tied teams genuinely share a finish.
   */
  placement: string;
  prizemoney: number | null;
}

// Standings for a set of tournaments, OR-ed names per request rather than one
// each, so ~57 tournaments don't eat the hourly budget.
export async function fetchPlacements(tournamentNames: string[]): Promise<LiquipediaPlacement[]> {
  if (tournamentNames.length === 0) return [];

  const results: LiquipediaPlacement[] = [];
  // Chunked so the OR-condition string stays a sane URL length, matching
  // fetchActivePlayersForTeams.
  const CHUNK_SIZE = 10;
  for (let i = 0; i < tournamentNames.length; i += CHUNK_SIZE) {
    const chunk = tournamentNames.slice(i, i + CHUNK_SIZE);
    const clause = chunk.map((name) => `[[tournament::${name}]]`).join(' OR ');
    const page = await liquipediaGetAll<LiquipediaPlacement>('v3/placement', { conditions: `(${clause})` });
    results.push(...page);
    if (i + CHUNK_SIZE < tournamentNames.length) await sleep(500);
  }
  return results;
}
