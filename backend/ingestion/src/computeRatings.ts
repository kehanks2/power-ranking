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
 * Minimum games at international events before a team is rated on that board.
 * Below this the rating is noise (KT Rolster placed 2nd on 7 games, RD 206);
 * such teams are absent, not rated low.
 */
export const MIN_INTERNATIONAL_GAMES = 10;

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
    },
  };

  const result = runReplay(replayInput);

  // Second, independent replay over every game played AT an international event,
  // league prior off. Includes same-region matchups (two LPL sides at Worlds is
  // still evidence; excluding them would drop Weibo Gaming, a Worlds semifinalist
  // whose games there were mostly intra-LPL) -- the shared event pool holds it
  // together without the league prior.
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

  // Pin the transaction to one client. pool.query('BEGIN') can hand each
  // statement a different connection, so DELETEs and INSERTs land on separate
  // ones and the tables get wiped with no replacements -- seen under concurrent
  // pool use (the test suite).
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
