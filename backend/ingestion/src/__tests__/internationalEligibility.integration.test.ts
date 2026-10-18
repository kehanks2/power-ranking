/**
 * The international board rates teams on 10+ games in the event window, plus
 * everyone at the event currently being played. Both halves matter: without
 * the exemption Cloud9 played a full Worlds 26 play-in and never appeared;
 * without it lapsing, a team would sit on the board forever on one old run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool } from '../db.js';
import { teamsAtNewestInternationalEvent } from '../computeRatings.js';

describe('teamsAtNewestInternationalEvent (live Postgres, synthetic data)', () => {
  let pool: pg.Pool;
  const teams: number[] = [];
  const tournaments: Record<'played' | 'unplayed', number> = { played: 0, unplayed: 0 };

  const addTournament = async (page: string, dateStart: string) =>
    (
      await pool.query<{ id: number }>(
        `INSERT INTO tournaments (overview_page, name, raw_league_name, canonical_league_id, tournament_type, date_start)
         VALUES ($1, $1, 'Worlds', NULL, 'international', $2) RETURNING id`,
        [page, dateStart],
      )
    ).rows[0].id;

  const addGame = async (tournamentId: number, matchId: string, team1Id: number, team2Id: number) => {
    const series = await pool.query<{ id: number }>(
      `INSERT INTO series (tournament_id, leaguepedia_match_id, team1_id, team2_id, team1_score, team2_score, winner_team_id, is_international)
       VALUES ($1, $2, $3, $4, 1, 0, $3, true) RETURNING id`,
      [tournamentId, matchId, team1Id, team2Id],
    );
    await pool.query(
      `INSERT INTO games (series_id, leaguepedia_unique_line, game_number, team1_id, team2_id, winner_team_id, datetime_utc)
       VALUES ($1, $2, 1, $3, $4, $3, '2099-01-15T18:00:00Z')`,
      [series.rows[0].id, `${matchId}_1`, team1Id, team2Id],
    );
  };

  beforeAll(async () => {
    pool = createPool();
    for (const name of ['A', 'B', 'C', 'D']) {
      const row = await pool.query<{ id: number }>(
        `INSERT INTO teams (leaguepedia_page, slug, name) VALUES ($1, $2, $3) RETURNING id`,
        [`__IE_Team_${name}`, `__ie-team-${name.toLowerCase()}`, `IE Team ${name}`],
      );
      teams.push(row.rows[0].id);
    }
    // Dated past anything real, so these are unambiguously the newest events.
    tournaments.played = await addTournament('__IE_Played', '2099-01-01');
    tournaments.unplayed = await addTournament('__IE_Unplayed', '2099-06-01');
    await addGame(tournaments.played, '__IE_Match_1', teams[0], teams[1]);
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM games WHERE leaguepedia_unique_line LIKE '__IE_Match%'`);
    await pool.query(`DELETE FROM series WHERE leaguepedia_match_id LIKE '__IE_Match%'`);
    await pool.query(`DELETE FROM tournaments WHERE overview_page LIKE '__IE_%'`);
    await pool.query(`DELETE FROM teams WHERE leaguepedia_page LIKE '__IE_Team_%'`);
    await pool.end();
  });

  // The pull stores tournaments 21 days ahead, so the newest row routinely has
  // no games. Reading it would name an event nobody has played and empty the
  // exemption for everyone at the one actually being contested.
  it('ignores a newer event that has no games yet', async () => {
    const [a, b] = teams;
    const playing = await teamsAtNewestInternationalEvent(pool);
    expect(playing).toEqual(new Set([String(a), String(b)]));
  });

  it('moves to the next event as soon as it has one, and drops whoever is not there', async () => {
    const [a, b, c, d] = teams;
    await addGame(tournaments.unplayed, '__IE_Match_2', c, d);

    const playing = await teamsAtNewestInternationalEvent(pool);
    expect(playing).toEqual(new Set([String(c), String(d)]));
    expect(playing.has(String(a))).toBe(false);
    expect(playing.has(String(b))).toBe(false);
  });
});
