/**
 * Integration test against live Postgres, using synthetic data inserted
 * directly (bypassing Leaguepedia) -- validates the DB -> replay -> DB
 * round trip independent of live network access.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool } from '../db.js';
import { computeRatings } from '../computeRatings.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

describe('computeRatings (live Postgres, synthetic data)', () => {
  let pool: pg.Pool;
  let teamAId: number;
  let teamBId: number;
  let lcsLeagueId: number;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL);

    const league = await pool.query<{ id: number }>(`SELECT id FROM leagues WHERE slug = 'LCS'`);
    lcsLeagueId = league.rows[0].id;

    const teamA = await pool.query<{ id: number }>(
      `INSERT INTO teams (leaguepedia_page, slug, name) VALUES ('__CR_Team_A', '__cr-team-a', 'CR Team A')
       ON CONFLICT (leaguepedia_page) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    );
    teamAId = teamA.rows[0].id;
    const teamB = await pool.query<{ id: number }>(
      `INSERT INTO teams (leaguepedia_page, slug, name) VALUES ('__CR_Team_B', '__cr-team-b', 'CR Team B')
       ON CONFLICT (leaguepedia_page) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    );
    teamBId = teamB.rows[0].id;

    await pool.query(
      `INSERT INTO team_league_memberships (team_id, league_id, start_date) VALUES ($1, $2, '2020-01-01'), ($3, $2, '2020-01-01')`,
      [teamAId, lcsLeagueId, teamBId],
    );

    const tournament = await pool.query<{ id: number }>(
      `INSERT INTO tournaments (overview_page, name, raw_league_name, canonical_league_id, tournament_type, date_start, date_end)
       VALUES ('__CR_Tournament', 'CR Test Tournament', 'LCS', $1, 'regional_split', '2026-01-01', '2026-03-01')
       ON CONFLICT (overview_page) DO UPDATE SET canonical_league_id = EXCLUDED.canonical_league_id RETURNING id`,
      [lcsLeagueId],
    );
    const tournamentId = tournament.rows[0].id;

    const series = await pool.query<{ id: number }>(
      `INSERT INTO series (tournament_id, leaguepedia_match_id, team1_id, team2_id, best_of, team1_score, team2_score, winner_team_id, is_international)
       VALUES ($1, '__CR_Match_1', $2, $3, 1, 1, 0, $2, false)
       ON CONFLICT (leaguepedia_match_id) DO UPDATE SET winner_team_id = EXCLUDED.winner_team_id RETURNING id`,
      [tournamentId, teamAId, teamBId],
    );
    const seriesId = series.rows[0].id;

    await pool.query(
      `INSERT INTO games (series_id, leaguepedia_unique_line, game_number, team1_id, team2_id, winner_team_id, datetime_utc, team1_gold, team2_gold, gamelength_seconds)
       VALUES ($1, '__CR_Game_1', 1, $2, $3, $2, '2026-01-15T18:00:00Z', 48000, 40000, 1800)
       ON CONFLICT (leaguepedia_unique_line) DO UPDATE SET winner_team_id = EXCLUDED.winner_team_id`,
      [seriesId, teamAId, teamBId],
    );
  });

  afterAll(async () => {
    // Scoped to just this test's synthetic teams -- a real bug lived here
    // before: this used to blindly `DELETE FROM team_ratings_history` /
    // `league_ratings_history` (no WHERE clause) as "cleanup," which was
    // harmless when the DB was empty during early development but silently
    // destroyed all real computed ratings every time the suite ran once real
    // data existed (confirmed in practice: every team fell back to
    // cold-start after a test run). The test's own `it()` block already
    // called computeRatings once, which already produced correct rows for
    // every real team in that same atomic pass -- deleting only this test's
    // rows here leaves that untouched, no need to recompute again. Must run
    // before deleting the teams themselves (FK: team_ratings_history.team_id
    // references teams.id).
    await pool.query(`DELETE FROM team_ratings_history WHERE team_id IN ($1, $2)`, [teamAId, teamBId]);
    await pool.query(`DELETE FROM games WHERE leaguepedia_unique_line = '__CR_Game_1'`);
    await pool.query(`DELETE FROM series WHERE leaguepedia_match_id = '__CR_Match_1'`);
    await pool.query(`DELETE FROM tournaments WHERE overview_page = '__CR_Tournament'`);
    await pool.query(`DELETE FROM team_league_memberships WHERE team_id IN ($1, $2)`, [teamAId, teamBId]);
    await pool.query(`DELETE FROM teams WHERE id IN ($1, $2)`, [teamAId, teamBId]);
    await pool.end();
  });

  it('replays a synthetic game and persists a winner-up / loser-down rating history', async () => {
    const result = await computeRatings(pool);
    expect(result.teamRows).toBeGreaterThan(0);
    expect(result.leagueRows).toBeGreaterThan(0);

    const teamAHistory = await pool.query(
      `SELECT mu_ctx, reason FROM team_ratings_history WHERE team_id = $1 ORDER BY id`,
      [teamAId],
    );
    const teamBHistory = await pool.query(
      `SELECT mu_ctx, reason FROM team_ratings_history WHERE team_id = $1 ORDER BY id`,
      [teamBId],
    );

    const teamAFinal = Number(teamAHistory.rows[teamAHistory.rows.length - 1].mu_ctx);
    const teamBFinal = Number(teamBHistory.rows[teamBHistory.rows.length - 1].mu_ctx);
    expect(teamAFinal).toBeGreaterThan(0); // Team A won
    expect(teamBFinal).toBeLessThan(0); // Team B lost
  });
});
