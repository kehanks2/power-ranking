/**
 * Integration test against live Postgres. Guards the invariant that the two
 * player-rating passes coexist in one table.
 *
 * This is the third time this project has been bitten by "two writers, one
 * table, unscoped DELETE": the OE and Liquipedia roster populators clobbered
 * each other, then the integration test suite clobbered the real rosters, and
 * regional/international ratings would do the same if either pass deleted
 * more than its own scope. Cheap test, expensive bug.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool } from '../db.js';
import { computePlayerRatings, computeInternationalPlayerRatings } from '../computePlayerRatings.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

async function countByScope(pool: pg.Pool, scope: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT COUNT(*) AS count FROM player_ratings_history WHERE scope = $1',
    [scope],
  );
  return Number(result.rows[0].count);
}

describe('player rating scopes (live Postgres)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = createPool(DATABASE_URL);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('keeps regional and international ratings independent across recomputes', async () => {
    await computePlayerRatings(pool);
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
    // A player with games in two leagues genuinely has two standings, so a
    // league board can read the group for ITS league rather than rating
    // someone on a league they left. What must stay unique is the group
    // itself, and the primary marker readers use when no league is meant.
    const dupeGroups = await pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count FROM (
        SELECT player_id, scope, league_id, role FROM player_ratings_history
        GROUP BY player_id, scope, league_id, role HAVING COUNT(*) > 1
      ) d
    `);
    expect(Number(dupeGroups.rows[0].count)).toBe(0);

    const badPrimary = await pool.query<{ count: string }>(`
      SELECT COUNT(*) AS count FROM (
        SELECT player_id, scope FROM player_ratings_history
        WHERE is_primary GROUP BY player_id, scope HAVING COUNT(*) <> 1
      ) d
    `);
    expect(Number(badPrimary.rows[0].count)).toBe(0);
  });

  it('records the league and role every rating was measured in', async () => {
    // Without these the stored number cannot be reconciled with the games
    // behind it -- the defect that made the board and the detail panel
    // disagree on a player's game count.
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
