import type { Pool } from 'pg';
import {
  fromGlicko2Scale,
  metaToDisplayOffset,
  initialLeagueMeta,
  conservativeRank,
  META_WEIGHT,
  DEFAULT_CONSERVATIVE_K,
  GLICKO2_SCALE,
  DEFAULT_VOLATILITY,
  type RatingState,
} from '@power-ranking/rating-engine';
import type {
  LeagueSummaryDto,
  TeamSummaryDto,
  TeamDetailDto,
  PlayerSummaryDto,
  PlayerDetailDto,
  PlayerRatingScope,
  RatingWindow,
  RosterEntryDto,
  TeamSeriesDto,
} from '@power-ranking/shared';
import { LEAGUE_SPLIT_START_CTE, playerWindowPredicate } from '@power-ranking/shared';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
// A team with no game in its league's latest split is no longer competing.
// team_league_memberships never closes a row, so without this a long-gone team
// stays "current" forever. Keyed per-league, since leagues run on different calendars.
const LEAGUE_LATEST_SPLIT_CTE = `
  league_latest_split AS (
    SELECT canonical_league_id, MAX(date_start) AS latest_split_start
    FROM tournaments
    WHERE canonical_league_id IS NOT NULL
    GROUP BY canonical_league_id
  ),
  team_last_game AS (
    SELECT team_id, MAX(datetime_utc) AS last_game_at FROM (
      SELECT team1_id AS team_id, datetime_utc FROM games
      UNION ALL
      SELECT team2_id AS team_id, datetime_utc FROM games
    ) all_games
    GROUP BY team_id
  ),
  team_last_intl_game AS (
    SELECT team_id, MAX(datetime_utc) AS last_intl_game_at FROM (
      SELECT g.team1_id AS team_id, g.datetime_utc
      FROM games g JOIN series s ON s.id = g.series_id JOIN tournaments tn ON tn.id = s.tournament_id
      WHERE tn.tournament_type = 'international'
      UNION ALL
      SELECT g.team2_id AS team_id, g.datetime_utc
      FROM games g JOIN series s ON s.id = g.series_id JOIN tournaments tn ON tn.id = s.tournament_id
      WHERE tn.tournament_type = 'international'
    ) intl_games
    GROUP BY team_id
  )
`;

/** Cold-start state for anything with no rating history yet -- see plan's "Cold start" rule. */
function coldStartState(): RatingState {
  return { mu: 0, phi: PHI_INIT_MAX, sigma: DEFAULT_VOLATILITY };
}

function toRatingState(muCol: unknown, phiCol: unknown): RatingState | null {
  if (muCol === null || muCol === undefined) return null;
  return { mu: Number(muCol), phi: Number(phiCol), sigma: DEFAULT_VOLATILITY };
}

export async function getLeagues(pool: Pool): Promise<LeagueSummaryDto[]> {
  const result = await pool.query<{
    slug: string;
    name: string;
    logo_url: string | null;
    mu_meta: string | null;
    phi_meta: string | null;
  }>(`
    SELECT l.slug, l.name, l.logo_url, lr.mu_meta, lr.phi_meta
    FROM leagues l
    LEFT JOIN LATERAL (
      SELECT mu_meta, phi_meta FROM league_ratings_history
      WHERE league_id = l.id ORDER BY as_of_date DESC LIMIT 1
    ) lr ON true
  `);

  const withRatings = result.rows.map((row) => {
    const meta = toRatingState(row.mu_meta, row.phi_meta) ?? initialLeagueMeta(PHI_INIT_MAX);
    // Weighted, so the board reports the credit teams actually carry.
    const display = metaToDisplayOffset(meta, META_WEIGHT, PHI_INIT_MAX);
    return { slug: row.slug, name: row.name, logoUrl: row.logo_url, rating: display.rating, rd: display.rd };
  });

  withRatings.sort((a, b) => conservativeRank(b, DEFAULT_CONSERVATIVE_K) - conservativeRank(a, DEFAULT_CONSERVATIVE_K));
  return withRatings.map((row, index) => ({ ...row, rank: index + 1 }));
}

// Shared CTEs for the team boards. Six events, matching INTERNATIONAL_EVENT_WINDOW.
const TEAM_CONTEXT_CTE = `
  recent_events AS (
    SELECT id, name, date_start,
           CASE WHEN name ILIKE '%First Stand%' THEN 'FS'
                WHEN name ILIKE '%Mid-Season%'  THEN 'MSI'
                ELSE 'W' END || substring(date_start::text, 3, 2) AS code
    FROM tournaments WHERE tournament_type = 'international'
    ORDER BY date_start DESC LIMIT 6
  ),
  -- One row per team per event played, with the finish, newest-first.
  attendance AS (
    SELECT team_id, json_agg(json_build_object('event', code, 'placement', placement)
                             ORDER BY date_start DESC) AS results
    FROM (
      SELECT DISTINCT t.id AS team_id, lf.code, lf.date_start, tp.placement
      FROM recent_events lf
      JOIN series s ON s.tournament_id = lf.id
      JOIN games g ON g.series_id = s.id
      JOIN teams t ON t.id IN (g.team1_id, g.team2_id)
      LEFT JOIN tournament_placements tp ON tp.tournament_id = lf.id AND tp.team_id = t.id
    ) x GROUP BY team_id
  ),
  last_intl AS (
    SELECT team_id, code FROM (
      SELECT t.id AS team_id, tn.date_start,
             CASE WHEN tn.name ILIKE '%First Stand%' THEN 'FS'
                  WHEN tn.name ILIKE '%Mid-Season%'  THEN 'MSI'
                  ELSE 'W' END || substring(tn.date_start::text, 3, 2) AS code,
             ROW_NUMBER() OVER (PARTITION BY t.id ORDER BY tn.date_start DESC) AS rn
      FROM tournaments tn
      JOIN series s ON s.tournament_id = tn.id
      JOIN games g ON g.series_id = s.id
      JOIN teams t ON t.id IN (g.team1_id, g.team2_id)
      WHERE tn.tournament_type = 'international'
    ) x WHERE rn = 1
  ),
  recent_churn AS (
    SELECT DISTINCT team_id FROM team_ratings_history
    WHERE reason = 'roster_decay' AND as_of_date > NOW() - INTERVAL '60 days'
  ),
  -- Games at international events (incl. intra-region matchups played there).
  intl_game_count AS (
    SELECT team_id, COUNT(*) AS games FROM (
      SELECT g.team1_id AS team_id FROM games g
        JOIN series s ON s.id = g.series_id JOIN tournaments tn ON tn.id = s.tournament_id
        WHERE tn.tournament_type = 'international'
      UNION ALL
      SELECT g.team2_id FROM games g
        JOIN series s ON s.id = g.series_id JOIN tournaments tn ON tn.id = s.tournament_id
        WHERE tn.tournament_type = 'international'
    ) y GROUP BY team_id
  )
`;

interface TeamRow {
  id: number;
  slug: string;
  name: string;
  logo_url: string | null;
  brand_color: string | null;
  league_slug: string;
  mu: string | null;
  phi: string | null;
  games: string | null;
  results: { event: string; placement: string | null }[] | null;
  last_code: string | null;
  churn: boolean;
}

function toTeamSummaries(rows: TeamRow[]): TeamSummaryDto[] {
  const withRatings = rows.map((row) => {
    const state = toRatingState(row.mu, row.phi) ?? coldStartState();
    const display = fromGlicko2Scale(state);
    const results = row.results ?? [];
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      logoUrl: row.logo_url,
      brandColor: row.brand_color,
      leagueSlug: row.league_slug,
      rating: display.rating,
      rd: display.rd,
      floor: display.rating - display.rd,
      games: Number(row.games ?? 0),
      recentRosterChange: row.churn,
      results,
      lastInternational: results.length === 0 ? row.last_code : null,
    };
  });

  // Ranked on the floor, not the rating, so a thinly-evidenced high number
  // doesn't top one we actually know. See conservativeRank.
  withRatings.sort((a, b) => b.floor - a.floor);
  return withRatings.map((row, index) => ({ ...row, rank: index + 1 }));
}

/**
 * A league slug ranks on contextual rating alone (the shared meta cancels) and
 * isn't comparable between regions. 'international' ranks on cross-region games
 * with the league prior off; teams under MIN_INTERNATIONAL_GAMES are absent.
 */
export async function getTeams(pool: Pool, scope: string): Promise<TeamSummaryDto[]> {
  const international = scope === 'international';
  const result = await pool.query<TeamRow>(
    `
    WITH ${LEAGUE_LATEST_SPLIT_CTE},
    ${TEAM_CONTEXT_CTE},
    -- The league's last six splits, coded like the international events (short
    -- name + 2-digit year: "Spr26", "S126"). Empty on the international board.
    regional_events AS (
      SELECT id, date_start,
        (CASE WHEN dpart ~* 'Split *[0-9]' THEN 'S' || regexp_replace(dpart, '[^0-9]', '', 'g')
              ELSE left(dpart, 3) END) || substring(date_start::text, 3, 2) AS code
      FROM (
        SELECT tn.id, tn.date_start,
               trim(regexp_replace(tn.name, l.slug || '|20[0-9][0-9]', '', 'g')) AS dpart
        FROM tournaments tn
        JOIN leagues l ON l.id = tn.canonical_league_id
        WHERE tn.tournament_type = 'regional_split' AND l.slug = $2
        ORDER BY tn.date_start DESC LIMIT 6
      ) e
    ),
    regional_attendance AS (
      SELECT team_id, json_agg(json_build_object('event', code, 'placement', placement) ORDER BY date_start DESC) AS results
      FROM (
        SELECT DISTINCT t.id AS team_id, re.code, re.date_start, tp.placement
        FROM regional_events re
        JOIN series s ON s.tournament_id = re.id
        JOIN games g ON g.series_id = s.id
        JOIN teams t ON t.id IN (g.team1_id, g.team2_id)
        LEFT JOIN tournament_placements tp ON tp.tournament_id = re.id AND tp.team_id = t.id
      ) x GROUP BY team_id
    ),
    -- Games in those same six splits, so the count matches the placement column.
    regional_game_count AS (
      SELECT team_id, COUNT(*) AS games FROM (
        SELECT g.team1_id AS team_id FROM regional_events re
          JOIN series s ON s.tournament_id = re.id JOIN games g ON g.series_id = s.id
        UNION ALL
        SELECT g.team2_id FROM regional_events re
          JOIN series s ON s.tournament_id = re.id JOIN games g ON g.series_id = s.id
      ) rg GROUP BY team_id
    )
    SELECT t.id, t.slug, t.name, t.logo_url, t.brand_color, l.slug AS league_slug,
           tr.mu_ctx AS mu, tr.phi_ctx AS phi,
           ${international ? 'igc.games' : 'rgc.games'} AS games,
           ${international ? 'att.results' : 'ratt.results'} AS results,
           ${international ? 'li.code' : 'NULL'} AS last_code,
           (rc.team_id IS NOT NULL) AS churn
    FROM teams t
    JOIN team_league_memberships tlm ON tlm.team_id = t.id AND tlm.end_date IS NULL
    JOIN leagues l ON l.id = tlm.league_id
    JOIN team_last_game tlg ON tlg.team_id = t.id
    JOIN league_latest_split lls ON lls.canonical_league_id = l.id
    LEFT JOIN attendance att ON att.team_id = t.id
    LEFT JOIN regional_attendance ratt ON ratt.team_id = t.id
    LEFT JOIN last_intl li ON li.team_id = t.id
    LEFT JOIN recent_churn rc ON rc.team_id = t.id
    LEFT JOIN intl_game_count igc ON igc.team_id = t.id
    LEFT JOIN regional_game_count rgc ON rgc.team_id = t.id
    JOIN LATERAL (
      SELECT mu_ctx, phi_ctx FROM team_ratings_history
      WHERE team_id = t.id AND scope = $1 ORDER BY as_of_date DESC LIMIT 1
    ) tr ON true
    WHERE tlg.last_game_at >= lls.latest_split_start
      AND ($2::text IS NULL OR l.slug = $2)
    `,
    [international ? 'international' : 'overall', international ? null : scope],
  );

  return toTeamSummaries(result.rows);
}

export async function getTeamById(pool: Pool, teamId: number): Promise<TeamDetailDto | null> {
  const leagueRow = await pool.query<{ slug: string }>(
    `SELECT l.slug FROM teams t
     JOIN team_league_memberships tlm ON tlm.team_id = t.id AND tlm.end_date IS NULL
     JOIN leagues l ON l.id = tlm.league_id WHERE t.id = $1`,
    [teamId],
  );
  if (leagueRow.rows.length === 0) return null;
  const teams = await getTeams(pool, leagueRow.rows[0].slug);
  const team = teams.find((t) => t.id === teamId);
  if (!team) return null;

  const rosterResult = await pool.query<{
    player_id: number;
    handle: string;
    role: RosterEntryDto['role'];
    is_starter: boolean;
  }>(
    `
    SELECT p.id AS player_id, p.handle, rm.role, rm.is_starter
    FROM roster_memberships rm
    JOIN players p ON p.id = rm.player_id
    WHERE rm.team_id = $1 AND rm.end_date IS NULL
    -- In-game order (TOP/JNG/MID/BOT/SUP), not alphabetical; starters lead within a role.
    ORDER BY array_position(ARRAY['TOP','JNG','MID','BOT','SUP']::text[], rm.role), rm.is_starter DESC, p.handle
    `,
    [teamId],
  );

  const roster: RosterEntryDto[] = rosterResult.rows.map((row) => ({
    playerId: row.player_id,
    handle: row.handle,
    role: row.role,
    isStarter: row.is_starter,
  }));

  // One row per tournament, games AND series, with formats (a 12-6 in Bo1s is a
  // different season from a 12-6 in Bo5s). Placements are internationals only.
  const recordResult = await pool.query<{
    event: string;
    start_date: string;
    tournament_type: string;
    wins: number;
    losses: number;
    series_wins: number;
    series_losses: number;
    formats: number[] | null;
    series: TeamSeriesDto[];
    placement: string | null;
  }>(
    `
    WITH team_series AS (
      SELECT s.id,
             s.tournament_id,
             s.winner_team_id,
             -- series carries no date of its own, so order by its first game.
             (SELECT MIN(g.datetime_utc) FROM games g WHERE g.series_id = s.id) AS started_at,
             -- Oriented to this team, so the expanded row reads "3-1" for a win.
             CASE WHEN s.team1_id = $1 THEN s.team1_score ELSE s.team2_score END AS own_score,
             CASE WHEN s.team1_id = $1 THEN s.team2_score ELSE s.team1_score END AS opponent_score,
             opp.name AS opponent,
             -- From the scoreline, not the unreliable series.best_of: a decided
             -- series ran to (2 * winner's score - 1); a draw is the even format.
             CASE
               WHEN s.team1_score IS NULL OR s.team2_score IS NULL THEN NULL
               WHEN GREATEST(s.team1_score, s.team2_score) <= 0 THEN NULL
               WHEN s.team1_score = s.team2_score THEN 2 * s.team1_score
               ELSE 2 * GREATEST(s.team1_score, s.team2_score) - 1
             END AS format
      FROM series s
      JOIN teams opp ON opp.id = CASE WHEN s.team1_id = $1 THEN s.team2_id ELSE s.team1_id END
      WHERE $1 IN (s.team1_id, s.team2_id)
    ),
    game_record AS (
      SELECT s.tournament_id,
             COUNT(*) FILTER (WHERE g.winner_team_id = $1)::int AS wins,
             COUNT(*) FILTER (WHERE g.winner_team_id <> $1)::int AS losses
      FROM games g
      JOIN series s ON s.id = g.series_id
      WHERE $1 IN (g.team1_id, g.team2_id)
      GROUP BY s.tournament_id
    ),
    series_record AS (
      -- Only decided series count; an unplayed fixture has a null winner (migration 0010).
      SELECT tournament_id,
             COUNT(*) FILTER (WHERE winner_team_id = $1)::int AS wins,
             COUNT(*) FILTER (WHERE winner_team_id IS NOT NULL AND winner_team_id <> $1)::int AS losses,
             ARRAY_AGG(DISTINCT format) FILTER (WHERE format IS NOT NULL) AS formats,
             -- The individual series, for the expanded row.
             COALESCE(
               JSONB_AGG(
                 JSONB_BUILD_OBJECT(
                   -- ::date, so this arrives as "2026-04-03", not a timestamp.
                   'date', started_at::date,
                   'opponent', opponent,
                   'ownScore', own_score,
                   'opponentScore', opponent_score,
                   'format', format,
                   'won', winner_team_id = $1
                 )
                 ORDER BY started_at DESC
               ) FILTER (WHERE winner_team_id IS NOT NULL),
               '[]'::jsonb
             ) AS series
      FROM team_series
      GROUP BY tournament_id
    )
    SELECT tn.name AS event,
           -- ::text, so node-pg returns the ISO string, not a Date (avoids a
           -- "Wed Apr 01" restringify and a timezone shift).
           tn.date_start::text AS start_date,
           tn.tournament_type,
           gr.wins,
           gr.losses,
           sr.wins AS series_wins,
           sr.losses AS series_losses,
           sr.formats,
           sr.series,
           tp.placement
    FROM game_record gr
    JOIN series_record sr ON sr.tournament_id = gr.tournament_id
    JOIN tournaments tn ON tn.id = gr.tournament_id
    LEFT JOIN tournament_placements tp ON tp.tournament_id = tn.id AND tp.team_id = $1
    ORDER BY tn.date_start DESC
    `,
    [teamId],
  );

  const records = recordResult.rows.map((row) => ({
    event: row.event,
    startDate: String(row.start_date).slice(0, 10),
    wins: row.wins,
    losses: row.losses,
    seriesWins: row.series_wins,
    seriesLosses: row.series_losses,
    formats: (row.formats ?? []).map(Number).sort((a, b) => a - b),
    series: row.series ?? [],
    placement: row.placement,
    type: row.tournament_type,
  }));

  return {
    ...team,
    roster,
    // Records run newest-first, so the last six splits are the first six regional rows.
    regional: records.filter((r) => r.type !== 'international').slice(0, 6).map(({ type: _type, ...rest }) => rest),
    international: records.filter((r) => r.type === 'international').map(({ type: _type, ...rest }) => rest),
  };
}

/**
 * 'regional' (default) ranks on within-league percentile, so it only makes sense
 * filtered to one league. 'international' (the Global tab) rates on international
 * games against a role peer group, so it IS cross-league comparable; players with
 * no international record are absent.
 */
export async function getPlayers(
  pool: Pool,
  leagueSlug?: string,
  scope: PlayerRatingScope = 'regional',
  window: RatingWindow = 'all',
): Promise<PlayerSummaryDto[]> {
  // The international pass only ever writes 'all' (events are too sparse for a
  // bounded window), so a bounded request there would return an empty board.
  const ratingWindow: RatingWindow = scope === 'international' ? 'all' : window;
  const result = await pool.query<{
    id: number;
    handle: string;
    team_id: number | null;
    team_slug: string | null;
    team_name: string | null;
    league_slug: string | null;
    role: PlayerSummaryDto['role'] | null;
    rating: string | null;
    games_played: number | null;
    secondary_team: string | null;
  }>(
    `
    WITH ${LEAGUE_LATEST_SPLIT_CTE}
    SELECT p.id, p.handle, t.id AS team_id, t.slug AS team_slug, t.name AS team_name, l.slug AS league_slug, rm.role,
           prh.rating, prh.games_played, rm.secondary_team
    FROM players p
    LEFT JOIN roster_memberships rm ON rm.player_id = p.id AND rm.end_date IS NULL
    LEFT JOIN teams t ON t.id = rm.team_id
    LEFT JOIN team_league_memberships tlm ON tlm.team_id = t.id AND tlm.end_date IS NULL
    LEFT JOIN leagues l ON l.id = tlm.league_id
    LEFT JOIN team_last_game tlg ON tlg.team_id = t.id
    LEFT JOIN league_latest_split lls ON lls.canonical_league_id = l.id
    -- The group must match the board: regional reads the (league, role) group for
    -- the rostered league (or a transfer is ranked on games they left). Intl is role-only.
    LEFT JOIN LATERAL (
      SELECT rating, games_played FROM player_ratings_history prh_inner
      WHERE prh_inner.player_id = p.id
        AND prh_inner.scope = $2
        AND prh_inner.rating_window = $3
        AND prh_inner.role = rm.role
        AND ($2 = 'international' OR prh_inner.league_id = l.id)
      ORDER BY as_of_date DESC LIMIT 1
    ) prh ON true
    WHERE ($1::text IS NULL OR l.slug = $1)
      AND (t.id IS NULL OR tlg.last_game_at >= lls.latest_split_start)
      -- Global tab: no international games, no row. Regional keeps unrated
      -- signings at the neutral 50 so a roster is never missing anyone.
      AND ($2 <> 'international' OR prh.rating IS NOT NULL)
    `,
    [leagueSlug ?? null, scope, ratingWindow],
  );

  const withRatings = result.rows
    .filter((row) => row.role !== null)
    .map((row) => ({
      id: row.id,
      handle: row.handle,
      teamId: row.team_id,
      teamSlug: row.team_slug,
      teamName: row.team_name,
      leagueSlug: row.league_slug,
      role: row.role as PlayerSummaryDto['role'],
      rating: row.rating !== null ? Number(row.rating) : 50, // 50 = neutral composite score, no games yet
      scope,
      window: ratingWindow,
      gamesPlayed: row.games_played ?? 0,
      // Only on a zero-game row -- the case a second squad actually explains.
      alsoPlaysFor: (row.games_played ?? 0) === 0 ? row.secondary_team : null,
    }));

  withRatings.sort((a, b) => b.rating - a.rating);
  return withRatings.map((row, index) => ({ ...row, rank: index + 1 }));
}

/** Must match computePlayerRatings.ts, or the stat line disagrees with the rating. */
const INTERNATIONAL_WINDOW_MONTHS = 36;

interface PlayerStatsRow {
  role: string;
  games: number;
  wins: number;
  [metric: string]: number | string | null;
}

// Every panel metric with its better direction. Deaths sorts ascending (lower is
// better); everything else descending, so 1st always means best.
const STAT_METRICS = [
  { key: 'kills', expr: 'AVG(s.kills)', better: 'higher' },
  { key: 'deaths', expr: 'AVG(s.deaths)', better: 'lower' },
  { key: 'assists', expr: 'AVG(s.assists)', better: 'higher' },
  { key: 'kda', expr: '(SUM(s.kills) + SUM(s.assists))::numeric / GREATEST(SUM(s.deaths), 1)', better: 'higher' },
  // Total CS over total time, not the mean of per-game rates (a 20-min stomp and
  // a 40-min grind aren't equal evidence); games missing either side are excluded.
  {
    key: 'csPerMin',
    expr: `SUM(s.creep_score) FILTER (WHERE s.creep_score IS NOT NULL AND s.gamelength_seconds IS NOT NULL) * 60.0
           / NULLIF(SUM(s.gamelength_seconds) FILTER (WHERE s.creep_score IS NOT NULL AND s.gamelength_seconds IS NOT NULL), 0)`,
    better: 'higher',
  },
  { key: 'goldDiff', expr: 'AVG(s.gold_diff)', better: 'higher' },
  { key: 'killParticipation', expr: 'AVG(s.kill_participation)', better: 'higher' },
  { key: 'damageShare', expr: 'AVG(s.damage_share)', better: 'higher' },
  { key: 'goldShare', expr: 'AVG(s.gold_share)', better: 'higher' },
  // The player's team's share of neutral objectives -- a jungle-defining stat.
  { key: 'objectiveControl', expr: 'AVG(s.obj_control)', better: 'higher' },
] as const;

/**
 * A player's stat line for one scope, each figure placed against same-role peers.
 * Scoped to exactly the games the rating came from (Berserker's LCS and LCK games
 * are two stat lines), and peers come from the board itself, so the places agree
 * with the rows on screen.
 */
export async function getPlayerById(
  pool: Pool,
  playerId: number,
  scope: PlayerRatingScope,
  window: RatingWindow = 'all',
): Promise<PlayerDetailDto | null> {
  // Internationally there is only ever an 'all' window to draw from.
  const ratingWindow: RatingWindow = scope === 'international' ? 'all' : window;
  // Regional ratings are within-league percentiles, so the board is the player's
  // own league. International is already one pool, so it needs no narrowing.
  let leagueSlug: string | undefined;
  let leagueId: number | undefined;
  if (scope === 'regional') {
    const leagueRow = await pool.query<{ id: number; slug: string }>(
      `SELECT l.id, l.slug FROM roster_memberships rm
       JOIN team_league_memberships tlm ON tlm.team_id = rm.team_id AND tlm.end_date IS NULL
       JOIN leagues l ON l.id = tlm.league_id
       WHERE rm.player_id = $1 AND rm.end_date IS NULL LIMIT 1`,
      [playerId],
    );
    leagueSlug = leagueRow.rows[0]?.slug;
    leagueId = leagueRow.rows[0]?.id;
  }

  const summaries = await getPlayers(pool, leagueSlug, scope, ratingWindow);
  const summary = summaries.find((p) => p.id === playerId);
  if (!summary) return null;

  const peerIds = summaries.filter((p) => p.role === summary.role).map((p) => p.id);

  // Each branch restricts to its rating's games. The league param only exists on
  // the regional path, so the role placeholder shifts with it (an unreferenced
  // param leaves Postgres unable to infer its type, 42P18).
  const isInternational = scope === 'international';
  const roleParam = isInternational ? '$3' : '$4';
  const scopeJoin = isInternational
    ? `JOIN series se ON se.id = g.series_id
       JOIN tournaments tn ON tn.id = se.tournament_id
         AND tn.tournament_type = 'international'
         AND g.datetime_utc > NOW() - INTERVAL '${INTERNATIONAL_WINDOW_MONTHS} months'`
    : `JOIN team_league_memberships tlm ON tlm.team_id = pgp.team_id AND tlm.end_date IS NULL
         AND tlm.league_id = $3
       LEFT JOIN league_split_start lss ON lss.canonical_league_id = tlm.league_id`;

  // Same predicate the ratings used, so a split rating isn't shown over a career stat line.
  const windowCte = isInternational ? '' : `${LEAGUE_SPLIT_START_CTE},`;
  const windowFilter = isInternational
    ? ''
    : ` AND ${playerWindowPredicate(ratingWindow, 'g.datetime_utc', 'lss.latest_split_start')}`;

  const aggregates = STAT_METRICS.map((m) => `${m.expr} AS "${m.key}"`).join(',\n      ');
  // rank(), not percent_rank(): the panel reports a place, so ties share one
  // (1, 1, 3). NULLS LAST keeps a player with no value from taking 1st.
  const places = STAT_METRICS.map(
    (m) => `rank() OVER (ORDER BY "${m.key}" ${m.better === 'lower' ? 'ASC' : 'DESC'} NULLS LAST)::int AS "${m.key}_place"`,
  ).join(',\n      ');

  const result = await pool.query<PlayerStatsRow>(
    `
    WITH ${windowCte} scoped AS (
      SELECT pgp.player_id, pgp.role, pgp.kills, pgp.deaths, pgp.assists,
             pgp.creep_score, pgp.gold_diff, pgp.kill_participation,
             pgp.damage_share, pgp.gold_share,
             (CASE WHEN pgp.team_id = g.team1_id THEN g.team1_neutral_objectives ELSE g.team2_neutral_objectives END)::numeric
               / NULLIF(g.team1_neutral_objectives + g.team2_neutral_objectives, 0) AS obj_control,
             g.gamelength_seconds, g.series_id,
             (g.winner_team_id = pgp.team_id) AS won
      FROM player_game_performance pgp
      JOIN games g ON g.id = pgp.game_id
      ${scopeJoin}
      WHERE pgp.player_id = ANY($2::int[]) AND pgp.role = ${roleParam}${windowFilter}
    ),
    -- Re-derived from the games in scope (a mid-split signing gets the series
    -- they played), decided by the scoreline since best_of is unreliable.
    per_series AS (
      SELECT player_id, series_id,
             COUNT(*) FILTER (WHERE won) AS won_games,
             COUNT(*) FILTER (WHERE NOT won) AS lost_games
      FROM scoped
      WHERE series_id IS NOT NULL
      GROUP BY player_id, series_id
    ),
    -- A level series (in progress or only partly held) counts in neither column.
    series_agg AS (
      SELECT player_id,
             COUNT(*) FILTER (WHERE won_games > lost_games)::int AS series_wins,
             COUNT(*) FILTER (WHERE won_games < lost_games)::int AS series_losses
      FROM per_series
      GROUP BY player_id
    ),
    agg AS (
      SELECT s.player_id, s.role,
             COUNT(*)::int AS games,
             COUNT(*) FILTER (WHERE s.won)::int AS wins,
             ${aggregates}
      FROM scoped s
      GROUP BY s.player_id, s.role
    ),
    ranked AS (
      SELECT *,
             ${places}
      FROM agg
    )
    SELECT r.*,
           COALESCE(sa.series_wins, 0) AS series_wins,
           COALESCE(sa.series_losses, 0) AS series_losses
    FROM ranked r
    LEFT JOIN series_agg sa ON sa.player_id = r.player_id
    WHERE r.player_id = $1
    `,
    isInternational ? [playerId, peerIds, summary.role] : [playerId, peerIds, leagueId, summary.role],
  );

  // A player with no games in this group still has a board row (rated 50), so the
  // panel reports an empty stat line rather than 404ing.
  const row = result.rows[0];
  const num = (v: number | string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
  // A missing value drops its place too, so a NULLS LAST rank isn't reported as a genuine last.
  const stat = (key: string) => {
    const value = num(row?.[key]);
    return { value, place: value === null ? null : num(row?.[`${key}_place`]) };
  };

  const games = row?.games ?? 0;
  const wins = row?.wins ?? 0;
  const seriesWins = Number(row?.series_wins ?? 0);
  const seriesLosses = Number(row?.series_losses ?? 0);
  const series = seriesWins + seriesLosses;

  return {
    ...summary,
    // Every same-role row on the board, so the denominator is countable on
    // screen; an unplayed signing takes no place, so the top place can be short of it.
    peerCount: peerIds.length,
    stats: {
      games,
      wins,
      losses: games - wins,
      winRate: games > 0 ? wins / games : 0,
      seriesWins,
      seriesLosses,
      seriesWinRate: series > 0 ? seriesWins / series : 0,
      kills: stat('kills'),
      deaths: stat('deaths'),
      assists: stat('assists'),
      kda: stat('kda'),
      csPerMin: stat('csPerMin'),
      goldDiff: stat('goldDiff'),
      killParticipation: stat('killParticipation'),
      damageShare: stat('damageShare'),
      goldShare: stat('goldShare'),
      objectiveControl: stat('objectiveControl'),
    },
  };
}
