/**
 * Ingests Oracle's Elixir's daily-updated match-data CSV
 * (https://oracleselixir.com/tools/downloads, free/CC-BY-SA per their terms,
 * crediting Leaguepedia for underlying data). Adopted as the primary data
 * source for MVP after Leaguepedia's own Cargo API proved persistently
 * rate-limited/blocked in practice -- see plan doc addendum.
 *
 * Each `gameid` has 12 rows: 2 team-aggregate rows (position="team") and 10
 * player rows (position=top/jng/mid/bot/sup). One CSV gameid is treated as
 * one series and one game (OE's data has no separate series/match grouping,
 * and the rating engine operates at the per-game level regardless).
 *
 * Two ingestion passes, both exported from here:
 * - `ingestOracleElixirCsv`: the 6 canonical regional leagues, as intra-league
 *   games. Also the ONLY pass that writes team_league_memberships -- a team's
 *   home region comes exclusively from its regional-split rows.
 * - `ingestInternationalOeCsv`: bridge events (MSI etc.), where OE's `league`
 *   column is the event name, not either team's home region. Correctness
 *   here doesn't come from that column at all: `computeRatings.ts` resolves
 *   each team's home league via `team_league_memberships` for every game it
 *   loads, so as long as this pass (a) reuses the same team identity (OE's
 *   stable teamid) already established by the regional pass, and (b) never
 *   touches team_league_memberships itself, the replay engine automatically
 *   detects team1LeagueId !== team2LeagueId and routes the game to the
 *   cross-region meta update -- no separate "is this international" logic
 *   needed beyond not corrupting home-league membership.
 */
import type { Pool } from 'pg';
import type { Role } from '@power-ranking/rating-engine';
import { resolveLeagueAlias, type LeagueAlias } from './leagueAlias.js';
import { upsertTeam, upsertPlayer, upsertTournament, upsertSeries, upsertGame, upsertGameLineup, ensureTeamLeagueMembership } from './upsert.js';
import { upsertPlayerGamePerformance } from './computePlayerRatings.js';
import { slugify } from './slug.js';

export const CANONICAL_LEAGUES = new Set(['LCK', 'LPL', 'LEC', 'LCS', 'CBLOL', 'LCP']);
export const INTERNATIONAL_EVENTS = new Set(['MSI', 'WLDs', 'FST']);

interface OeRow {
  gameid: string;
  league: string;
  year: string;
  split: string;
  playoffs: string;
  date: string;
  position: string;
  playername: string;
  playerid: string;
  teamname: string;
  teamid: string;
  side: string;
  result: string;
  gamelength: string;
  totalgold: string;
  damagetochampions: string;
  kills: string;
  deaths: string;
  assists: string;
  teamkills: string;
  earnedgoldshare: string;
  damageshare: string;
}

/** Minimal CSV line splitter, quote-aware (OE fields are simple but names can occasionally need it). */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}

function parseCsv(csvText: string): OeRow[] {
  const lines = csvText.split('\n').filter((l) => l.trim().length > 0);
  const header = splitCsvLine(lines[0]);
  const rows: OeRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const row: Record<string, string> = {};
    header.forEach((col, idx) => {
      row[col] = cells[idx] ?? '';
    });
    rows.push(row as unknown as OeRow);
  }
  return rows;
}

const ROLE_MAP: Record<string, Role> = { top: 'TOP', jng: 'JNG', mid: 'MID', bot: 'BOT', sup: 'SUP' };

export interface IngestOeCsvResult {
  gamesProcessed: number;
  gamesSkipped: number;
  playersSeen: number;
}

interface ProcessGamesOptions {
  /** Regional-split passes write team_league_memberships; international passes must not. */
  updateLeagueMembership: boolean;
  isInternational: boolean;
  tournamentTypeOverride?: 'international';
}

async function processGameRows(
  pool: Pool,
  byGameId: Map<string, OeRow[]>,
  aliases: LeagueAlias[],
  options: ProcessGamesOptions,
): Promise<IngestOeCsvResult> {
  const teamIdByOeId = new Map<string, number>();
  const playerIdByOeId = new Map<string, number>();
  const tournamentIdByKey = new Map<string, number>();
  const result: IngestOeCsvResult = { gamesProcessed: 0, gamesSkipped: 0, playersSeen: 0 };

  async function getOrCreateTeamId(oeTeamId: string, teamName: string): Promise<number> {
    const cached = teamIdByOeId.get(oeTeamId);
    if (cached) return cached;
    const id = await upsertTeam(pool, { leaguepediaPage: oeTeamId, slug: slugify(teamName), name: teamName });
    teamIdByOeId.set(oeTeamId, id);
    return id;
  }

  async function getOrCreatePlayerId(oePlayerId: string, playerName: string): Promise<number> {
    const cached = playerIdByOeId.get(oePlayerId);
    if (cached) return cached;
    const id = await upsertPlayer(pool, { leaguepediaPage: oePlayerId, handle: playerName });
    playerIdByOeId.set(oePlayerId, id);
    return id;
  }

  for (const [gameId, gameRows] of byGameId) {
    const teamRows = gameRows.filter((r) => r.position === 'team');
    const playerRows = gameRows.filter((r) => r.position !== 'team');
    if (teamRows.length !== 2 || playerRows.length === 0) {
      result.gamesSkipped += 1;
      continue;
    }

    const [rowA, rowB] = teamRows;
    const dateOnly = rowA.date.slice(0, 10);
    const canonicalLeagueId = resolveLeagueAlias(rowA.league, dateOnly, aliases);

    const team1Id = await getOrCreateTeamId(rowA.teamid, rowA.teamname);
    const team2Id = await getOrCreateTeamId(rowB.teamid, rowB.teamname);
    if (options.updateLeagueMembership && canonicalLeagueId !== null) {
      await ensureTeamLeagueMembership(pool, { teamId: team1Id, leagueId: canonicalLeagueId, asOfDate: dateOnly });
      await ensureTeamLeagueMembership(pool, { teamId: team2Id, leagueId: canonicalLeagueId, asOfDate: dateOnly });
    }

    const tournamentKey = `${rowA.league}_${rowA.year}_${rowA.split}`;
    let tournamentId = tournamentIdByKey.get(tournamentKey);
    if (!tournamentId) {
      tournamentId = await upsertTournament(pool, {
        overviewPage: `oe:${tournamentKey}`,
        name: tournamentKey,
        rawLeagueName: rowA.league,
        canonicalLeagueId,
        tournamentType: options.tournamentTypeOverride ?? (rowA.playoffs === '1' ? 'playoffs' : 'regional_split'),
        dateStart: dateOnly,
        dateEnd: null,
      });
      tournamentIdByKey.set(tournamentKey, tournamentId);
    }

    const winnerTeamId = rowA.result === '1' ? team1Id : team2Id;
    const seriesId = await upsertSeries(pool, {
      tournamentId,
      leaguepediaMatchId: `oe:${gameId}`,
      team1Id,
      team2Id,
      bestOf: 1,
      team1Score: rowA.result === '1' ? 1 : 0,
      team2Score: rowB.result === '1' ? 1 : 0,
      winnerTeamId,
      isInternational: options.isInternational,
    });

    const gamelengthSeconds = rowA.gamelength ? Number(rowA.gamelength) : null;
    const internalGameId = await upsertGame(pool, {
      seriesId,
      leaguepediaUniqueLine: `oe:${gameId}`,
      gameNumber: 1,
      team1Id,
      team2Id,
      winnerTeamId,
      datetimeUtc: rowA.date.replace(' ', 'T') + 'Z',
      patch: null,
      team1Gold: rowA.totalgold ? Number(rowA.totalgold) : null,
      team2Gold: rowB.totalgold ? Number(rowB.totalgold) : null,
      gamelengthSeconds,
    });

    for (const playerRow of playerRows) {
      const role = ROLE_MAP[playerRow.position];
      if (!role) continue;
      const playerId = await getOrCreatePlayerId(playerRow.playerid, playerRow.playername);
      const teamId = playerRow.teamid === rowA.teamid ? team1Id : team2Id;
      await upsertGameLineup(pool, { gameId: internalGameId, teamId, playerId, role });

      const kills = playerRow.kills ? Number(playerRow.kills) : 0;
      const deaths = playerRow.deaths ? Number(playerRow.deaths) : 0;
      const assists = playerRow.assists ? Number(playerRow.assists) : 0;
      const teamkills = playerRow.teamkills ? Number(playerRow.teamkills) : 0;
      await upsertPlayerGamePerformance(pool, {
        gameId: internalGameId,
        playerId,
        teamId,
        role,
        kills,
        deaths,
        assists,
        gold: playerRow.totalgold ? Number(playerRow.totalgold) : 0,
        damageToChampions: playerRow.damagetochampions ? Number(playerRow.damagetochampions) : 0,
        goldShare: playerRow.earnedgoldshare ? Number(playerRow.earnedgoldshare) : null,
        damageShare: playerRow.damageshare ? Number(playerRow.damageshare) : null,
        killParticipation: teamkills > 0 ? (kills + assists) / teamkills : null,
      });

      result.playersSeen += 1;
    }

    result.gamesProcessed += 1;
  }

  return result;
}

/** Regional-split games for the 6 canonical leagues. Writes team_league_memberships. */
export async function ingestOracleElixirCsv(pool: Pool, csvText: string, aliases: LeagueAlias[]): Promise<IngestOeCsvResult> {
  const rows = parseCsv(csvText);
  const byGameId = new Map<string, OeRow[]>();
  for (const row of rows) {
    if (!CANONICAL_LEAGUES.has(row.league)) continue;
    if (!byGameId.has(row.gameid)) byGameId.set(row.gameid, []);
    byGameId.get(row.gameid)!.push(row);
  }
  return processGameRows(pool, byGameId, aliases, { updateLeagueMembership: true, isInternational: false });
}

/**
 * International bridge-event games (MSI etc.). Must run AFTER
 * ingestOracleElixirCsv so each team's home-league membership already
 * exists -- this pass deliberately never writes team_league_memberships,
 * relying entirely on the regional pass having already established it.
 * A team with no existing membership (e.g. a wildcard-region team outside
 * our 6-league scope) simply won't join in computeRatings.ts's query, so
 * its games are silently excluded rather than mis-attributed.
 */
export async function ingestInternationalOeCsv(pool: Pool, csvText: string, aliases: LeagueAlias[]): Promise<IngestOeCsvResult> {
  const rows = parseCsv(csvText);
  const byGameId = new Map<string, OeRow[]>();
  for (const row of rows) {
    if (!INTERNATIONAL_EVENTS.has(row.league)) continue;
    if (!byGameId.has(row.gameid)) byGameId.set(row.gameid, []);
    byGameId.get(row.gameid)!.push(row);
  }
  return processGameRows(pool, byGameId, aliases, {
    updateLeagueMembership: false,
    isInternational: true,
    tournamentTypeOverride: 'international',
  });
}
