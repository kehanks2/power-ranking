import type { Pool } from 'pg';
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
  type ReplayInput,
} from '@power-ranking/rating-engine';
import { loadReplayData } from './replayData.js';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;

/**
 * Loads all data needed for a full replay from Postgres (via loadReplayData),
 * runs the pure rating-engine replay, and persists the resulting history.
 * Safe to re-run from scratch at any time -- see plan's "full replay is
 * always the supported recovery path."
 *
 * Must run AFTER computePlayerRatings (player_ratings_history feeds the
 * roster-decay prior) -- see manualRecompute.ts for the pipeline order.
 */
/**
 * Minimum games at international events before a team is rated on that board.
 * Below this the rating is noise: at a 5-game floor KT Rolster placed 2nd on 7
 * games with an RD of 206. Teams under the floor are not rated low -- they are
 * absent, because nothing has been demonstrated.
 */
export const MIN_INTERNATIONAL_GAMES = 10;

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
    },
  };

  const result = runReplay(replayInput);

  // Second, independent replay over every game played AT an international
  // event, with the league prior switched off.
  //
  // Deliberately not restricted to cross-region matchups. Two LPL sides
  // meeting at Worlds is international play, and it is real evidence about
  // where both stand in that field -- excluding it would drop Weibo Gaming,
  // a 2024 Worlds semifinalist, from the board because 7 of their 16 games
  // there were against other LPL teams. Everyone in this pool played inside
  // the same set of events, so the comparison holds without the league prior.
  const internationalGames = games.filter(
    (g) => g.internationalEvent && (internationalWindowStart === null || g.datetimeUtc >= internationalWindowStart),
  );
  const internationalGameCount = new Map<string, number>();
  for (const game of internationalGames) {
    for (const teamId of [game.team1Id, game.team2Id]) {
      internationalGameCount.set(teamId, (internationalGameCount.get(teamId) ?? 0) + 1);
    }
  }
  const internationalResult = runReplay({
    ...replayInput,
    games: internationalGames,
    config: { ...replayInput.config, metaWeight: 0, internationalWeightMultiplier: 1 },
  });
  const qualifiedInternational = internationalResult.teamHistory.filter(
    (s) => (internationalGameCount.get(s.teamId) ?? 0) >= MIN_INTERNATIONAL_GAMES,
  );

  // A real bug lived here: pool.query('BEGIN')/'COMMIT' issue each statement
  // through whatever connection the pool happens to hand back, which is NOT
  // guaranteed to be the same connection across calls -- so this was never
  // actually one atomic transaction. Under any concurrent pool usage (e.g.
  // running the test suite), the DELETEs could commit on one connection while
  // INSERTs landed on another (or failed silently), leaving the ratings
  // tables wiped with no replacement rows -- confirmed in practice: every
  // team fell back to cold-start display values after a test run. Fixed by
  // pinning the whole transaction to one dedicated client via pool.connect().
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM team_ratings_history');
    await client.query('DELETE FROM league_ratings_history');

    for (const snapshot of result.teamHistory) {
      await client.query(
        `INSERT INTO team_ratings_history (team_id, as_of_date, mu_ctx, phi_ctx, sigma_ctx, reason, roster_implied_mu, method_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 1)`,
        [
          Number(snapshot.teamId),
          snapshot.asOfDate,
          snapshot.mu,
          snapshot.phi,
          snapshot.sigma,
          snapshot.reason,
          snapshot.rosterImpliedMu ?? null,
        ],
      );
    }
    for (const snapshot of qualifiedInternational) {
      await client.query(
        `INSERT INTO team_ratings_history (team_id, as_of_date, mu_ctx, phi_ctx, sigma_ctx, reason, method_version, scope)
         VALUES ($1, $2, $3, $4, $5, $6, 1, 'international')`,
        [Number(snapshot.teamId), snapshot.asOfDate, snapshot.mu, snapshot.phi, snapshot.sigma, snapshot.reason],
      );
    }
    for (const snapshot of result.leagueHistory) {
      await client.query(
        `INSERT INTO league_ratings_history (league_id, as_of_date, mu_meta, phi_meta, sigma_meta, method_version)
         VALUES ($1, $2, $3, $4, $5, 1)`,
        [Number(snapshot.leagueId), snapshot.asOfDate, snapshot.mu, snapshot.phi, snapshot.sigma],
      );
    }
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
