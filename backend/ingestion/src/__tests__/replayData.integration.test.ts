/**
 * Regression test for the rating-side half of the Cloud9 reshuffle bug (see
 * computePlayerRatings.integration.test.ts for the roster-display half):
 * corrupted source data that relabels a team's 5 established starters'
 * positions (nobody new, nobody left) must NOT be treated as 100% roster
 * turnover. Confirmed in practice this spiked a team's RD to the maximum
 * right after a season of stable, well-established data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { createPool } from '../db.js';
import { upsertTeam, upsertPlayer, upsertGameLineup, upsertTournament, upsertSeries, upsertGame } from '../upsert.js';
import { loadReplayData } from '../replayData.js';
import type { RosterDecayEvent } from '@power-ranking/rating-engine';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

describe('loadReplayData roster-change decay events (live Postgres, synthetic data)', () => {
  let pool: pg.Pool;
  let teamId: number;
  let opponentId: number;
  let lcsLeagueId: number;
  let topId: number;
  let jngId: number;
  let midId: number;
  let botId: number;
  let supId: number;
  let newPlayerId: number;

  beforeAll(async () => {
    pool = createPool(DATABASE_URL);
    const league = await pool.query<{ id: number }>(`SELECT id FROM leagues WHERE slug = 'LCS'`);
    lcsLeagueId = league.rows[0].id;

    teamId = await upsertTeam(pool, { leaguepediaPage: '__RD_Team', slug: '__rd-team', name: 'RD Test Team' });
    opponentId = await upsertTeam(pool, { leaguepediaPage: '__RD_Opponent', slug: '__rd-opponent', name: 'RD Opponent' });
    await pool.query(
      `INSERT INTO team_league_memberships (team_id, league_id, start_date) VALUES ($1, $2, '2020-01-01'), ($3, $2, '2020-01-01')`,
      [teamId, lcsLeagueId, opponentId],
    );

    topId = await upsertPlayer(pool, { leaguepediaPage: '__RD_Top', handle: 'RDTop' });
    jngId = await upsertPlayer(pool, { leaguepediaPage: '__RD_Jng', handle: 'RDJng' });
    midId = await upsertPlayer(pool, { leaguepediaPage: '__RD_Mid', handle: 'RDMid' });
    botId = await upsertPlayer(pool, { leaguepediaPage: '__RD_Bot', handle: 'RDBot' });
    supId = await upsertPlayer(pool, { leaguepediaPage: '__RD_Sup', handle: 'RDSup' });
    newPlayerId = await upsertPlayer(pool, { leaguepediaPage: '__RD_New', handle: 'RDNewSignee' });

    const tournamentId = await upsertTournament(pool, {
      overviewPage: '__RD_Tournament',
      name: 'RD Test Tournament',
      rawLeagueName: 'LCS',
      canonicalLeagueId: lcsLeagueId,
      tournamentType: 'regional_split',
      dateStart: '2026-01-01',
      dateEnd: '2026-08-10',
    });

    const stableLineup: Record<string, number> = { TOP: topId, JNG: jngId, MID: midId, BOT: botId, SUP: supId };
    const reshuffledLineup: Record<string, number> = { TOP: supId, JNG: botId, MID: topId, BOT: jngId, SUP: midId };
    const realSwapLineup: Record<string, number> = { TOP: newPlayerId, JNG: jngId, MID: midId, BOT: botId, SUP: supId };

    async function insertGame(matchKey: string, dateIso: string, lineup: Record<string, number>) {
      const seriesId = await upsertSeries(pool, {
        tournamentId,
        leaguepediaMatchId: matchKey,
        team1Id: teamId,
        team2Id: opponentId,
        bestOf: 1,
        team1Score: 1,
        team2Score: 0,
        winnerTeamId: teamId,
        isInternational: false,
        bracketId: null,
        dateUtc: dateIso,
      });
      const gameId = await upsertGame(pool, {
        seriesId,
        leaguepediaUniqueLine: matchKey,
        gameNumber: 1,
        team1Id: teamId,
        team2Id: opponentId,
        winnerTeamId: teamId,
        datetimeUtc: dateIso,
        patch: null,
        team1Gold: null,
        team2Gold: null,
        gamelengthSeconds: null,
        team1NeutralObjectives: null,
        team2NeutralObjectives: null,
      });
      for (const [role, playerId] of Object.entries(lineup)) {
        await upsertGameLineup(pool, { gameId, teamId, playerId, role: role as 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP' });
      }
    }

    for (let i = 0; i < 12; i++) {
      await insertGame(`__RD_Match_${i}`, `2026-${String(1 + (i % 6)).padStart(2, '0')}-15T18:00:00Z`, stableLineup);
    }
    // Dead-rubber reshuffle: same 5 players, different positions.
    for (let i = 0; i < 3; i++) {
      await insertGame(`__RD_Match_reshuffle_${i}`, `2026-07-2${i + 1}T18:00:00Z`, reshuffledLineup);
    }
    // Then a real swap: a new player takes over TOP. Needs the persistence
    // threshold's worth of games (5) to register as turnover.
    for (let i = 0; i < 5; i++) {
      await insertGame(`__RD_Match_realswap_${i}`, `2026-08-0${i + 1}T18:00:00Z`, realSwapLineup);
    }
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM game_lineups WHERE team_id IN ($1, $2)`, [teamId, opponentId]);
    await pool.query(`DELETE FROM games WHERE leaguepedia_unique_line LIKE '__RD_Match%'`);
    await pool.query(`DELETE FROM series WHERE leaguepedia_match_id LIKE '__RD_Match%'`);
    await pool.query(`DELETE FROM tournaments WHERE overview_page = '__RD_Tournament'`);
    await pool.query(`DELETE FROM team_league_memberships WHERE team_id IN ($1, $2)`, [teamId, opponentId]);
    await pool.query(`DELETE FROM players WHERE id IN ($1, $2, $3, $4, $5, $6)`, [topId, jngId, midId, botId, supId, newPlayerId]);
    await pool.query(`DELETE FROM teams WHERE id IN ($1, $2)`, [teamId, opponentId]);
    await pool.end();
  });

  it('does not generate a roster-change decay event for a pure internal reshuffle, but does for a real swap', async () => {
    const { decayEvents } = await loadReplayData(pool);
    const teamEvents = decayEvents.filter(
      (e): e is RosterDecayEvent => e.kind === 'roster_change' && e.teamId === String(teamId),
    );

    // No event dated around the reshuffle (late July) -- it's not real turnover.
    const reshuffleEvent = teamEvents.find((e) => e.effectiveDate >= '2026-07-20' && e.effectiveDate < '2026-08-01');
    expect(reshuffleEvent).toBeUndefined();

    // But the later genuine swap is detected, turnover reflecting the one real
    // change (1/5).
    const realSwapEvent = teamEvents.find((e) => e.effectiveDate >= '2026-08-01');
    expect(realSwapEvent).toBeDefined();
    expect(realSwapEvent!.turnover).toBeCloseTo(1 / 5, 5);
  });
});
