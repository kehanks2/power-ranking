import type { Pool } from 'pg';
import { NEWEST_INTERNATIONAL_EVENT_TEAMS_SQL } from '@power-ranking/shared';
import {
  runReplay,
  GLICKO2_SCALE,
  DEFAULT_VOLATILITY,
  MARGIN_SCALE,
  MOV_WEIGHT_CAP,
  META_WEIGHT,
  SERIES_CORRELATION,
  RATING_PERIOD_DAYS,
  INTERNATIONAL_WEIGHT_MULTIPLIER,
  LEAGUE_TERM_HALF_LIFE_GAMES,
  TEAM_INTERNATIONAL_RD,
  TEAM_INTERNATIONAL_HALF_LIFE_DAYS,
  PLAY_IN_WEIGHT,
  type ReplayInput,
} from '@power-ranking/rating-engine';
import { loadReplayData } from './replayData.js';
import { bulkInsert } from './bulkInsert.js';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;

/**
 * Minimum games at international events before a team is rated on that board.
 * Below this the rating is noise (KT Rolster placed 2nd on 7 games, RD 206);
 * such teams are absent, not rated low.
 *
 * A team at the event currently being played is exempt -- see
 * `teamsAtNewestInternationalEvent`.
 */
export const MIN_INTERNATIONAL_GAMES = 10;

/**
 * Teams playing the newest international event that has games.
 *
 * They are rated however few games they have, because a board that omits half
 * the teams currently on stage answers the wrong question -- Cloud9 played a
 * full Worlds 26 play-in run, went out on 9 games, and never appeared. The
 * exemption lapses on its own: the set is recomputed from whichever event is
 * newest, so a team that does not turn up to the next one falls back on the
 * game threshold and leaves the board.
 *
 * The predicate itself is NEWEST_INTERNATIONAL_EVENT_TEAMS_SQL, shared so the
 * board the API serves is asserted against the rule that wrote it.
 */
export async function teamsAtNewestInternationalEvent(pool: Pool): Promise<Set<string>> {
  const result = await pool.query<{ team_id: number }>(NEWEST_INTERNATIONAL_EVENT_TEAMS_SQL);
  return new Set(result.rows.map((row) => String(row.team_id)));
}

/**
 * Full replay from Postgres, persisting the resulting history. Safe to re-run
 * from scratch. Must run AFTER computePlayerRatings (player_ratings_history
 * feeds the roster-decay prior) -- see manualRecompute.ts for pipeline order.
 */
export async function computeRatings(pool: Pool): Promise<{ teamRows: number; leagueRows: number; internationalRows: number }> {
  const { teamIds, leagueIds, games, decayEvents, internationalWindowStart } = await loadReplayData(pool);

  const replayInput: ReplayInput = {
    teamIds,
    leagueIds,
    games,
    decayEvents,
    config: {
      phiInitMax: PHI_INIT_MAX,
      sigmaDefault: DEFAULT_VOLATILITY,
      marginScale: MARGIN_SCALE,
      movWeightCap: MOV_WEIGHT_CAP,
      metaWeight: META_WEIGHT,
      seriesCorrelation: SERIES_CORRELATION,
      ratingPeriodDays: RATING_PERIOD_DAYS,
      internationalWeightMultiplier: INTERNATIONAL_WEIGHT_MULTIPLIER,
      // Contextual is a team's standing within its league; cross-region games
      // move only the league term and the team's own international deviation.
      contextualLearnsInternational: false,
      teamInternationalPhiInit: TEAM_INTERNATIONAL_RD / GLICKO2_SCALE,
      teamInternationalHalfLifeDays: TEAM_INTERNATIONAL_HALF_LIFE_DAYS,
      teamInternationalRosterReset: true,
      metaShrinkHalfLifeGames: LEAGUE_TERM_HALF_LIFE_GAMES,
      playInWeight: PLAY_IN_WEIGHT,
    },
  };

  const result = runReplay(replayInput);

  // The international board is the combined strength the replay grades a
  // cross-region game with. Who appears on it is still decided by games at the
  // last six events.
  const internationalGameCount = new Map<string, number>();
  for (const game of games) {
    if (!game.internationalEvent || (internationalWindowStart !== null && game.datetimeUtc < internationalWindowStart)) continue;
    for (const teamId of [game.team1Id, game.team2Id]) {
      internationalGameCount.set(teamId, (internationalGameCount.get(teamId) ?? 0) + 1);
    }
  }
  const atNewestEvent = await teamsAtNewestInternationalEvent(pool);
  const qualifiedInternational = (result.combinedHistory ?? []).filter(
    (s) => (internationalGameCount.get(s.teamId) ?? 0) >= MIN_INTERNATIONAL_GAMES || atNewestEvent.has(s.teamId),
  );

  // Pin the transaction to one client. pool.query('BEGIN') can hand each
  // statement a different connection, so DELETEs and INSERTs land on separate
  // ones and the tables get wiped with no replacements -- seen under concurrent
  // pool use (the test suite).
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM team_ratings_history');
    await client.query('DELETE FROM league_ratings_history');

    // Replay inserts chronologically and readers break as_of_date ties on id,
    // so the rows must keep replay order. bulkInsert preserves array order.
    await bulkInsert(
      client,
      'team_ratings_history',
      ['team_id', 'as_of_date', 'mu_ctx', 'phi_ctx', 'sigma_ctx', 'reason', 'roster_implied_mu', 'method_version'],
      result.teamHistory.map((snapshot) => [
        Number(snapshot.teamId),
        snapshot.asOfDate,
        snapshot.mu,
        snapshot.phi,
        snapshot.sigma,
        snapshot.reason,
        snapshot.rosterImpliedMu ?? null,
        1,
      ]),
    );
    await bulkInsert(
      client,
      'team_ratings_history',
      ['team_id', 'as_of_date', 'mu_ctx', 'phi_ctx', 'sigma_ctx', 'reason', 'method_version', 'scope'],
      qualifiedInternational.map((snapshot) => [
        Number(snapshot.teamId),
        snapshot.asOfDate,
        snapshot.mu,
        snapshot.phi,
        snapshot.sigma,
        snapshot.reason,
        1,
        'international',
      ]),
    );
    await bulkInsert(
      client,
      'league_ratings_history',
      ['league_id', 'as_of_date', 'mu_meta', 'phi_meta', 'sigma_meta', 'method_version'],
      result.leagueHistory.map((snapshot) => [
        Number(snapshot.leagueId),
        snapshot.asOfDate,
        snapshot.mu,
        snapshot.phi,
        snapshot.sigma,
        1,
      ]),
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    teamRows: result.teamHistory.length,
    leagueRows: result.leagueHistory.length,
    internationalRows: qualifiedInternational.length,
  };
}
