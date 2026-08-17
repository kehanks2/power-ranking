import type { Pool } from 'pg';

/** Gets or creates a team row keyed on its stable Leaguepedia OverviewPage. Rebrands just update `name`. */
export async function upsertTeam(
  pool: Pool,
  params: { leaguepediaPage: string; slug: string; name: string },
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO teams (leaguepedia_page, slug, name)
     VALUES ($1, $2, $3)
     ON CONFLICT (leaguepedia_page) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [params.leaguepediaPage, params.slug, params.name],
  );
  return result.rows[0].id;
}

export async function upsertPlayer(
  pool: Pool,
  params: { leaguepediaPage: string; handle: string },
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO players (leaguepedia_page, handle)
     VALUES ($1, $2)
     ON CONFLICT (leaguepedia_page) DO UPDATE SET handle = EXCLUDED.handle
     RETURNING id`,
    [params.leaguepediaPage, params.handle],
  );
  return result.rows[0].id;
}

/**
 * Upserts a tournament, resolving its canonical league via league_aliases.
 * canonicalLeagueId may be null if unresolved -- stored as NULL, never guessed
 * (see plan: "never silently guessed into the 6-league scope").
 */
export async function upsertTournament(
  pool: Pool,
  params: {
    overviewPage: string;
    name: string;
    rawLeagueName: string;
    canonicalLeagueId: number | null;
    tournamentType: 'regional_split' | 'international' | 'playoffs';
    dateStart: string;
    dateEnd: string | null;
  },
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO tournaments (overview_page, name, raw_league_name, canonical_league_id, tournament_type, date_start, date_end)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (overview_page) DO UPDATE SET
       canonical_league_id = EXCLUDED.canonical_league_id,
       date_end = EXCLUDED.date_end
     RETURNING id`,
    [
      params.overviewPage,
      params.name,
      params.rawLeagueName,
      params.canonicalLeagueId,
      params.tournamentType,
      params.dateStart,
      params.dateEnd,
    ],
  );
  return result.rows[0].id;
}

/** Idempotency key: leaguepedia_match_id. Safe to call repeatedly for the same series. */
export async function upsertSeries(
  pool: Pool,
  params: {
    tournamentId: number;
    leaguepediaMatchId: string;
    team1Id: number;
    team2Id: number;
    bestOf: number | null;
    team1Score: number | null;
    team2Score: number | null;
    winnerTeamId: number | null;
    isInternational: boolean;
    /** Liquipedia's match2bracketid -- the stage a board advances on. */
    bracketId: string | null;
    /**
     * ISO instant. Stored rather than derived from the games, because a series
     * whose games are held back for missing stat lines has none to derive from
     * and rendered with a blank date.
     */
    dateUtc: string | null;
  },
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO series (tournament_id, leaguepedia_match_id, team1_id, team2_id, best_of, team1_score, team2_score, winner_team_id, is_international, bracket_id, date_utc)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (leaguepedia_match_id) DO UPDATE SET
       tournament_id = EXCLUDED.tournament_id,
       team1_score = EXCLUDED.team1_score,
       team2_score = EXCLUDED.team2_score,
       winner_team_id = EXCLUDED.winner_team_id,
       -- Never overwrite a known stage or date with a null: a re-ingest that
       -- lost either would silently strip it from an already-complete series.
       bracket_id = COALESCE(EXCLUDED.bracket_id, series.bracket_id),
       date_utc = COALESCE(EXCLUDED.date_utc, series.date_utc)
     RETURNING id`,
    [
      params.tournamentId,
      params.leaguepediaMatchId,
      params.team1Id,
      params.team2Id,
      params.bestOf,
      params.team1Score,
      params.team2Score,
      params.winnerTeamId,
      params.isInternational,
      params.bracketId,
      params.dateUtc,
    ],
  );
  return result.rows[0].id;
}

/**
 * Idempotency key: leaguepedia_unique_line. A full from-scratch ingestion
 * replay is always safe -- re-running never double-counts a game.
 */
export async function upsertGame(
  pool: Pool,
  params: {
    seriesId: number;
    leaguepediaUniqueLine: string;
    gameNumber: number;
    team1Id: number;
    team2Id: number;
    winnerTeamId: number;
    datetimeUtc: string;
    patch: string | null;
    team1Gold: number | null;
    team2Gold: number | null;
    gamelengthSeconds: number | null;
    team1NeutralObjectives: number | null;
    team2NeutralObjectives: number | null;
  },
): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO games (series_id, leaguepedia_unique_line, game_number, team1_id, team2_id, winner_team_id, datetime_utc, patch, team1_gold, team2_gold, gamelength_seconds, team1_neutral_objectives, team2_neutral_objectives)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     ON CONFLICT (leaguepedia_unique_line) DO UPDATE SET
       winner_team_id = EXCLUDED.winner_team_id,
       team1_gold = EXCLUDED.team1_gold,
       team2_gold = EXCLUDED.team2_gold,
       gamelength_seconds = EXCLUDED.gamelength_seconds,
       team1_neutral_objectives = EXCLUDED.team1_neutral_objectives,
       team2_neutral_objectives = EXCLUDED.team2_neutral_objectives
     RETURNING id`,
    [
      params.seriesId,
      params.leaguepediaUniqueLine,
      params.gameNumber,
      params.team1Id,
      params.team2Id,
      params.winnerTeamId,
      params.datetimeUtc,
      params.patch,
      params.team1Gold,
      params.team2Gold,
      params.gamelengthSeconds,
      params.team1NeutralObjectives,
      params.team2NeutralObjectives,
    ],
  );
  return result.rows[0].id;
}

/**
 * Ensures a team's team_league_memberships row reflects `leagueId` as of `asOfDate`:
 * closes any open membership in a *different* league, and opens one for this
 * league if none is already open. Idempotent -- safe to call on every ingested
 * tournament a team appears in.
 */
export async function ensureTeamLeagueMembership(
  pool: Pool,
  params: { teamId: number; leagueId: number; asOfDate: string },
): Promise<void> {
  await pool.query(
    `UPDATE team_league_memberships
     SET end_date = $3
     WHERE team_id = $1 AND league_id <> $2 AND end_date IS NULL`,
    [params.teamId, params.leagueId, params.asOfDate],
  );
  await pool.query(
    `INSERT INTO team_league_memberships (team_id, league_id, start_date)
     SELECT $1, $2, $3
     WHERE NOT EXISTS (
       SELECT 1 FROM team_league_memberships WHERE team_id = $1 AND league_id = $2 AND end_date IS NULL
     )`,
    [params.teamId, params.leagueId, params.asOfDate],
  );
}

/** Idempotency key: (game_id, team_id, role). Records the actual lineup for roster-change detection. */
export async function upsertGameLineup(
  pool: Pool,
  params: { gameId: number; teamId: number; playerId: number; role: 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP' },
): Promise<void> {
  await pool.query(
    `INSERT INTO game_lineups (game_id, team_id, player_id, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (game_id, team_id, role) DO UPDATE SET player_id = EXCLUDED.player_id`,
    [params.gameId, params.teamId, params.playerId, params.role],
  );
}
