import type { Pool } from 'pg';
import {
  detectRosterChanges,
  computeRosterImpliedMu,
  confidenceFromGamesPlayed,
  type ReplayGame,
  type DecayEvent,
  type IncomingPlayerSignal,
} from '@power-ranking/rating-engine';
import { buildTeamLineupGames } from './teamLineups.js';

// Originally 2 -- confirmed via backtest this was too trigger-happy: 463
// roster-decay events fired across the dataset (some teams 16-24 times over
// 2.5 years, far more than real personnel turnover), each spiking RD hard.
// Raising to 5 (matching ROSTER_DISPLAY_PERSISTENCE_GAMES in
// computePlayerRatings.ts) cut that to 317 events AND improved predictive
// accuracy (63.02% -> 63.18%) -- ordinary bench rotation was being counted
// as full roster turnover, not just a display-layer problem.
const DEFAULT_ROSTER_CHANGE_PERSISTENCE_GAMES = 5;
const ROSTER_CHANGE_MIN_GAMES = 10; // matches rating_config schema default
const OFFSET_SCALE = 150; // matches rating_config schema default
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

export interface ReplayData {
  teamIds: string[];
  leagueIds: string[];
  games: ReplayGame[];
  decayEvents: DecayEvent[];
}

/**
 * Loads everything a replay needs from Postgres -- games, roster-change decay
 * events (with real player-implied priors), and seasonal split-boundary decay
 * events. Shared by computeRatings.ts (persists the result) and
 * manualBacktest.ts (evaluates prediction accuracy in-memory only) so both
 * exercise the exact same real data, not a hand-simplified backtest scenario.
 *
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

  // Resolves each game's per-side league via team_league_memberships. Uses the
  // team's CURRENT membership (end_date IS NULL) rather than a strict date-range
  // match against the game's own date: we ingest bridge events from before a
  // team's earliest regional-season row in this dataset (e.g. Worlds 2025,
  // played months before our 2026 regional ingestion's start_date), and a
  // strict date-range join would silently drop those games. Trade-off: a team
  // that genuinely changed leagues across seasons would be mis-attributed for
  // its older games -- not a concern yet since this dataset only spans one
  // season per team, but worth revisiting once multi-season history exists.
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
  // Player ratings (0-100 percentile scale) come from player_ratings_history,
  // already computed by computePlayerRatings before this runs. A player with
  // no rating yet (e.g. true rookie) gets confidence 0, which
  // computeRosterImpliedMu collapses back to the flat league mean -- the
  // designed cold-start fallback, not a shortcut anymore.
  // scope='regional' is not optional: the table also holds international-only
  // ratings, which cover a different (much smaller, elite-only) population on
  // a differently-centred scale. Mixing the two would make DISTINCT ON pick
  // between two incomparable numbers arbitrarily.
  const playerRatingsResult = await pool.query<{ player_id: number; rating: string; games_played: number }>(`
    SELECT DISTINCT ON (player_id) player_id, rating, games_played
    FROM player_ratings_history
    WHERE scope = 'regional'
    ORDER BY player_id, as_of_date DESC
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
      // Don't count an internal role RESHUFFLE the same as real personnel
      // turnover. This guards against corrupted/mislabeled source rows, not
      // real in-game behavior -- confirmed against real data (Cloud9,
      // 2026-08-01) that the source CSV can have genuinely scrambled position
      // labels for a team's existing 5 players (nobody new, nobody left) while
      // the actual game had no such role swap at all. Detected naively,
      // scrambled labels read as "5 roles changed" = 100% turnover, which
      // would spike a team's RD to the maximum and torch their rating right
      // when they should be most confident, after a season of stable data. A
      // role-change only counts as real turnover if the incoming player
      // wasn't ALSO one of this same batch's outgoing players -- i.e. they're
      // genuinely new to the team, not just relabeled data for an existing
      // teammate.
      const outgoingPlayerIds = new Set(dateEvents.map((event) => event.previousPlayerId));
      const genuinelyNewEvents = dateEvents.filter((event) => !outgoingPlayerIds.has(event.newPlayerId));

      if (genuinelyNewEvents.length === 0) continue; // pure reshuffle -- not a real roster event at all

      const incomingPlayers: IncomingPlayerSignal[] = genuinelyNewEvents.map((event) => {
        const playerRating = playerRatingById.get(Number(event.newPlayerId));
        return {
          percentile: playerRating?.rating ?? 50,
          confidence: playerRating ? confidenceFromGamesPlayed(playerRating.gamesPlayed, ROSTER_CHANGE_MIN_GAMES) : 0,
        };
      });
      const rosterImpliedMu = computeRosterImpliedMu(0, incomingPlayers, OFFSET_SCALE);
      // The same confidence that shaped rosterImpliedMu also governs how much
      // uncertainty the change really creates -- see applyRosterChangeDecay.
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
  // Each distinct tournament date_start, per league, is a split boundary
  // (Lock-In -> Spring -> Summer, or a year rollover). The first boundary for
  // a league has no "before" to decay from, so it's skipped. leagueMeanMu is
  // simplified to neutral (0) rather than the league's true mean at that
  // point in time, which only the replay engine's mid-run state would know --
  // same simplification already used for the roster-decay cold-start
  // fallback. This addresses "recent results should count for more than a
  // team's result from a year ago": without this, nothing in the system ever
  // reduced the lingering influence of old results for a continuously-active
  // team (Glicko-2's own inactivity-driven RD growth only kicks in across a
  // real gap in games, which a busy team never has).
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

  return { teamIds, leagueIds, games, decayEvents };
}
