/**
 * Integration test against a real Postgres instance (docker-compose.yml at
 * repo root). Uses synthetic data rather than a live Leaguepedia pull -- this
 * validates the idempotent-upsert SQL itself (plan's "Ingestion idempotency
 * test: run the pull twice ... assert no duplicate games/series rows"),
 * independent of network access to Leaguepedia.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool } from '../db.js';
import { upsertTeam, upsertTournament, upsertSeries, upsertGame } from '../upsert.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

describe.runIf(process.env.SKIP_DB_TESTS !== 'true')('upsert idempotency (live Postgres)', () => {
  let pool: pg.Pool;

  beforeAll(() => {
    pool = createPool(DATABASE_URL);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('running the same tournament/series/game ingestion twice never duplicates rows', async () => {
    const teamAId = await upsertTeam(pool, {
      leaguepediaPage: '__Test_Team_A',
      slug: '__test-team-a',
      name: 'Test Team A',
    });
    const teamBId = await upsertTeam(pool, {
      leaguepediaPage: '__Test_Team_B',
      slug: '__test-team-b',
      name: 'Test Team B',
    });

    const ingestOnce = async () => {
      const tournamentId = await upsertTournament(pool, {
        overviewPage: '__Test_Tournament_2026',
        name: 'Test Tournament 2026',
        rawLeagueName: 'LCS',
        canonicalLeagueId: null,
        tournamentType: 'regional_split',
        dateStart: '2026-01-01',
        dateEnd: '2026-03-01',
      });
      const seriesId = await upsertSeries(pool, {
        tournamentId,
        leaguepediaMatchId: '__Test_Match_1',
        team1Id: teamAId,
        team2Id: teamBId,
        bestOf: 3,
        team1Score: 2,
        team2Score: 1,
        winnerTeamId: teamAId,
        isInternational: false,
      });
      await upsertGame(pool, {
        seriesId,
        leaguepediaUniqueLine: '__Test_Game_1',
        gameNumber: 1,
        team1Id: teamAId,
        team2Id: teamBId,
        winnerTeamId: teamAId,
        datetimeUtc: '2026-01-15T18:00:00Z',
        patch: '26.01',
        team1Gold: 45000,
        team2Gold: 40000,
        gamelengthSeconds: 1800,
        team1NeutralObjectives: 6,
        team2NeutralObjectives: 3,
      });
    };

    // Run the same ingestion twice, simulating a from-scratch replay.
    await ingestOnce();
    await ingestOnce();

    const tournamentCount = await pool.query(
      `SELECT COUNT(*) FROM tournaments WHERE overview_page = '__Test_Tournament_2026'`,
    );
    const seriesCount = await pool.query(
      `SELECT COUNT(*) FROM series WHERE leaguepedia_match_id = '__Test_Match_1'`,
    );
    const gameCount = await pool.query(
      `SELECT COUNT(*) FROM games WHERE leaguepedia_unique_line = '__Test_Game_1'`,
    );

    expect(Number(tournamentCount.rows[0].count)).toBe(1);
    expect(Number(seriesCount.rows[0].count)).toBe(1);
    expect(Number(gameCount.rows[0].count)).toBe(1);

    // cleanup
    await pool.query(`DELETE FROM games WHERE leaguepedia_unique_line = '__Test_Game_1'`);
    await pool.query(`DELETE FROM series WHERE leaguepedia_match_id = '__Test_Match_1'`);
    await pool.query(`DELETE FROM tournaments WHERE overview_page = '__Test_Tournament_2026'`);
    await pool.query(`DELETE FROM teams WHERE leaguepedia_page IN ('__Test_Team_A', '__Test_Team_B')`);
  });
});
