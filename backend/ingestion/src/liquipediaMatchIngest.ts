import type { Pool } from 'pg';
import type { LiquipediaGamePlayer } from './liquipediaApi.js';
import { fetchMatches } from './liquipediaApi.js';
import { resolvePosition, ourNameToLiquipediaName, HISTORICAL_LIQUIPEDIA_NAME_ALIASES } from './liquipediaMappings.js';
import { upsertPlayer, upsertTournament, upsertSeries, upsertGame, upsertGameLineup, ensureTeamLeagueMembership } from './upsert.js';
import { upsertPlayerGamePerformance } from './computePlayerRatings.js';

/**
 * Liquipedia's `series` field cleanly identifies each Riot-official regional
 * league (confirmed directly against the API, not guessed -- see the tier-1
 * match sample pulled 2026-08-04). "Esports World Cup" and "KeSPA Cup" are
 * real tournaments but explicitly NOT Riot-official, and are excluded simply
 * by not appearing in this map or INTERNATIONAL_SERIES below -- nothing else
 * needed to keep them out.
 */
export const REGIONAL_SERIES_TO_LEAGUE_SLUG: Record<string, string> = {
  'LoL Champions Korea': 'LCK',
  'LoL Pro League': 'LPL',
  LEC: 'LEC',
  LCS: 'LCS',
  CBLOL: 'CBLOL',
  'LoL Championship Pacific': 'LCP',
};

/**
 * Confirmed individually against the API (not guessed), each via a real
 * match from that event: MSI (parent Mid-Season_Invitational/2026), Worlds
 * (parent World_Championship/2025), First Stand (parent
 * First_Stand_Tournament/2026).
 */
export const INTERNATIONAL_SERIES = new Set(['Mid-Season Invitational', 'World Championships', 'First Stand Tournament']);

export interface MatchClassification {
  tournamentType: 'regional_split' | 'international';
  canonicalLeagueId: number | null; // set only for regional -- international tournaments aren't tied to one league (same convention OE ingestion uses)
  isInternational: boolean;
}

/**
 * Classifies a match's series+parent into how (or whether) it should be
 * ingested. Returns null for anything not Riot-official (EWC, KeSPA Cup,
 * academy leagues, etc.) -- exclusion is the DEFAULT, not an explicit
 * denylist, so a new/unrecognized series never sneaks in silently.
 *
 * The one real wrinkle: regional MSI-qualifier brackets (e.g. parent
 * "LCK/2026/Road_to_MSI") share the exact same `series` value
 * ("Mid-Season Invitational") as the real international MSI bracket itself
 * (parent "Mid-Season_Invitational/2026") -- confirmed against the API this
 * is genuinely ambiguous by series alone, so parent is checked too.
 */
export function classifyMatch(series: string, parent: string, leagueIdBySlug: Map<string, number>): MatchClassification | null {
  const leagueSlug = REGIONAL_SERIES_TO_LEAGUE_SLUG[series];
  if (leagueSlug) {
    const canonicalLeagueId = leagueIdBySlug.get(leagueSlug);
    if (!canonicalLeagueId) return null;
    return { tournamentType: 'regional_split', canonicalLeagueId, isInternational: false };
  }
  if (INTERNATIONAL_SERIES.has(series)) {
    if (parent.includes('Road_to_')) return null; // a regional qualifier bracket, not the real international event
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
 * A Bo3/Bo5 that ends early still returns a FULL-LENGTH match2games array --
 * the unplayed slots come back as `scores: [0,0]`, `winner: ""`, `length: ""`.
 * Confirmed directly against the API (e.g. a 2-0 LCK sweep still ships a
 * third game entry). Critically, those placeholders DO carry a `players`
 * list (the roster, sometimes 6-7 deep), so "has players" is NOT a usable
 * played/unplayed test -- only a decisive score is.
 *
 * This guard is load-bearing: without it, `score === 1 ? team1 : team2`
 * silently credits every unplayed slot to team2. That produced ~2,287
 * phantom games (~31% of the dataset), all won by team2, which dragged
 * game-3 team1 winrate to 29% and game-5 to 19% (real games sit at ~52% at
 * every game number) and badly corrupted both ratings and calibration.
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

export interface MatchIngestResult {
  seriesProcessed: number;
  seriesSkipped: number;
  gamesProcessed: number;
  /** Unplayed placeholder slots in early-ending series -- see isPlayedGame. */
  gamesSkippedUnplayed: number;
  teamsUnresolved: string[];
}

/**
 * Ingests Liquipedia match/series data for the regional leagues into the
 * same games/series/tournaments/game_lineups/player_game_performance schema
 * OE ingestion writes -- idempotent on the same keys (leaguepedia_unique_line
 * for games, leaguepedia_match_id for series, overview_page for tournaments),
 * so re-running is always safe. `conditions` is the caller's full Liquipedia
 * filter (date range + `[[series::X]]`) -- see manualLiquipediaMatchBackfill.ts
 * for how the LPL Split 3 gap specifically is filled with this.
 */
export async function ingestLiquipediaMatches(pool: Pool, conditions: string): Promise<MatchIngestResult> {
  const matches = await fetchMatches(conditions);

  const ourTeams = await pool.query<{ id: number; name: string }>('SELECT id, name FROM teams');
  // Case-insensitive: confirmed against real data Liquipedia's match records
  // don't always match our stored casing exactly (e.g. "PaiN Gaming" vs our
  // "paiN Gaming").
  const teamIdByLiquipediaName = new Map<string, number>();
  const teamIdByOurName = new Map(ourTeams.rows.map((t) => [t.name, t.id]));
  for (const team of ourTeams.rows) teamIdByLiquipediaName.set(ourNameToLiquipediaName(team.name).toLowerCase(), team.id);
  // Also register historical/pre-sponsor names -- see liquipediaMappings.ts's
  // doc comment on HISTORICAL_LIQUIPEDIA_NAME_ALIASES for why this is needed
  // on top of the primary (current-name) alias above.
  for (const [historicalName, ourName] of Object.entries(HISTORICAL_LIQUIPEDIA_NAME_ALIASES)) {
    const teamId = teamIdByOurName.get(ourName);
    if (teamId) teamIdByLiquipediaName.set(historicalName.toLowerCase(), teamId);
  }

  const leaguesResult = await pool.query<{ id: number; slug: string }>('SELECT id, slug FROM leagues');
  const leagueIdBySlug = new Map(leaguesResult.rows.map((l) => [l.slug, l.id]));

  const result: MatchIngestResult = { seriesProcessed: 0, seriesSkipped: 0, gamesProcessed: 0, gamesSkippedUnplayed: 0, teamsUnresolved: [] };
  const teamsUnresolvedSet = new Set<string>();
  const playerIdCache = new Map<string, number>(); // Liquipedia's disambiguated player key -> our player_id
  const tournamentIdByParent = new Map<string, number>();

  for (const match of matches) {
    const classification = classifyMatch(match.series, match.parent, leagueIdBySlug);
    if (!classification || match.match2opponents.length !== 2 || match.match2games.length === 0) {
      result.seriesSkipped += 1;
      continue; // not Riot-official (EWC/KeSPA Cup/academy leagues/etc.), a regional MSI-qualifier bracket, or malformed
    }

    const [opp1, opp2] = match.match2opponents;
    const team1Id = teamIdByLiquipediaName.get(opp1.name.toLowerCase());
    const team2Id = teamIdByLiquipediaName.get(opp2.name.toLowerCase());
    if (!team1Id || !team2Id) {
      // Matches OE's international-pass behavior: a team outside our 6-league
      // scope (e.g. a wildcard region at an international) simply doesn't
      // resolve, so its games are silently excluded rather than mis-attributed.
      if (!team1Id) teamsUnresolvedSet.add(opp1.name);
      if (!team2Id) teamsUnresolvedSet.add(opp2.name);
      result.seriesSkipped += 1;
      continue;
    }

    const dateOnly = match.date.slice(0, 10);
    // International passes must NOT touch team_league_memberships -- a
    // team's home region comes exclusively from its regional-split games
    // (same rule OE ingestion follows).
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
    const winnerTeamId = team1Score >= team2Score ? team1Id : team2Id;
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

      const gameId = await upsertGame(pool, {
        seriesId,
        leaguepediaUniqueLine: `liquipedia:${match.match2id}_${game.match2gameid}`,
        gameNumber: gameIndex + 1,
        team1Id,
        team2Id,
        winnerTeamId: gameWinnerTeamId,
        datetimeUtc: match.date.replace(' ', 'T') + 'Z', // per-game timestamps aren't available -- series date shared across games
        patch: null,
        team1Gold: gameOpp1.stats?.gold ?? null,
        team2Gold: gameOpp2.stats?.gold ?? null,
        gamelengthSeconds,
      });
      result.gamesProcessed += 1;

      for (const [opponentIndex, gameOpponent] of [gameOpp1, gameOpp2].entries()) {
        const teamId = opponentIndex === 0 ? team1Id : team2Id;
        const teamDamageTotal = gameOpponent.players.reduce((sum, p) => sum + (p.damagedone ?? 0), 0);

        for (const player of gameOpponent.players) {
          const role = resolvePosition(player.role);
          if (!role) continue;

          const playerId = await resolvePlayerId(pool, player, playerIdCache);
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
          });
        }
      }
    }
  }

  result.teamsUnresolved = [...teamsUnresolvedSet];
  return result;
}

/** Matches by clean handle (displayName) against existing players; creates new ones keyed by Liquipedia's disambiguated identity, not the handle -- avoids merging two different real people who happen to share a common handle (confirmed this exact class of bug earlier this session with OE data's "Saber"). */
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
