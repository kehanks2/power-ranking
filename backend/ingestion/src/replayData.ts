import type { Pool } from 'pg';
import {
  detectRosterChanges,
  computeRosterImpliedMu,
  confidenceFromGamesPlayed,
  ROSTER_CHANGE_MIN_GAMES,
  type ReplayGame,
  type DecayEvent,
  type IncomingPlayerSignal,
} from '@power-ranking/rating-engine';
import { buildTeamLineupGames } from './teamLineups.js';

// 5, not 2: at 2, ordinary bench rotation counted as full roster turnover and
// spiked RD. Matches ROSTER_DISPLAY_PERSISTENCE_GAMES in computePlayerRatings.ts.
const DEFAULT_ROSTER_CHANGE_PERSISTENCE_GAMES = 5;
const OFFSET_SCALE = 150; // rating points a maximally-rated incoming roster is worth vs the league mean
const K_SEASON = 0.25; // matches plan's design default

interface GameRow {
  series_id: number;
  team1_id: number;
  team2_id: number;
  winner_team_id: number;
  // node-pg auto-parses TIMESTAMPTZ columns into Date objects, not strings.
  datetime_utc: Date;
  team1_gold: number | null;
  team2_gold: number | null;
  gamelength_seconds: number | null;
  international_event: boolean;
  team1_league_id: number;
  team2_league_id: number;
}

// How many international events the International board looks back over. A
// multiple of three so each window holds equal counts of First Stand / MSI /
// Worlds (they differ in size, so an uneven mix would swing the evidence base
// through the year). Six spans two years; three drops any team that skipped a
// year, nine is a no-op today.
export const INTERNATIONAL_EVENT_WINDOW = 6;

export interface ReplayData {
  teamIds: string[];
  leagueIds: string[];
  games: ReplayGame[];
  decayEvents: DecayEvent[];
  /**
   * Start date of the oldest international event inside the window. Earlier
   * international games are excluded from the International board only.
   */
  internationalWindowStart: string | null;
}

/**
 * Loads everything a replay needs from Postgres -- games plus roster-change and
 * seasonal decay events. Shared by computeRatings.ts and manualBacktest.ts.
 * Must run AFTER computePlayerRatings (player_ratings_history feeds the
 * roster-decay prior below).
 */
export async function loadReplayData(
  pool: Pool,
  rosterChangePersistenceGames: number = DEFAULT_ROSTER_CHANGE_PERSISTENCE_GAMES,
): Promise<ReplayData> {
  const leaguesResult = await pool.query<{ id: number }>('SELECT id FROM leagues');
  const leagueIds = leaguesResult.rows.map((row) => String(row.id));

  const teamsResult = await pool.query<{ id: number }>('SELECT id FROM teams');
  const teamIds = teamsResult.rows.map((row) => String(row.id));

  // Per-side league via the team's CURRENT membership (end_date IS NULL), not a
  // date-range match: bridge events (e.g. Worlds 2025) predate a team's earliest
  // regional row, and a date-range join would drop them. Mis-attributes older
  // games if a team changes leagues across seasons -- fine while data spans one
  // season per team.
  const gamesResult = await pool.query<GameRow>(`
    SELECT g.series_id, g.team1_id, g.team2_id, g.winner_team_id, g.datetime_utc,
           g.team1_gold, g.team2_gold, g.gamelength_seconds,
           tlm1.league_id AS team1_league_id, tlm2.league_id AS team2_league_id,
           (tn.tournament_type = 'international') AS international_event
    FROM games g
    JOIN series s ON s.id = g.series_id
    JOIN tournaments tn ON tn.id = s.tournament_id
    JOIN team_league_memberships tlm1 ON tlm1.team_id = g.team1_id AND tlm1.end_date IS NULL
    JOIN team_league_memberships tlm2 ON tlm2.team_id = g.team2_id AND tlm2.end_date IS NULL
    ORDER BY g.datetime_utc, g.id
  `);

  const games: ReplayGame[] = gamesResult.rows.map((row, index) => ({
    gameId: String(index),
    seriesId: String(row.series_id),
    datetimeUtc: row.datetime_utc.toISOString(),
    team1Id: String(row.team1_id),
    team2Id: String(row.team2_id),
    winnerTeamId: String(row.winner_team_id),
    team1LeagueId: String(row.team1_league_id),
    team2LeagueId: String(row.team2_league_id),
    team1Gold: row.team1_gold,
    team2Gold: row.team2_gold,
    gamelengthSeconds: row.gamelength_seconds,
    internationalEvent: row.international_event,
  }));

  const decayEvents: DecayEvent[] = [];

  // --- Roster-change decay, using real player-implied priors where available ---
  // A player with no rating (rookie) gets confidence 0, which
  // computeRosterImpliedMu collapses to the flat league mean.
  // Every filter here is load-bearing, and DISTINCT ON picks arbitrarily among
  // whatever survives: international ratings sit on a differently-centred scale,
  // a player with games in two leagues has a row per league, and the three
  // windows are computed over different game counts. Ordering on computed_at
  // rather than as_of_date pins the newest generation -- rows from several runs
  // share a date, and mixing them made the roster prior shift on every recompute,
  // which moved the ratings of teams that had not played.
  const playerRatingsResult = await pool.query<{ player_id: number; rating: string; games_played: number }>(`
    SELECT DISTINCT ON (player_id) player_id, rating, games_played
    FROM player_ratings_history
    WHERE scope = 'regional' AND is_primary AND rating_window = 'all'
    ORDER BY player_id, computed_at DESC
  `);
  const playerRatingById = new Map<number, { rating: number; gamesPlayed: number }>();
  for (const row of playerRatingsResult.rows) {
    playerRatingById.set(row.player_id, { rating: Number(row.rating), gamesPlayed: row.games_played });
  }

  const lineupGamesByTeam = await buildTeamLineupGames(pool);
  for (const [teamId, lineupGames] of lineupGamesByTeam) {
    const events = detectRosterChanges(lineupGames, rosterChangePersistenceGames);
    const eventsByDate = new Map<string, typeof events>();
    for (const event of events) {
      const dateKey = String(event.effectiveAt).slice(0, 10);
      if (!eventsByDate.has(dateKey)) eventsByDate.set(dateKey, []);
      eventsByDate.get(dateKey)!.push(event);
    }
    for (const [effectiveDate, dateEvents] of eventsByDate) {
      // An internal role reshuffle among the existing 5 isn't turnover. Source
      // CSVs sometimes scramble position labels (Cloud9, 2026-08-01), which read
      // naively as 100% turnover and would torch a stable team's rating. Only
      // count an incoming player who wasn't also outgoing in this same batch.
      const outgoingPlayerIds = new Set(dateEvents.map((event) => event.previousPlayerId));
      const genuinelyNewEvents = dateEvents.filter((event) => !outgoingPlayerIds.has(event.newPlayerId));

      if (genuinelyNewEvents.length === 0) continue;

      const incomingPlayers: IncomingPlayerSignal[] = genuinelyNewEvents.map((event) => {
        const playerRating = playerRatingById.get(Number(event.newPlayerId));
        return {
          percentile: playerRating?.rating ?? 50,
          confidence: playerRating ? confidenceFromGamesPlayed(playerRating.gamesPlayed, ROSTER_CHANGE_MIN_GAMES) : 0,
        };
      });
      const rosterImpliedMu = computeRosterImpliedMu(0, incomingPlayers, OFFSET_SCALE);
      // Also governs how much uncertainty the change creates -- see applyRosterChangeDecay.
      const rosterImpliedConfidence =
        incomingPlayers.reduce((sum, player) => sum + player.confidence, 0) / incomingPlayers.length;

      decayEvents.push({
        kind: 'roster_change',
        teamId: String(teamId),
        effectiveDate,
        turnover: genuinelyNewEvents.length / 5,
        rosterImpliedMu,
        rosterImpliedConfidence,
      });
    }
  }

  // --- Seasonal soft-decay at split boundaries ---
  // Each distinct tournament date_start per league is a split boundary; the
  // first has no "before" to decay from, so it's skipped. Without this, a
  // continuously-active team never sheds old results -- Glicko-2's RD growth
  // only kicks in across a real gap in games. leagueMeanMu is neutral (0)
  // rather than the true mid-run mean, which only the replay engine would know.
  const boundariesResult = await pool.query<{ canonical_league_id: number; date_start: string }>(`
    SELECT DISTINCT canonical_league_id, date_start::text
    FROM tournaments
    WHERE canonical_league_id IS NOT NULL
    ORDER BY canonical_league_id, date_start
  `);
  const boundariesByLeague = new Map<number, string[]>();
  for (const row of boundariesResult.rows) {
    if (!boundariesByLeague.has(row.canonical_league_id)) boundariesByLeague.set(row.canonical_league_id, []);
    boundariesByLeague.get(row.canonical_league_id)!.push(row.date_start);
  }

  const teamsByLeagueResult = await pool.query<{ team_id: number; league_id: number }>(`
    SELECT team_id, league_id FROM team_league_memberships WHERE end_date IS NULL
  `);
  const teamsByLeague = new Map<number, number[]>();
  for (const row of teamsByLeagueResult.rows) {
    if (!teamsByLeague.has(row.league_id)) teamsByLeague.set(row.league_id, []);
    teamsByLeague.get(row.league_id)!.push(row.team_id);
  }

  for (const [leagueId, boundaries] of boundariesByLeague) {
    const teamsInLeague = teamsByLeague.get(leagueId) ?? [];
    for (const boundaryDate of boundaries.slice(1)) {
      for (const teamId of teamsInLeague) {
        decayEvents.push({
          kind: 'seasonal',
          teamId: String(teamId),
          effectiveDate: boundaryDate,
          leagueMeanMu: 0,
          kSeason: K_SEASON,
        });
      }
    }
  }

  // Oldest event still inside the window; null when fewer events exist than
  // the window holds (nothing excluded yet).
  const windowResult = await pool.query<{ date_start: string }>(
    `SELECT date_start::text FROM tournaments
     WHERE tournament_type = 'international'
     ORDER BY date_start DESC OFFSET $1 - 1 LIMIT 1`,
    [INTERNATIONAL_EVENT_WINDOW],
  );
  const internationalWindowStart = windowResult.rows[0]?.date_start ?? null;

  return { teamIds, leagueIds, games, decayEvents, internationalWindowStart };
}
