import type { Pool } from 'pg';
import type { LineupGame, Role } from '@power-ranking/rating-engine';

/**
 * Loads every team's chronological per-game lineup from game_lineups, keeping
 * only games where all 5 roles are recorded. Shared by computeRatings.ts
 * (roster-change decay events) and computePlayerRatings.ts (roster_memberships
 * history) so both consume the exact same lineup timeline.
 */
export async function buildTeamLineupGames(pool: Pool): Promise<Map<number, LineupGame[]>> {
  const lineupResult = await pool.query<{
    team_id: number;
    role: Role;
    player_id: number;
    game_id: number;
    datetime_utc: Date;
  }>(`
    SELECT gl.team_id, gl.role, gl.player_id, gl.game_id, g.datetime_utc
    FROM game_lineups gl
    JOIN games g ON g.id = gl.game_id
    ORDER BY gl.team_id, g.datetime_utc
  `);

  const gamesByTeam = new Map<number, Map<number, { roles: Partial<Record<Role, number>>; playedAt: Date }>>();
  for (const row of lineupResult.rows) {
    if (!gamesByTeam.has(row.team_id)) gamesByTeam.set(row.team_id, new Map());
    const gameMap = gamesByTeam.get(row.team_id)!;
    if (!gameMap.has(row.game_id)) gameMap.set(row.game_id, { roles: {}, playedAt: row.datetime_utc });
    gameMap.get(row.game_id)!.roles[row.role] = row.player_id;
  }

  const result = new Map<number, LineupGame[]>();
  for (const [teamId, gameMap] of gamesByTeam) {
    const lineupGames: LineupGame[] = [];
    for (const [gameId, { roles, playedAt }] of gameMap) {
      if (roles.TOP && roles.JNG && roles.MID && roles.BOT && roles.SUP) {
        lineupGames.push({
          gameId: String(gameId),
          playedAt: playedAt.toISOString(),
          lineup: { TOP: String(roles.TOP), JNG: String(roles.JNG), MID: String(roles.MID), BOT: String(roles.BOT), SUP: String(roles.SUP) },
        });
      }
    }
    lineupGames.sort((a, b) => (a.playedAt < b.playedAt ? -1 : a.playedAt > b.playedAt ? 1 : 0));
    result.set(teamId, lineupGames);
  }
  return result;
}
