import type { Pool } from 'pg';
import { cargoQueryAll } from './cargoClient.js';
import type { CargoTournamentRow, CargoScoreboardGameRow, CargoScoreboardPlayerRow } from './cargoTypes.js';
import { normalizeRole } from './cargoTypes.js';
import { resolveLeagueAlias, type LeagueAlias } from './leagueAlias.js';
import {
  upsertTeam,
  upsertPlayer,
  upsertTournament,
  upsertSeries,
  upsertGame,
  upsertGameLineup,
  ensureTeamLeagueMembership,
} from './upsert.js';
import { slugify } from './slug.js';

export interface IngestLeagueResult {
  tournamentsProcessed: number;
  gamesUpserted: number;
  playersSeen: number;
  unresolvedLeagueTournaments: string[];
}

/**
 * Pulls every tournament for `rawLeagueName` (plus each tournament's games and
 * per-game lineups) and upserts them. Idempotent -- safe to re-run for the
 * same league repeatedly (e.g. on a schedule) without duplicating rows.
 */
export async function ingestLeagueTournaments(
  pool: Pool,
  rawLeagueName: string,
  aliases: LeagueAlias[],
  options: { sinceDate?: string; teamSlugCache?: Map<string, number> } = {},
): Promise<IngestLeagueResult> {
  const teamIdByPage = options.teamSlugCache ?? new Map<string, number>();
  const playerIdByPage = new Map<string, number>();
  const result: IngestLeagueResult = {
    tournamentsProcessed: 0,
    gamesUpserted: 0,
    playersSeen: 0,
    unresolvedLeagueTournaments: [],
  };

  const whereParts = [`League="${rawLeagueName}"`];
  if (options.sinceDate) whereParts.push(`DateStart >= "${options.sinceDate}"`);

  const tournaments = await cargoQueryAll<CargoTournamentRow>({
    tables: 'Tournaments',
    fields: 'OverviewPage,Name,League,DateStart,DateEnd',
    where: whereParts.join(' AND '),
  });

  async function getOrCreateTeamId(teamPage: string): Promise<number> {
    const cached = teamIdByPage.get(teamPage);
    if (cached) return cached;
    const id = await upsertTeam(pool, { leaguepediaPage: teamPage, slug: slugify(teamPage), name: teamPage });
    teamIdByPage.set(teamPage, id);
    return id;
  }

  async function getOrCreatePlayerId(playerPage: string): Promise<number> {
    const cached = playerIdByPage.get(playerPage);
    if (cached) return cached;
    const id = await upsertPlayer(pool, { leaguepediaPage: playerPage, handle: playerPage });
    playerIdByPage.set(playerPage, id);
    return id;
  }

  for (const tournament of tournaments) {
    const canonicalLeagueId = resolveLeagueAlias(rawLeagueName, tournament.DateStart, aliases);
    if (canonicalLeagueId === null) {
      result.unresolvedLeagueTournaments.push(tournament.OverviewPage);
    }

    const tournamentId = await upsertTournament(pool, {
      overviewPage: tournament.OverviewPage,
      name: tournament.Name,
      rawLeagueName,
      canonicalLeagueId,
      tournamentType: 'regional_split',
      dateStart: tournament.DateStart,
      dateEnd: tournament.DateEnd || null,
    });
    result.tournamentsProcessed += 1;

    const games = await cargoQueryAll<CargoScoreboardGameRow>({
      tables: 'ScoreboardGames',
      fields:
        'UniqueLine,GameId,MatchId,Tournament,Team1,Team2,WinTeam,DateTime_UTC,Team1Score,Team2Score,Team1Gold,Team2Gold,Gamelength_Number,Patch',
      where: `Tournament="${tournament.OverviewPage}"`,
      orderBy: 'DateTime_UTC',
    });

    // MatchId -> internal series id, and running game-number counter per MatchId.
    const seriesIdByMatchId = new Map<string, number>();
    const gameNumberByMatchId = new Map<string, number>();
    const internalGameIdByLeaguepediaGameId = new Map<string, number>();

    for (const game of games) {
      const team1Id = await getOrCreateTeamId(game.Team1);
      const team2Id = await getOrCreateTeamId(game.Team2);
      if (canonicalLeagueId !== null) {
        await ensureTeamLeagueMembership(pool, { teamId: team1Id, leagueId: canonicalLeagueId, asOfDate: tournament.DateStart });
        await ensureTeamLeagueMembership(pool, { teamId: team2Id, leagueId: canonicalLeagueId, asOfDate: tournament.DateStart });
      }
      const winnerTeamId = game.WinTeam === game.Team1 ? team1Id : team2Id;

      let seriesId = seriesIdByMatchId.get(game.MatchId);
      if (!seriesId) {
        seriesId = await upsertSeries(pool, {
          tournamentId,
          leaguepediaMatchId: game.MatchId,
          team1Id,
          team2Id,
          bestOf: null,
          team1Score: game.Team1Score ? Number(game.Team1Score) : null,
          team2Score: game.Team2Score ? Number(game.Team2Score) : null,
          winnerTeamId,
          isInternational: false,
        });
        seriesIdByMatchId.set(game.MatchId, seriesId);
        gameNumberByMatchId.set(game.MatchId, 0);
      }
      const gameNumber = (gameNumberByMatchId.get(game.MatchId) ?? 0) + 1;
      gameNumberByMatchId.set(game.MatchId, gameNumber);

      const gamelengthMinutes = game.Gamelength_Number ? Number(game.Gamelength_Number) : null;
      const internalGameId = await upsertGame(pool, {
        seriesId,
        leaguepediaUniqueLine: game.UniqueLine,
        gameNumber,
        team1Id,
        team2Id,
        winnerTeamId,
        datetimeUtc: game.DateTime_UTC,
        patch: game.Patch || null,
        team1Gold: game.Team1Gold ? Number(game.Team1Gold) : null,
        team2Gold: game.Team2Gold ? Number(game.Team2Gold) : null,
        gamelengthSeconds: gamelengthMinutes !== null ? Math.round(gamelengthMinutes * 60) : null,
      });
      internalGameIdByLeaguepediaGameId.set(game.GameId, internalGameId);
      result.gamesUpserted += 1;
    }

    const players = await cargoQueryAll<CargoScoreboardPlayerRow>({
      tables: 'ScoreboardPlayers',
      fields: 'GameId,Tournament,Link,Team,IngameRole,Kills,Deaths,Assists,Gold,DamageToChampions',
      where: `Tournament="${tournament.OverviewPage}"`,
    });

    for (const playerRow of players) {
      const role = normalizeRole(playerRow.IngameRole);
      const internalGameId = internalGameIdByLeaguepediaGameId.get(playerRow.GameId);
      if (!role || !internalGameId) continue; // sub/coach rows or a game we didn't ingest; skip rather than guess

      const playerId = await getOrCreatePlayerId(playerRow.Link);
      const teamId = await getOrCreateTeamId(playerRow.Team);
      await upsertGameLineup(pool, { gameId: internalGameId, teamId, playerId, role });
      result.playersSeen += 1;
    }
  }

  return result;
}
