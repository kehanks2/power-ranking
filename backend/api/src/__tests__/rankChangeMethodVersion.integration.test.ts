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

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

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

  const carets = async (): Promise<(number | null)[]> => {
    const res = await request(app).get('/players').query({ league, window: 'all' });
    return res.body.map((p: { rankChange: number | null }) => p.rankChange);
  };

  beforeAll(async () => {
    pool = createPool(DATABASE_URL);
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

  it('dashes every row when the only prior generation is a different model', async () => {
    await writePriorGeneration(currentMethod + 1);
    try {
      const changes = await carets();
      expect(changes.length).toBeGreaterThan(0);
      expect(changes.every((c) => c === null)).toBe(true);
    } finally {
      await removeSynthetic();
    }
  });

  it('reads the same prior generation once it carries the current model', async () => {
    await writePriorGeneration(currentMethod);
    try {
      const changes = await carets();
      const rated = changes.filter((c): c is number => c !== null);
      expect(rated.length).toBeGreaterThan(0);
      // Ratings were inverted, so the board must have moved, and the deltas are
      // a permutation of the same players either way -- they cancel.
      expect(rated.some((c) => c !== 0)).toBe(true);
      expect(rated.reduce((sum, c) => sum + c, 0)).toBe(0);
    } finally {
      await removeSynthetic();
    }
  });
});
