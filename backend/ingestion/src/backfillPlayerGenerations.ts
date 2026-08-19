/**
 * Rebuilds caret baselines for past days of play.
 *
 * Player rank-change carets read the previous generation of
 * `player_ratings_history`. Generations only ever accumulated forward, one per
 * day of play, so anything that clears them -- a `PLAYER_RATING_METHOD_VERSION`
 * bump does exactly that, since carets refuse a baseline from another version --
 * left every regional board caretless until a week of play had gone by.
 *
 * Nothing about that was necessary. The rating is a pure function of the games
 * played by a date plus the tuned weights: the only reference to the present was
 * a hardcoded `NOW()` in two queries. Given an `asOf`, the board as it stood on
 * any past day can be reconstructed exactly.
 *
 * A reconstructed baseline is arguably better than the generation that was
 * actually stored then, which was computed with whatever code and roster data
 * existed at the time -- diffing against it reports retunes and roster
 * corrections as player movement. Holding those constant and varying only the
 * games is what a caret is supposed to mean.
 */
import type { Pool } from 'pg';
import { DEFAULT_WIN_WEIGHT } from '@power-ranking/rating-engine';
import {
  computeAllPlayerRatingWindows,
  computeInternationalPlayerRatings,
  RETAINED_FRONTIERS,
} from './computePlayerRatings.js';

/**
 * End of a day in UTC. The frontier is a date, so the reconstruction has to take
 * every game played on it and none of the next day's.
 */
export function endOfDay(day: string): Date {
  return new Date(`${day}T23:59:59.999Z`);
}

export interface BackfillResult {
  candidates: string[];
  written: { frontier: string; rows: number }[];
  skipped: string[];
}

/**
 * Days of play that could carry a generation, newest first, capped at what
 * retention keeps -- writing past that only to have the next run prune it is
 * work for nothing.
 */
async function recentPlayDays(pool: Pool, limit: number): Promise<string[]> {
  const result = await pool.query<{ day: string }>(
    `SELECT DISTINCT datetime_utc::date::text AS day FROM games
      WHERE datetime_utc IS NOT NULL
      ORDER BY day DESC LIMIT $1`,
    [limit],
  );
  return result.rows.map((row) => row.day);
}

async function frontiersHeld(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ frontier: string }>(
    `SELECT DISTINCT data_frontier::text AS frontier FROM player_ratings_history
      WHERE data_frontier IS NOT NULL`,
  );
  return new Set(result.rows.map((row) => row.frontier));
}

/**
 * Writes a generation for every recent day of play that has none.
 *
 * Days that already hold one are SKIPPED, never rewritten. `writeRatings` keeps
 * the newest run per frontier, so recomputing a day that already has a
 * generation would delete the real one and put a reconstruction in its place --
 * which is the one thing this must not do.
 */
export async function backfillPlayerGenerations(
  pool: Pool,
  winWeight = DEFAULT_WIN_WEIGHT,
  limit = RETAINED_FRONTIERS,
): Promise<BackfillResult> {
  const candidates = await recentPlayDays(pool, limit);
  const held = await frontiersHeld(pool);
  const result: BackfillResult = { candidates, written: [], skipped: [] };

  // Oldest first, so the retention prune sees the frontiers arrive in the order
  // the daily job would have produced them.
  for (const day of [...candidates].reverse()) {
    if (held.has(day)) {
      result.skipped.push(day);
      continue;
    }
    const asOf = endOfDay(day);
    let rows = await computeAllPlayerRatingWindows(pool, winWeight, asOf);
    rows += await computeInternationalPlayerRatings(pool, winWeight, asOf);
    result.written.push({ frontier: day, rows });
  }
  return result;
}
