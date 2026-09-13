/**
 * Guards the availability denominator on the champion board.
 *
 * League play is fearless: a champion picked in game N of a series is out of the
 * pool for the rest of it. Charging it for those games would cap a contested
 * champion's pick rate at roughly one over the series length, which is exactly
 * the distortion the board exists to avoid. `gamesAvailable` must therefore drop
 * by the number of later games in that series -- and must NOT drop in a
 * tournament that is not fearless, which is detected from a repeated pick rather
 * than assumed.
 *
 * Writes synthetic drafts onto one real fixture series and clears them again;
 * the fixture holds no champion or ban rows of its own, so cleanup is total.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import pg from 'pg';
import { createPool } from '../db.js';
import { getChampionBoard } from '../repositories.js';

describe('champion board availability under fearless draft', () => {
  let pool: pg.Pool;
  let gameIds: number[];
  let year: number;

  beforeAll(async () => {
    pool = createPool();
    const series = await pool.query<{ series_id: number; games: number }>(
      `SELECT g.series_id, count(*)::int AS games
         FROM games g
         JOIN series s ON s.id = g.series_id
         JOIN tournaments t ON t.id = s.tournament_id
        WHERE t.canonical_league_id IS NOT NULL
        GROUP BY g.series_id
       HAVING count(*) >= 3
        ORDER BY g.series_id
        LIMIT 1`,
    );
    expect(series.rows.length, 'fixture needs a series of at least three games').toBe(1);

    const games = await pool.query<{ id: number; year: number }>(
      `SELECT id, extract(year FROM datetime_utc)::int AS year
         FROM games WHERE series_id = $1 ORDER BY game_number`,
      [series.rows[0].series_id],
    );
    gameIds = games.rows.map((row) => row.id);
    year = games.rows[0].year;
  });

  afterEach(async () => {
    await pool.query('UPDATE player_game_performance SET champion = NULL WHERE game_id = ANY($1::int[])', [gameIds]);
    await pool.query('DELETE FROM game_bans WHERE game_id = ANY($1::int[])', [gameIds]);
  });

  afterAll(async () => {
    await pool.end();
  });

  /** Gives every stat line in each game a champion, unique per game unless named. */
  async function draft(shared: { champion: string; games: number[] }[]): Promise<void> {
    for (const [index, gameId] of gameIds.entries()) {
      await pool.query(
        `UPDATE player_game_performance SET champion = 'Filler' || $2 || '_' || id WHERE game_id = $1`,
        [gameId, index],
      );
    }
    for (const entry of shared) {
      for (const gameIndex of entry.games) {
        await pool.query(
          `UPDATE player_game_performance SET champion = $2
            WHERE id = (SELECT min(id) FROM player_game_performance WHERE game_id = $1)`,
          [gameIds[gameIndex], entry.champion],
        );
      }
    }
  }

  const rowFor = (board: Awaited<ReturnType<typeof getChampionBoard>>, champion: string) => {
    const row = board.rows.find((r) => r.champion === champion);
    expect(row, `${champion} missing from board`).toBeDefined();
    return row!;
  };

  it('does not charge a champion for the games it was locked out of', async () => {
    // Picked in game 1 of a three-game series, so games 2 and 3 never offered it.
    await draft([{ champion: 'EarlyPick', games: [0] }]);

    const board = await getChampionBoard(pool, year, { kind: 'all' }, 'year');
    expect(board.games).toBe(gameIds.length);

    const early = rowFor(board, 'EarlyPick');
    expect(early.gamesAvailable).toBe(1); // only game 1 ever offered it
    expect(early.gamesPicked).toBe(1);
    expect(early.pickRate).toBe(1);
  });

  it('offers every game to a champion picked only in the last one', async () => {
    await draft([{ champion: 'LatePick', games: [gameIds.length - 1] }]);

    const late = rowFor(await getChampionBoard(pool, year, { kind: 'all' }, 'year'), 'LatePick');
    expect(late.gamesAvailable).toBe(gameIds.length);
    expect(late.pickRate).toBeCloseTo(1 / gameIds.length, 10);
  });

  it('blocks nothing in a tournament that is not fearless', async () => {
    // The same champion in two games of one series cannot happen under fearless,
    // so the tournament is treated as an open pool and nothing is deducted.
    await draft([{ champion: 'Repeated', games: [0, 1] }]);

    const repeated = rowFor(await getChampionBoard(pool, year, { kind: 'all' }, 'year'), 'Repeated');
    expect(repeated.gamesAvailable).toBe(gameIds.length);
    expect(repeated.gamesPicked).toBe(2);
  });

  it('keeps presence exactly equal to pick rate plus ban rate', async () => {
    await draft([{ champion: 'Contested', games: [0] }]);
    // Banned in the two games it was locked out of -- a ban does not remove a
    // champion from the fearless pool, but a pick does, so these do not overlap.
    await pool.query(
      `INSERT INTO game_bans (game_id, team_id, ban_order, champion)
       SELECT g.id, g.team1_id, 1, 'Contested' FROM games g WHERE g.id = ANY($1::int[])`,
      [gameIds.slice(1)],
    );

    const contested = rowFor(await getChampionBoard(pool, year, { kind: 'all' }, 'year'), 'Contested');
    expect(contested.presence).toBeCloseTo(contested.pickRate + contested.banRate, 10);
    expect(contested.gamesBanned).toBe(gameIds.length - 1);
  });

  it('reports win rate over picks, not over the board', async () => {
    await draft([{ champion: 'Winner', games: [0] }]);
    // Force that pick onto the winning side.
    await pool.query(
      `UPDATE player_game_performance p SET team_id = g.winner_team_id
         FROM games g WHERE g.id = p.game_id AND p.champion = 'Winner'`,
    );

    const winner = rowFor(await getChampionBoard(pool, year, { kind: 'all' }, 'year'), 'Winner');
    expect(winner.gamesPicked).toBe(1);
    expect(winner.winRate).toBe(1);
  });
});
