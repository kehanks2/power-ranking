/**
 * Integration test against live Postgres, synthetic data -- regression test
 * for a real bug found via user feedback: populateRosterMemberships used to
 * pick "whoever played this role in the single most recent game," which is
 * fragile to one anomalous data row. Confirmed in practice: Blaber (Cloud9's
 * actual jungler, 48 JNG games) was shown as a MID player because a single
 * anomalous MID-tagged row happened to be his most recent game in that role's
 * history -- i.e. the *role slot's* most recent entry was the anomaly, even
 * though a different, established player owned that slot all season.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool } from '../db.js';
import { upsertTeam, upsertPlayer, upsertGameLineup, upsertTournament, upsertSeries, upsertGame } from '../upsert.js';
import { populateRosterMemberships } from '../computePlayerRatings.js';
import {
  snapshotRosterMemberships,
  restoreRosterMemberships,
  type RosterMembershipRow,
} from './rosterMembershipsSnapshot.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

describe('populateRosterMemberships (live Postgres, synthetic data)', () => {
  let pool: pg.Pool;
  let rosterSnapshot: RosterMembershipRow[];
  let teamId: number;
  let establishedJunglerId: number;
  let oneOffSubId: number;
  let topId: number;
  let midId: number;
  let botId: number;
  let supId: number;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL);
    // populateRosterMemberships wipes the WHOLE table, not just this test's
    // team -- see rosterMembershipsSnapshot.ts.
    rosterSnapshot = await snapshotRosterMemberships(pool);
    teamId = await upsertTeam(pool, { leaguepediaPage: '__RM_Team', slug: '__rm-team', name: 'RM Test Team' });
    establishedJunglerId = await upsertPlayer(pool, { leaguepediaPage: '__RM_Established', handle: 'EstablishedJungler' });
    oneOffSubId = await upsertPlayer(pool, { leaguepediaPage: '__RM_OneOff', handle: 'OneOffSub' });
    // buildTeamLineupGames only counts a game if all 5 roles are recorded --
    // matching the real data shape -- so fill the other 4 roles too.
    topId = await upsertPlayer(pool, { leaguepediaPage: '__RM_Top', handle: 'FillerTop' });
    midId = await upsertPlayer(pool, { leaguepediaPage: '__RM_Mid', handle: 'FillerMid' });
    botId = await upsertPlayer(pool, { leaguepediaPage: '__RM_Bot', handle: 'FillerBot' });
    supId = await upsertPlayer(pool, { leaguepediaPage: '__RM_Sup', handle: 'FillerSup' });

    const tournamentId = await upsertTournament(pool, {
      overviewPage: '__RM_Tournament',
      name: 'RM Test Tournament',
      rawLeagueName: 'LCS',
      canonicalLeagueId: null,
      tournamentType: 'regional_split',
      dateStart: '2026-01-01',
      dateEnd: '2026-08-01',
    });

    // 10 games: the established jungler owns the JNG slot.
    for (let i = 0; i < 10; i++) {
      const seriesId = await upsertSeries(pool, {
        tournamentId,
        leaguepediaMatchId: `__RM_Match_${i}`,
        team1Id: teamId,
        team2Id: teamId,
        bestOf: 1,
        team1Score: 1,
        team2Score: 0,
        winnerTeamId: teamId,
        isInternational: false,
      });
      const monthDay = `2026-${String(1 + (i % 7)).padStart(2, '0')}-15T18:00:00Z`;
      const gameId = await upsertGame(pool, {
        seriesId,
        leaguepediaUniqueLine: `__RM_Game_${i}`,
        gameNumber: 1,
        team1Id: teamId,
        team2Id: teamId,
        winnerTeamId: teamId,
        datetimeUtc: monthDay,
        patch: null,
        team1Gold: null,
        team2Gold: null,
        gamelengthSeconds: null,
      });
      await upsertGameLineup(pool, { gameId, teamId, playerId: establishedJunglerId, role: 'JNG' });
      await upsertGameLineup(pool, { gameId, teamId, playerId: topId, role: 'TOP' });
      await upsertGameLineup(pool, { gameId, teamId, playerId: midId, role: 'MID' });
      await upsertGameLineup(pool, { gameId, teamId, playerId: botId, role: 'BOT' });
      await upsertGameLineup(pool, { gameId, teamId, playerId: supId, role: 'SUP' });
    }

    // One later, anomalous game: a different player appears in the JNG slot.
    // This is the single most recent JNG-tagged row for this team.
    const anomalousSeriesId = await upsertSeries(pool, {
      tournamentId,
      leaguepediaMatchId: '__RM_Match_anomaly',
      team1Id: teamId,
      team2Id: teamId,
      bestOf: 1,
      team1Score: 1,
      team2Score: 0,
      winnerTeamId: teamId,
      isInternational: false,
    });
    const anomalousGameId = await upsertGame(pool, {
      seriesId: anomalousSeriesId,
      leaguepediaUniqueLine: '__RM_Game_anomaly',
      gameNumber: 1,
      team1Id: teamId,
      team2Id: teamId,
      winnerTeamId: teamId,
      datetimeUtc: '2026-08-02T18:00:00Z', // most recent by far
      patch: null,
      team1Gold: null,
      team2Gold: null,
      gamelengthSeconds: null,
    });
    await upsertGameLineup(pool, { gameId: anomalousGameId, teamId, playerId: oneOffSubId, role: 'JNG' });
    await upsertGameLineup(pool, { gameId: anomalousGameId, teamId, playerId: topId, role: 'TOP' });
    await upsertGameLineup(pool, { gameId: anomalousGameId, teamId, playerId: midId, role: 'MID' });
    await upsertGameLineup(pool, { gameId: anomalousGameId, teamId, playerId: botId, role: 'BOT' });
    await upsertGameLineup(pool, { gameId: anomalousGameId, teamId, playerId: supId, role: 'SUP' });
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM roster_memberships WHERE team_id = $1`, [teamId]);
    // Put back every OTHER team's rows, which populateRosterMemberships
    // destroyed as a side effect -- see rosterMembershipsSnapshot.ts.
    await restoreRosterMemberships(pool, rosterSnapshot);
    await pool.query(`DELETE FROM game_lineups WHERE team_id = $1`, [teamId]);
    await pool.query(`DELETE FROM games WHERE leaguepedia_unique_line LIKE '__RM_Game_%'`);
    await pool.query(`DELETE FROM series WHERE leaguepedia_match_id LIKE '__RM_Match_%'`);
    await pool.query(`DELETE FROM tournaments WHERE overview_page = '__RM_Tournament'`);
    await pool.query(`DELETE FROM players WHERE id IN ($1, $2, $3, $4, $5, $6)`, [
      establishedJunglerId,
      oneOffSubId,
      topId,
      midId,
      botId,
      supId,
    ]);
    await pool.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
    await pool.end();
  });

  it('keeps the established player as the JNG starter despite one anomalous most-recent game', async () => {
    await populateRosterMemberships(pool);

    const starters = await pool.query(
      `SELECT player_id FROM roster_memberships WHERE team_id = $1 AND role = 'JNG' AND is_starter = true`,
      [teamId],
    );
    expect(starters.rows).toHaveLength(1);
    expect(starters.rows[0].player_id).toBe(establishedJunglerId);
  });

  it('still surfaces the one-off appearance as a non-starter substitute, not hidden entirely', async () => {
    await populateRosterMemberships(pool);

    const subs = await pool.query(
      `SELECT player_id FROM roster_memberships WHERE team_id = $1 AND role = 'JNG' AND is_starter = false`,
      [teamId],
    );
    expect(subs.rows).toHaveLength(1);
    expect(subs.rows[0].player_id).toBe(oneOffSubId);
  });
});

/**
 * Regression test for a real bug found via user feedback: Cloud9 played a
 * dead-rubber game where all 5 established starters swapped positions with
 * each other for fun (nobody new joined, nobody left). Naive role-change
 * detection treated this as "5 roles changed" = 100% turnover, which (a)
 * spiked Cloud9's rating RD to the maximum, torching a season of established
 * confidence, and (b) made every starter show up as a confusing "substitute"
 * in 4 other positions on the roster page. Both computePlayerRatings.ts
 * (roster display) and replayData.ts (rating decay) needed a fix: a role
 * change only counts as real if the incoming player wasn't ALSO one of the
 * team's other established starters.
 */
describe('populateRosterMemberships handles an internal role reshuffle (live Postgres, synthetic data)', () => {
  let pool: pg.Pool;
  let rosterSnapshot: RosterMembershipRow[];
  let teamId: number;
  let topId: number;
  let jngId: number;
  let midId: number;
  let botId: number;
  let supId: number;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL);
    // populateRosterMemberships wipes the WHOLE table, not just this test's
    // team -- see rosterMembershipsSnapshot.ts.
    rosterSnapshot = await snapshotRosterMemberships(pool);
    teamId = await upsertTeam(pool, { leaguepediaPage: '__RS_Team', slug: '__rs-team', name: 'RS Test Team' });
    topId = await upsertPlayer(pool, { leaguepediaPage: '__RS_Top', handle: 'ReshuffleTop' });
    jngId = await upsertPlayer(pool, { leaguepediaPage: '__RS_Jng', handle: 'ReshuffleJng' });
    midId = await upsertPlayer(pool, { leaguepediaPage: '__RS_Mid', handle: 'ReshuffleMid' });
    botId = await upsertPlayer(pool, { leaguepediaPage: '__RS_Bot', handle: 'ReshuffleBot' });
    supId = await upsertPlayer(pool, { leaguepediaPage: '__RS_Sup', handle: 'ReshuffleSup' });

    const tournamentId = await upsertTournament(pool, {
      overviewPage: '__RS_Tournament',
      name: 'RS Test Tournament',
      rawLeagueName: 'LCS',
      canonicalLeagueId: null,
      tournamentType: 'regional_split',
      dateStart: '2026-01-01',
      dateEnd: '2026-08-01',
    });

    const stableLineup: Record<string, number> = { TOP: topId, JNG: jngId, MID: midId, BOT: botId, SUP: supId };
    const reshuffledLineup: Record<string, number> = { TOP: supId, JNG: botId, MID: topId, BOT: jngId, SUP: midId };

    async function insertGame(matchKey: string, dateIso: string, lineup: Record<string, number>) {
      const seriesId = await upsertSeries(pool, {
        tournamentId,
        leaguepediaMatchId: matchKey,
        team1Id: teamId,
        team2Id: teamId,
        bestOf: 1,
        team1Score: 1,
        team2Score: 0,
        winnerTeamId: teamId,
        isInternational: false,
      });
      const gameId = await upsertGame(pool, {
        seriesId,
        leaguepediaUniqueLine: matchKey,
        gameNumber: 1,
        team1Id: teamId,
        team2Id: teamId,
        winnerTeamId: teamId,
        datetimeUtc: dateIso,
        patch: null,
        team1Gold: null,
        team2Gold: null,
        gamelengthSeconds: null,
      });
      for (const [role, playerId] of Object.entries(lineup)) {
        await upsertGameLineup(pool, { gameId, teamId, playerId, role: role as 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP' });
      }
    }

    // A full season of the stable lineup.
    for (let i = 0; i < 12; i++) {
      await insertGame(`__RS_Match_${i}`, `2026-${String(1 + (i % 7)).padStart(2, '0')}-15T18:00:00Z`, stableLineup);
    }
    // Then a dead-rubber stretch where the same 5 players swap positions.
    for (let i = 0; i < 3; i++) {
      await insertGame(`__RS_Match_reshuffle_${i}`, `2026-08-0${i + 1}T18:00:00Z`, reshuffledLineup);
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM roster_memberships WHERE team_id = $1`, [teamId]);
    // Put back every OTHER team's rows, which populateRosterMemberships
    // destroyed as a side effect -- see rosterMembershipsSnapshot.ts.
    await restoreRosterMemberships(pool, rosterSnapshot);
    await pool.query(`DELETE FROM game_lineups WHERE team_id = $1`, [teamId]);
    await pool.query(`DELETE FROM games WHERE leaguepedia_unique_line LIKE '__RS_Match%'`);
    await pool.query(`DELETE FROM series WHERE leaguepedia_match_id LIKE '__RS_Match%'`);
    await pool.query(`DELETE FROM tournaments WHERE overview_page = '__RS_Tournament'`);
    await pool.query(`DELETE FROM players WHERE id IN ($1, $2, $3, $4, $5)`, [topId, jngId, midId, botId, supId]);
    await pool.query(`DELETE FROM teams WHERE id = $1`, [teamId]);
    await pool.end();
  });

  it('keeps each player as the primary in their real role, not the reshuffled one', async () => {
    await populateRosterMemberships(pool);

    const starters = await pool.query<{ role: string; player_id: number }>(
      `SELECT role, player_id FROM roster_memberships WHERE team_id = $1 AND is_starter = true`,
      [teamId],
    );
    const starterByRole = new Map(starters.rows.map((row) => [row.role, row.player_id]));
    expect(starterByRole.get('TOP')).toBe(topId);
    expect(starterByRole.get('JNG')).toBe(jngId);
    expect(starterByRole.get('MID')).toBe(midId);
    expect(starterByRole.get('BOT')).toBe(botId);
    expect(starterByRole.get('SUP')).toBe(supId);
  });

  it('does not list existing starters as substitutes in each other\'s roles from the reshuffle', async () => {
    await populateRosterMemberships(pool);

    const subs = await pool.query(`SELECT role, player_id FROM roster_memberships WHERE team_id = $1 AND is_starter = false`, [
      teamId,
    ]);
    expect(subs.rows).toHaveLength(0);
  });
});
