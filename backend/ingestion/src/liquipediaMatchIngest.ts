import type { Pool } from 'pg';
import type { LiquipediaGamePlayer } from './liquipediaApi.js';
import { fetchMatches } from './liquipediaApi.js';
import { resolvePosition, ourNameToLiquipediaName, HISTORICAL_LIQUIPEDIA_NAME_ALIASES } from './liquipediaMappings.js';
import { upsertPlayer, upsertTournament, upsertSeries, upsertGame, upsertGameLineup, ensureTeamLeagueMembership } from './upsert.js';
import { upsertPlayerGamePerformance } from './computePlayerRatings.js';

// Liquipedia's `series` field identifies each Riot-official regional league.
// Non-official events (EWC, KeSPA Cup) are excluded just by not appearing here
// or in INTERNATIONAL_SERIES.
export const REGIONAL_SERIES_TO_LEAGUE_SLUG: Record<string, string> = {
  'LoL Champions Korea': 'LCK',
  'LoL Pro League': 'LPL',
  LEC: 'LEC',
  LCS: 'LCS',
  CBLOL: 'CBLOL',
  'LoL Championship Pacific': 'LCP',
};

// Each confirmed against the API via a real match from that event.
export const INTERNATIONAL_SERIES = new Set(['Mid-Season Invitational', 'World Championships', 'First Stand Tournament']);

// Through 2025 the Americas ran as one series split into North (LCS) and South
// (CBLOL) conferences. Series alone can't tell them apart, so the conference is
// read off `parent` ("LTA/2025/Split_2/North").
export const AMERICAS_SERIES = 'LoL Championship of The Americas';
const AMERICAS_CONFERENCE_TO_LEAGUE_SLUG: Record<string, string> = { North: 'LCS', South: 'CBLOL' };

export interface MatchClassification {
  tournamentType: 'regional_split' | 'international';
  canonicalLeagueId: number | null; // set only for regional -- international tournaments aren't tied to one league
  isInternational: boolean;
}

/**
 * Classifies a match's series+parent for ingestion, or null to exclude.
 * Exclusion is the default, so an unrecognized series never sneaks in. Regional
 * MSI-qualifier brackets share the "Mid-Season Invitational" series with the
 * real MSI, so `parent` is checked too (see the Road_to_ guard below).
 */
export function classifyMatch(series: string, parent: string, leagueIdBySlug: Map<string, number>): MatchClassification | null {
  const leagueSlug = REGIONAL_SERIES_TO_LEAGUE_SLUG[series];
  if (leagueSlug) {
    const canonicalLeagueId = leagueIdBySlug.get(leagueSlug);
    if (!canonicalLeagueId) return null;
    return { tournamentType: 'regional_split', canonicalLeagueId, isInternational: false };
  }
  if (series === AMERICAS_SERIES) {
    // Cross-Conference and Championship brackets (North vs South = LCS vs CBLOL)
    // belong to neither regional league, so they're excluded until they have a home.
    const conference = /\/(North|South)$/.exec(parent)?.[1];
    if (!conference) return null;
    const canonicalLeagueId = leagueIdBySlug.get(AMERICAS_CONFERENCE_TO_LEAGUE_SLUG[conference]);
    if (!canonicalLeagueId) return null;
    return { tournamentType: 'regional_split', canonicalLeagueId, isInternational: false };
  }
  if (INTERNATIONAL_SERIES.has(series)) {
    if (parent.includes('Road_to_')) return null; // regional qualifier bracket, not the international event
    return { tournamentType: 'international', canonicalLeagueId: null, isInternational: true };
  }
  return null;
}

function parseLengthToSeconds(length: string): number | null {
  const match = /^(\d+):(\d{2})$/.exec((length ?? '').trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * A Bo3/Bo5 that ends early still returns a full-length match2games array;
 * unplayed slots come back `scores: [0,0]`, `winner: ""`, `length: ""`. Those
 * placeholders still carry a `players` list, so only a decisive score marks a
 * game played. Load-bearing: without it every unplayed slot is credited to
 * team2, which was ~31% of the dataset as phantom games.
 */
export function isPlayedGame(game: { winner?: string; opponents: { score: number }[] }): boolean {
  if (game.opponents.length !== 2) return false;
  const [a, b] = game.opponents;
  const decisiveByScore = (a.score === 1) !== (b.score === 1);
  if (!decisiveByScore) return false;
  // `winner` is the explicit signal when present; treat "" as unplayed.
  if (game.winner !== undefined && game.winner !== '1' && game.winner !== '2') return false;
  return true;
}

/**
 * Gold by role for one side, for the lane differential. A role is omitted when
 * it doesn't resolve to exactly one player -- missing or ambiguous both yield a
 * null differential rather than a guess.
 */
export function goldByRole(players: LiquipediaGamePlayer[]): Map<string, number> {
  const gold = new Map<string, number>();
  const ambiguous = new Set<string>();

  for (const player of players) {
    const role = resolvePosition(player.role);
    if (!role) continue;
    if (gold.has(role)) {
      ambiguous.add(role);
      continue;
    }
    gold.set(role, player.gold ?? 0);
  }

  for (const role of ambiguous) gold.delete(role);
  return gold;
}

export interface MatchIngestResult {
  seriesProcessed: number;
  seriesSkipped: number;
  gamesProcessed: number;
  /** Unplayed placeholder slots in early-ending series -- see isPlayedGame. */
  gamesSkippedUnplayed: number;
  /** Games where two players on one side resolved to the same id, so one stat line overwrote another. */
  gamesWithCollidedPlayers: number;
  teamsUnresolved: string[];
}

/**
 * Ingests Liquipedia match/series data into the
 * games/series/tournaments/game_lineups/player_game_performance schema.
 * Idempotent on the unique keys, so re-running is safe. `conditions` is the
 * caller's full Liquipedia filter (date range + `[[series::X]]`).
 */
export async function ingestLiquipediaMatches(pool: Pool, conditions: string): Promise<MatchIngestResult> {
  const matches = await fetchMatches(conditions);

  const ourTeams = await pool.query<{ id: number; name: string }>('SELECT id, name FROM teams');
  // Case-insensitive: Liquipedia's casing differs from ours ("PaiN" vs "paiN").
  const teamIdByLiquipediaName = new Map<string, number>();
  const teamIdByOurName = new Map(ourTeams.rows.map((t) => [t.name, t.id]));
  for (const team of ourTeams.rows) teamIdByLiquipediaName.set(ourNameToLiquipediaName(team.name).toLowerCase(), team.id);
  // Also register historical/pre-sponsor names -- see HISTORICAL_LIQUIPEDIA_NAME_ALIASES.
  for (const [historicalName, ourName] of Object.entries(HISTORICAL_LIQUIPEDIA_NAME_ALIASES)) {
    const teamId = teamIdByOurName.get(ourName);
    if (teamId) teamIdByLiquipediaName.set(historicalName.toLowerCase(), teamId);
  }

  const leaguesResult = await pool.query<{ id: number; slug: string }>('SELECT id, slug FROM leagues');
  const leagueIdBySlug = new Map(leaguesResult.rows.map((l) => [l.slug, l.id]));

  const result: MatchIngestResult = {
    seriesProcessed: 0,
    seriesSkipped: 0,
    gamesProcessed: 0,
    gamesSkippedUnplayed: 0,
    gamesWithCollidedPlayers: 0,
    teamsUnresolved: [],
  };
  const teamsUnresolvedSet = new Set<string>();
  const playerIdCache = new Map<string, number>(); // Liquipedia's disambiguated player key -> our player_id
  const tournamentIdByParent = new Map<string, number>();

  for (const match of matches) {
    const classification = classifyMatch(match.series, match.parent, leagueIdBySlug);
    if (!classification || match.match2opponents.length !== 2 || match.match2games.length === 0) {
      result.seriesSkipped += 1;
      continue; // not Riot-official, a regional MSI-qualifier bracket, or malformed
    }

    const [opp1, opp2] = match.match2opponents;
    const team1Id = teamIdByLiquipediaName.get(opp1.name.toLowerCase());
    const team2Id = teamIdByLiquipediaName.get(opp2.name.toLowerCase());
    if (!team1Id || !team2Id) {
      // A team outside our 6-league scope doesn't resolve, so its games are
      // excluded rather than mis-attributed.
      if (!team1Id) teamsUnresolvedSet.add(opp1.name);
      if (!team2Id) teamsUnresolvedSet.add(opp2.name);
      result.seriesSkipped += 1;
      continue;
    }

    const dateOnly = match.date.slice(0, 10);
    // International passes must NOT touch team_league_memberships -- a
    // team's home region comes exclusively from its regional-split games.
    if (classification.tournamentType === 'regional_split' && classification.canonicalLeagueId) {
      await ensureTeamLeagueMembership(pool, { teamId: team1Id, leagueId: classification.canonicalLeagueId, asOfDate: dateOnly });
      await ensureTeamLeagueMembership(pool, { teamId: team2Id, leagueId: classification.canonicalLeagueId, asOfDate: dateOnly });
    }

    let tournamentId = tournamentIdByParent.get(match.parent);
    if (!tournamentId) {
      tournamentId = await upsertTournament(pool, {
        overviewPage: `liquipedia:${match.parent}`,
        name: match.tournament,
        rawLeagueName: match.series,
        canonicalLeagueId: classification.canonicalLeagueId,
        tournamentType: classification.tournamentType,
        dateStart: dateOnly,
        dateEnd: null,
      });
      tournamentIdByParent.set(match.parent, tournamentId);
    }

    const team1Score = opp1.score ?? 0;
    const team2Score = opp2.score ?? 0;
    // Null unless played and decided. Liquipedia reports a scheduled match as
    // -1 to -1; the old `>=` gave every one of those (and every drawn Bo2) to
    // team1. See db/migrations/0010.
    const seriesDecided = team1Score >= 0 && team2Score >= 0 && team1Score !== team2Score;
    let winnerTeamId: number | null = null;
    if (seriesDecided) winnerTeamId = team1Score > team2Score ? team1Id : team2Id;
    const seriesId = await upsertSeries(pool, {
      tournamentId,
      leaguepediaMatchId: `liquipedia:${match.match2id}`,
      team1Id,
      team2Id,
      bestOf: match.bestof ?? null,
      team1Score,
      team2Score,
      winnerTeamId,
      isInternational: classification.isInternational,
    });
    result.seriesProcessed += 1;

    for (const [gameIndex, game] of match.match2games.entries()) {
      if (!isPlayedGame(game)) {
        result.gamesSkippedUnplayed += 1;
        continue;
      }
      const [gameOpp1, gameOpp2] = game.opponents;
      const gameWinnerTeamId = gameOpp1.score === 1 ? team1Id : team2Id;
      const gamelengthSeconds = parseLengthToSeconds(game.length);

      // Neutral epics only (dragons/barons/heralds/grubs/atakhans); null when the
      // side carries no stats. The jungle objective-control share is derived from these.
      const neutralObjectives = (o: typeof gameOpp1): number | null =>
        o.stats
          ? (o.stats.dragons ?? 0) + (o.stats.barons ?? 0) + (o.stats.heralds ?? 0) + (o.stats.grubs ?? 0) + (o.stats.atakhans ?? 0)
          : null;

      const gameId = await upsertGame(pool, {
        seriesId,
        leaguepediaUniqueLine: `liquipedia:${match.match2id}_${game.match2gameid}`,
        gameNumber: gameIndex + 1,
        team1Id,
        team2Id,
        winnerTeamId: gameWinnerTeamId,
        datetimeUtc: match.date.replace(' ', 'T') + 'Z', // no per-game timestamps; series date shared across games
        patch: null,
        team1Gold: gameOpp1.stats?.gold ?? null,
        team2Gold: gameOpp2.stats?.gold ?? null,
        gamelengthSeconds,
        team1NeutralObjectives: neutralObjectives(gameOpp1),
        team2NeutralObjectives: neutralObjectives(gameOpp2),
      });
      result.gamesProcessed += 1;

      // Everyone written this run; rows for anyone no longer listed are cleared
      // afterwards -- see pruneStalePerformance.
      const playersInGame = new Set<number>();

      for (const [opponentIndex, gameOpponent] of [gameOpp1, gameOpp2].entries()) {
        const teamId = opponentIndex === 0 ? team1Id : team2Id;
        const teamDamageTotal = gameOpponent.players.reduce((sum, p) => sum + (p.damagedone ?? 0), 0);
        const opponentGold = goldByRole((opponentIndex === 0 ? gameOpp2 : gameOpp1).players);
        let rolesWritten = 0;
        const idsThisSide = new Set<number>();

        for (const player of gameOpponent.players) {
          const role = resolvePosition(player.role);
          if (!role) continue;
          const facingGold = opponentGold.get(role);

          const playerId = await resolvePlayerId(pool, player, playerIdCache);
          playersInGame.add(playerId);
          idsThisSide.add(playerId);
          rolesWritten += 1;
          await upsertGameLineup(pool, { gameId, teamId, playerId, role });
          await upsertPlayerGamePerformance(pool, {
            gameId,
            playerId,
            teamId,
            role,
            kills: player.kills ?? 0,
            deaths: player.deaths ?? 0,
            assists: player.assists ?? 0,
            gold: player.gold ?? 0,
            damageToChampions: player.damagedone ?? 0,
            goldShare: gameOpponent.stats?.gold ? (player.gold ?? 0) / gameOpponent.stats.gold : null,
            damageShare: teamDamageTotal > 0 ? (player.damagedone ?? 0) / teamDamageTotal : null,
            killParticipation: player.killparticipation ?? null,
            creepScore: player.creepscore ?? null,
            goldDiff: facingGold === undefined ? null : (player.gold ?? 0) - facingGold,
          });
        }

        // Two players on one side collapsing to one id is a handle collision
        // past resolvePlayerId -- one stat line overwrote another. Rare, but
        // reported rather than swallowed.
        if (idsThisSide.size < rolesWritten) result.gamesWithCollidedPlayers += 1;
      }

      await pruneStalePerformance(pool, gameId, playersInGame);
    }
  }

  result.teamsUnresolved = [...teamsUnresolvedSet];
  return result;
}

/**
 * Drops performance rows for players the current response no longer lists.
 * game_lineups is keyed on a slot (game, team, role), so a corrected lineup
 * replaces the occupant; player_game_performance is keyed on the person (game,
 * player), so a replaced player's row otherwise survives -- 180 phantom stat
 * lines fed ratings as real games before this.
 */
async function pruneStalePerformance(pool: Pool, gameId: number, playerIds: Set<number>): Promise<void> {
  if (playerIds.size === 0) return;
  await pool.query(`DELETE FROM player_game_performance WHERE game_id = $1 AND player_id <> ALL($2::int[])`, [gameId, [...playerIds]]);
}

// Matches existing players by handle; creates new ones keyed by Liquipedia's
// disambiguated identity, not the handle, so two different people sharing a
// handle (real data's "Saber") aren't merged.
async function resolvePlayerId(pool: Pool, player: LiquipediaGamePlayer, cache: Map<string, number>): Promise<number> {
  const cached = cache.get(player.player);
  if (cached) return cached;

  const lookup = await pool.query<{ id: number }>(`SELECT id FROM players WHERE lower(handle) = lower($1) LIMIT 1`, [player.displayName]);
  let playerId: number;
  if (lookup.rows.length > 0) {
    playerId = lookup.rows[0].id;
  } else {
    playerId = await upsertPlayer(pool, { leaguepediaPage: `liquipedia:player:${player.player}`, handle: player.displayName });
  }
  cache.set(player.player, playerId);
  return playerId;
}
