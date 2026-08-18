/**
 * Re-fetches games that were ingested WITHOUT player stat lines.
 *
 * Past STATS_GRACE_DAYS a played game is ingested regardless of whether
 * Liquipedia has published its stat lines. It then counts toward team ratings
 * and contributes nothing to player ratings, and nothing ever asked for it
 * again -- the daily window only moves forward, so a stat line published a week
 * late was never picked up.
 *
 * Scope is deliberately recent. Liquipedia never published player data for
 * 51.8% of LPL 2024 and 40.6% of 2025; those are absent rather than late, and
 * sweeping them is wasted effort. What IS recoverable is the publication lag
 * that outlasts the grace period, which is a matter of days to weeks.
 *
 * Matches are re-queried BY ID rather than by re-running a date window: the
 * ids are already known, LPDB takes them OR'd together, and a re-pull of the
 * whole window would cost a page per series per day covered.
 */
import type { Pool } from 'pg';
import { ingestLiquipediaMatches } from './liquipediaMatchIngest.js';

/** How far back a statless game is still worth asking about. */
export const STATLESS_REFETCH_DAYS = 30;

/**
 * Ids per request. The cost here is condition-string length, not rows: each id
 * adds ~20 characters and each match returns one row.
 */
export const MATCH_IDS_PER_REQUEST = 25;

export function batchMatchIds(ids: string[], size = MATCH_IDS_PER_REQUEST): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += size) batches.push(ids.slice(i, i + size));
  return batches;
}

export function matchIdConditions(ids: string[]): string {
  return ids.map((id) => `[[match2id::${id}]]`).join(' OR ');
}

export interface StatlessRefreshResult {
  candidates: number;
  requests: number;
  gamesGainedStats: number;
}

async function countStatless(pool: Pool, days: number): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM games g
      WHERE NOT EXISTS (SELECT 1 FROM player_game_performance p WHERE p.game_id = g.id)
        AND g.datetime_utc >= now() - ($1 || ' days')::interval`,
    [days],
  );
  return Number(result.rows[0].count);
}

/**
 * Asks again for every recent game still missing its stat lines. Returns what
 * changed; a game whose stats Liquipedia still has not published simply
 * re-ingests unchanged, which is why the gain is measured rather than assumed.
 */
export async function refreshStatlessGames(pool: Pool, days = STATLESS_REFETCH_DAYS): Promise<StatlessRefreshResult> {
  const candidates = await pool.query<{ matchId: string }>(
    `SELECT DISTINCT replace(s.leaguepedia_match_id, 'liquipedia:', '') AS "matchId"
       FROM games g
       JOIN series s ON s.id = g.series_id
      WHERE NOT EXISTS (SELECT 1 FROM player_game_performance p WHERE p.game_id = g.id)
        AND g.datetime_utc >= now() - ($1 || ' days')::interval`,
    [days],
  );
  const ids = candidates.rows.map((row) => row.matchId);
  if (ids.length === 0) return { candidates: 0, requests: 0, gamesGainedStats: 0 };

  const before = await countStatless(pool, days);
  const batches = batchMatchIds(ids);
  for (const batch of batches) {
    await ingestLiquipediaMatches(pool, matchIdConditions(batch));
  }
  const after = await countStatless(pool, days);

  return { candidates: ids.length, requests: batches.length, gamesGainedStats: before - after };
}
