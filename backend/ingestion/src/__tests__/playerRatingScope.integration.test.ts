/**
 * Integration test against live Postgres. Guards the invariant that all four
 * player-rating passes coexist in one table: regional over each of the three
 * windows, plus international.
 *
 * This is the third time this project has been bitten by "two writers, one
 * table, unscoped DELETE": the OE and Liquipedia roster populators clobbered
 * each other, then the integration test suite clobbered the real rosters, and
 * these passes would do the same if any of them deleted more than its own
 * (scope, window). Cheap test, expensive bug -- and there are four writers now,
 * so the pairs that could clobber each other have gone from one to six.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool } from '../db.js';
import {
  computePlayerRatings,
  computeAllPlayerRatingWindows,
  computeInternationalPlayerRatings,
  RETAINED_FRONTIERS,
} from '../computePlayerRatings.js';
import { DEFAULT_WIN_WEIGHT } from '@power-ranking/rating-engine';
import { RATING_WINDOWS, type RatingWindow } from '@power-ranking/shared';

// Rows are kept per recompute, so these invariants hold within a generation
// rather than across the table. Join this to read only the newest one.
const CURRENT_GENERATION = `
  current_generation AS (
    SELECT scope, rating_window, max(computed_at) AS computed_at
    FROM player_ratings_history GROUP BY scope, rating_window
  )`;

/** Distinct data frontiers for one (scope, window), oldest first. */
async function frontiers(pool: pg.Pool, scope: string, window: RatingWindow): Promise<string[]> {
  const result = await pool.query<{ data_frontier: string }>(
    `SELECT DISTINCT data_frontier::text FROM player_ratings_history
     WHERE scope = $1 AND rating_window = $2 AND data_frontier IS NOT NULL ORDER BY 1`,
    [scope, window],
  );
  return result.rows.map((row) => row.data_frontier);
}

/** Every generation timestamp for one (scope, window), oldest first. */
async function generations(pool: pg.Pool, scope: string, window: RatingWindow): Promise<number[]> {
  const result = await pool.query<{ computed_at: Date }>(
    `SELECT DISTINCT computed_at FROM player_ratings_history
     WHERE scope = $1 AND rating_window = $2 ORDER BY computed_at`,
    [scope, window],
  );
  return result.rows.map((row) => row.computed_at.getTime());
}

async function countByScope(pool: pg.Pool, scope: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `WITH ${CURRENT_GENERATION}
     SELECT COUNT(*) AS count FROM player_ratings_history prh
     JOIN current_generation cg ON cg.scope = prh.scope
       AND cg.rating_window = prh.rating_window AND cg.computed_at = prh.computed_at
     WHERE prh.scope = $1`,
    [scope],
  );
  return Number(result.rows[0].count);
}

async function countByWindow(pool: pg.Pool, window: RatingWindow): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `WITH ${CURRENT_GENERATION}
     SELECT COUNT(*) AS count FROM player_ratings_history prh
     JOIN current_generation cg ON cg.scope = prh.scope
       AND cg.rating_window = prh.rating_window AND cg.computed_at = prh.computed_at
     WHERE prh.scope = 'regional' AND prh.rating_window = $1`,
    [window],
  );
  return Number(result.rows[0].count);
}

describe('player rating scopes (live Postgres)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = createPool();
  });

  afterAll(async () => {
    await pool.end();
  });

  it('keeps regional and international ratings independent across recomputes', async () => {
    await computeAllPlayerRatingWindows(pool);
    await computeInternationalPlayerRatings(pool);

    const regionalAfterBoth = await countByScope(pool, 'regional');
    const internationalAfterBoth = await countByScope(pool, 'international');
    expect(regionalAfterBoth).toBeGreaterThan(0);
    expect(internationalAfterBoth).toBeGreaterThan(0);

    // Re-running ONE pass must leave the other scope's rows untouched.
    await computePlayerRatings(pool);
    expect(await countByScope(pool, 'international')).toBe(internationalAfterBoth);

    await computeInternationalPlayerRatings(pool);
    expect(await countByScope(pool, 'regional')).toBe(regionalAfterBoth);
  }, 60_000);

  it('retains history in days of play, not runs, and leaves other passes alone', async () => {
    // Recomputing the same games must not consume retention: the carets need a
    // generation predating a board's last match day for as long as that board is
    // inside the stale window, and a second run in one day would otherwise
    // halve how far back they can reach. The prune must also stay inside its own
    // (scope, window) -- the trap the unscoped DELETE fell into.
    const before = await generations(pool, 'regional', 'all');
    const otherBefore = await generations(pool, 'regional', 'split');
    expect(before.length).toBeGreaterThan(0);

    await computePlayerRatings(pool);
    const afterFirst = await frontiers(pool, 'regional', 'all');

    // A second run over identical games replaces rather than accumulates.
    await computePlayerRatings(pool);
    const after = await generations(pool, 'regional', 'all');
    expect(await frontiers(pool, 'regional', 'all')).toEqual(afterFirst);
    expect(afterFirst.length).toBeLessThanOrEqual(RETAINED_FRONTIERS);
    expect(after.length).toBe(afterFirst.length);
    expect(await generations(pool, 'regional', 'split')).toEqual(otherBefore);

    // Every row of a run shares its timestamp, or a prior rank is read off a
    // partial board.
    const partial = await pool.query<{ count: string }>(
      `SELECT COUNT(DISTINCT as_of_date) AS count FROM player_ratings_history
       WHERE scope = 'regional' AND rating_window = 'all' AND computed_at = $1`,
      [new Date(after[after.length - 1])],
    );
    expect(Number(partial.rows[0].count)).toBe(1);
  }, 60_000);

  it('keeps the three regional windows independent of each other', async () => {
    const before = new Map<RatingWindow, number>();
    for (const window of RATING_WINDOWS) before.set(window, await countByWindow(pool, window));
    // Each has to hold something, or "independent" is trivially true.
    for (const count of before.values()) expect(count).toBeGreaterThan(0);

    // Recomputing one window must not touch the other two -- catches a DELETE
    // that named the scope without the window.
    await computePlayerRatings(pool, DEFAULT_WIN_WEIGHT, 'split');
    expect(await countByWindow(pool, 'all')).toBe(before.get('all'));
    expect(await countByWindow(pool, 'year')).toBe(before.get('year'));
  }, 30_000);

  it('rates each player over strictly fewer games as the window narrows', async () => {
    // A window is a subset of the one containing it, so its evidence can only
    // shrink; if it grew, the window predicate is letting in outside games.
    const leaked = await pool.query<{ count: string }>(`
      WITH ${CURRENT_GENERATION},
      current_rows AS (
        SELECT prh.* FROM player_ratings_history prh
        JOIN current_generation cg ON cg.scope = prh.scope
          AND cg.rating_window = prh.rating_window AND cg.computed_at = prh.computed_at
      )
      SELECT COUNT(*) AS count FROM (
        SELECT split.player_id
        FROM current_rows split
        JOIN current_rows year
          ON year.player_id = split.player_id AND year.role = split.role
         AND year.league_id = split.league_id AND year.scope = 'regional'
         AND year.rating_window = 'year'
        JOIN current_rows whole
          ON whole.player_id = split.player_id AND whole.role = split.role
         AND whole.league_id = split.league_id AND whole.scope = 'regional'
         AND whole.rating_window = 'all'
        WHERE split.scope = 'regional' AND split.rating_window = 'split'
          AND (split.games_played > year.games_played OR year.games_played > whole.games_played)
      ) d
    `);
    expect(Number(leaked.rows[0].count)).toBe(0);
  });

  it('rates strictly fewer players internationally, and only ones with real evidence', async () => {
    const regional = await countByScope(pool, 'regional');
    const international = await countByScope(pool, 'international');
    expect(international).toBeLessThan(regional);

    // The display floor: nobody is listed off a token appearance.
    const thin = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM player_ratings_history WHERE scope = 'international' AND games_played < 5`,
    );
    expect(Number(thin.rows[0].count)).toBe(0);
  });

  it('emits one row per peer group, and marks exactly one of them primary', async () => {
    // A player with games in two leagues has two standings, so the (group) row
    // and the primary marker must be unique per (scope, window) -- each window
    // is its own board.
    const dupeGroups = await pool.query<{ count: string }>(`
      WITH ${CURRENT_GENERATION}
      SELECT COUNT(*) AS count FROM (
        SELECT prh.player_id, prh.scope, prh.rating_window, prh.league_id, prh.role
        FROM player_ratings_history prh
        JOIN current_generation cg ON cg.scope = prh.scope
          AND cg.rating_window = prh.rating_window AND cg.computed_at = prh.computed_at
        GROUP BY prh.player_id, prh.scope, prh.rating_window, prh.league_id, prh.role
        HAVING COUNT(*) > 1
      ) d
    `);
    expect(Number(dupeGroups.rows[0].count)).toBe(0);

    const badPrimary = await pool.query<{ count: string }>(`
      WITH ${CURRENT_GENERATION}
      SELECT COUNT(*) AS count FROM (
        SELECT prh.player_id, prh.scope, prh.rating_window FROM player_ratings_history prh
        JOIN current_generation cg ON cg.scope = prh.scope
          AND cg.rating_window = prh.rating_window AND cg.computed_at = prh.computed_at
        WHERE prh.is_primary
        GROUP BY prh.player_id, prh.scope, prh.rating_window HAVING COUNT(*) <> 1
      ) d
    `);
    expect(Number(badPrimary.rows[0].count)).toBe(0);
  });

  it('records the league and role every rating was measured in', async () => {
    // Without these the rating can't be reconciled with its games -- the defect
    // that made the board and detail panel disagree on a game count.
    const unlabelled = await pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count FROM player_ratings_history
      WHERE role IS NULL OR (scope = 'regional' AND league_id IS NULL)
    `);
    expect(Number(unlabelled.rows[0].count)).toBe(0);

    // International peer groups are role-only by design, which is what makes
    // them cross-region comparable; a league there would be a fiction.
    const leagued = await pool.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM player_ratings_history WHERE scope = 'international' AND league_id IS NOT NULL`,
    );
    expect(Number(leagued.rows[0].count)).toBe(0);
  });

  it('only counts international games from the last 3 years', async () => {
    const oldest = await pool.query<{ months_old: string | null }>(`
      SELECT MAX(EXTRACT(EPOCH FROM (NOW() - g.datetime_utc)) / 86400 / 30.44) AS months_old
      FROM player_game_performance pgp
      JOIN games g ON g.id = pgp.game_id
      JOIN series s ON s.id = g.series_id
      JOIN tournaments tn ON tn.id = s.tournament_id
      WHERE tn.tournament_type = 'international'
        AND g.datetime_utc > NOW() - INTERVAL '36 months'
    `);
    const monthsOld = Number(oldest.rows[0].months_old ?? 0);
    expect(monthsOld).toBeLessThanOrEqual(36);
  });
});
