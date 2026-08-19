/**
 * Guards the rule that rank-change carets only compare generations computed by
 * the same model.
 *
 * Cutting the player win weight from 0.5 to 0.3 "moved" 42 of 57 LCK players,
 * because the newest generation was v4 and the baseline still v3 -- the board
 * reported a retune as player movement. The baseline selection now requires a
 * matching method_version.
 *
 * Writes a synthetic prior generation and removes it again; both inserts are
 * keyed on their own computed_at so cleanup cannot touch real rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../app.js';
import { createPool } from '../db.js';

const SYNTHETIC_AT = new Date('2000-01-01T00:00:00Z');

describe('rank-change carets across a model retune', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let league: string;
  let currentMethod: number;

  /**
   * Clones the newest regional/all generation to an older frontier under the
   * given method_version, ratings shuffled so any comparison would show motion.
   */
  async function writePriorGeneration(methodVersion: number): Promise<void> {
    await pool.query(
      `INSERT INTO player_ratings_history
         (player_id, as_of_date, rating, games_played, method_version, scope, league_id, role,
          is_primary, rating_window, raw_rating, effective_games, computed_at, data_frontier)
       SELECT player_id, as_of_date, 100 - rating, games_played, $1, scope, league_id, role,
              is_primary, rating_window, raw_rating, effective_games, $2,
              (SELECT min(data_frontier) - 1 FROM player_ratings_history WHERE scope = 'regional')
         FROM player_ratings_history
        WHERE scope = 'regional' AND rating_window = 'all'
          AND computed_at = (SELECT max(computed_at) FROM player_ratings_history
                              WHERE scope = 'regional' AND rating_window = 'all')`,
      [methodVersion, SYNTHETIC_AT],
    );
  }

  const removeSynthetic = () =>
    pool.query(`DELETE FROM player_ratings_history WHERE computed_at = $1`, [SYNTHETIC_AT]);

  const baselines = async (): Promise<(string | null)[]> => {
    const res = await request(app).get('/players').query({ league, window: 'all' });
    return res.body.map((p: { comparedTo: string | null }) => p.comparedTo);
  };

  /** The frontier writePriorGeneration plants the synthetic rows on. */
  async function syntheticFrontier(): Promise<string> {
    const { rows } = await pool.query<{ day: string }>(
      `SELECT (min(data_frontier) - 1)::text AS day FROM player_ratings_history
        WHERE scope = 'regional' AND computed_at <> $1`,
      [SYNTHETIC_AT],
    );
    return rows[0].day;
  }

  beforeAll(async () => {
    pool = createPool();
    app = createApp(pool);
    await removeSynthetic();

    const { rows } = await pool.query<{ method_version: number }>(
      `SELECT method_version FROM player_ratings_history
        WHERE scope = 'regional' AND rating_window = 'all'
        ORDER BY computed_at DESC LIMIT 1`,
    );
    currentMethod = rows[0].method_version;

    const board = await pool.query<{ slug: string }>(
      `SELECT l.slug FROM leagues l
         JOIN team_league_memberships tlm ON tlm.league_id = l.id AND tlm.end_date IS NULL
         JOIN roster_memberships rm ON rm.team_id = tlm.team_id AND rm.end_date IS NULL
         JOIN player_ratings_history prh ON prh.player_id = rm.player_id AND prh.league_id = l.id
        WHERE prh.scope = 'regional' AND prh.rating_window = 'all'
        GROUP BY l.slug ORDER BY count(*) DESC LIMIT 1`,
    );
    league = board.rows[0].slug;
  });

  afterAll(async () => {
    await removeSynthetic();
    await pool.end();
  });

  it('never measures from a generation computed by a different model', async () => {
    // Asserted "every row dashes" until 2026-08-18. That held only while the
    // boards had no usable baseline at all -- the state issue #38 described --
    // so the test passed without the guard doing anything. Once the baselines
    // were backfilled the boards correctly measured from a real same-version
    // generation and the assertion broke, having never tested the guard.
    //
    // What the guard actually promises is narrower and does not depend on how
    // many real generations exist: the different-model one is never CHOSEN.
    const planted = await syntheticFrontier();
    await writePriorGeneration(currentMethod + 1);
    try {
      const chosen = await baselines();
      expect(chosen.length).toBeGreaterThan(0);
      expect(chosen).not.toContain(planted);
    } finally {
      await removeSynthetic();
    }
  });

  // The matching-version half is covered by caretBaseline.test.ts, which tests
  // the selection directly. Asserting it through the API made the outcome
  // depend on which league happened to be mid-stage and how many real
  // generations existed, neither of which the guard is about.
});
