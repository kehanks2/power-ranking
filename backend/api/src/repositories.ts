import type { Pool } from 'pg';
import {
  fromGlicko2Scale,
  metaToDisplayOffset,
  initialLeagueMeta,
  conservativeRank,
  META_WEIGHT,
  DEFAULT_CONSERVATIVE_K,
  DEFAULT_SHRINKAGE_GAMES,
  GLICKO2_SCALE,
  DEFAULT_VOLATILITY,
  NEUTRAL_SCORE,
  componentWeightsForRole,
  ROSTER_CHANGE_MIN_GAMES,
  type PlayerComponent,
  type RatingState,
} from '@power-ranking/rating-engine';
import type {
  LeagueSummaryDto,
  TeamSummaryDto,
  TeamDetailDto,
  PlayerSummaryDto,
  PlayerDetailDto,
  PlayerStatsDto,
  PlayerRatingScope,
  RatingWindow,
  RosterEntryDto,
  TeamSeriesDto,
  BoardUpdatedDto,
} from '@power-ranking/shared';
import {
  LEAGUE_SPLIT_START_CTE,
  playerWindowPredicate,
  resolveBoardAdvance,
  STAGE_STATUS_SQL,
  stageKind,
  type BoardAdvance,
  type StageStatus,
} from '@power-ranking/shared';
import { selectCaretGenerations, type Generation } from './caretBaseline.js';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
// A team with no game in its league's latest split is no longer competing.
// team_league_memberships never closes a row, so without this a long-gone team
// stays "current" forever. Keyed per-league, since leagues run on different calendars.
const LEAGUE_LATEST_SPLIT_CTE = `
  league_latest_split AS (
    -- Only splits that have actually been played. The pull reaches 21 days
    -- forward, so a tournament row exists for the NEXT split before any of it
    -- has happened; taking MAX(date_start) over those would set the cutoff to a
    -- future date, no team would have a game at or after it, and the whole
    -- league board would come back empty.
    SELECT t.canonical_league_id, MAX(t.date_start) AS latest_split_start
    FROM tournaments t
    WHERE t.canonical_league_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM series s JOIN games g ON g.series_id = s.id WHERE s.tournament_id = t.id
      )
    GROUP BY t.canonical_league_id
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

/**
 * What each board is showing as of -- the same day its carets measure from.
 *
 * Regional boards follow the stage cadence, so this is the advance date rather
 * than the newest match day ingested. Reporting the latter would have the
 * header claim results the board deliberately excludes: "Updated 2026-08-15"
 * over a board held at 2026-08-09. International is bracket-shaped throughout
 * and never held, so it stays the newest day of play.
 */
export async function getBoardsLastUpdated(pool: Pool): Promise<BoardUpdatedDto[]> {
  const stages = await pool.query<{
    league_id: number;
    league_slug: string;
    bracket_id: string | null;
    last_played_day: string | null;
    previous_played_day: string | null;
    unplayed_series: string;
    frontier_day: string | null;
  }>(STAGE_STATUS_SQL, [null]);

  const slugOf = new Map(stages.rows.map((row) => [row.league_id, row.league_slug]));
  const today = stages.rows[0]?.frontier_day ?? null;
  const statuses: StageStatus[] = stages.rows.map((row) => ({
    leagueId: row.league_id,
    bracketId: row.bracket_id,
    lastPlayedDay: row.last_played_day,
    previousPlayedDay: row.previous_played_day,
    unplayedSeries: Number(row.unplayed_series),
  }));

  const regional = today
    ? resolveBoardAdvance(statuses, today).map((advance) => ({
        scope: slugOf.get(advance.leagueId) ?? String(advance.leagueId),
        lastUpdated: advance.asOfDate,
      }))
    : [];

  // ::text, not a JS Date: pg parses DATE at local midnight, so serialising it
  // back through toISOString() reports the wrong day either side of UTC.
  const international = await pool.query<{ last_updated: string | null }>(`
    SELECT max(g.datetime_utc)::date::text AS last_updated
    FROM games g
    JOIN series s ON s.id = g.series_id
    JOIN tournaments tn ON tn.id = s.tournament_id AND tn.tournament_type = 'international'
  `);

  return [...regional, { scope: 'international', lastUpdated: international.rows[0]?.last_updated ?? null }];
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
      -- id breaks the as_of_date tie, as on team_ratings_history. No league
      -- currently takes two snapshots in a day, so this is latent rather than
      -- live -- but replay inserts chronologically, so the highest id is the
      -- day's final state either way.
      SELECT mu_meta, phi_meta FROM league_ratings_history
      WHERE league_id = l.id ORDER BY as_of_date DESC, id DESC LIMIT 1
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
    FROM tournaments t WHERE t.tournament_type = 'international'
      -- Played only: the forward pull creates a row for the next event before
      -- any of it has happened, which would take a slot from a real one.
      AND EXISTS (SELECT 1 FROM series s JOIN games g ON g.series_id = s.id WHERE s.tournament_id = t.id)
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
  -- Games since the change, not days since it. A split runs 6-9 weeks, so 60
  -- days let a team that changed before the split still read as settled by the
  -- playoffs -- and an off-season change aged out without the new roster
  -- playing once. The flag says the rating has not settled yet, which is a
  -- statement about evidence, so it is counted in games. Threshold is the
  -- model's own ROSTER_CHANGE_MIN_GAMES, interpolated rather than restated.
  recent_churn AS (
    SELECT changed.team_id
    FROM (
      SELECT team_id, MAX(as_of_date) AS changed_on
      FROM team_ratings_history WHERE reason = 'roster_decay'
      GROUP BY team_id
    ) changed
    WHERE (
      SELECT COUNT(*) FROM games g
      WHERE (g.team1_id = changed.team_id OR g.team2_id = changed.team_id)
        AND g.datetime_utc::date >= changed.changed_on
    ) < ${ROSTER_CHANGE_MIN_GAMES}
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
  return withRatings.map((row, index) => ({ ...row, rank: index + 1, rankChange: null, comparedTo: null }));
}

// Counted from the newest game we hold, not from today -- ingestion runs in
// bursts, and a wall-clock cutoff blanks the board whenever a pull is late.
export const RANK_CHANGE_STALE_DAYS = 10;

/**
 * Places gained per row, and the day the prior board they are measured against
 * was taken. Carried together so the board can name its own baseline without a
 * second derivation of which one it used -- `comparedTo` is null on exactly the
 * paths that leave every row dashed.
 */
interface BoardRankChanges {
  changes: Map<number, number | null>;
  comparedTo: string | null;
}

/** Both 'YYYY-MM-DD'. Parsed as UTC so a local offset cannot shift the day. */
function daysBetween(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/**
 * Places gained over the board's most recent day of play, positive upward.
 * One baseline for the whole board, so the deltas cancel; anchored to a match
 * day rather than an ingestion run, so pull cadence cannot leak into them.
 */
/**
 * How far forward one league's board may read, and what its carets measure
 * from. Regional only: international play is bracket-shaped throughout, so it
 * advances per series and is never held.
 *
 * The stall window is measured against the data frontier rather than the wall
 * clock, matching the caret staleness rule -- a board must not release itself
 * merely because ingestion is behind.
 */
async function getBoardAdvance(pool: Pool, leagueSlug: string): Promise<BoardAdvance | null> {
  const stages = await pool.query<{
    league_id: number;
    bracket_id: string | null;
    last_played_day: string | null;
    previous_played_day: string | null;
    unplayed_series: string;
    frontier_day: string | null;
  }>(STAGE_STATUS_SQL, [leagueSlug]);

  const today = stages.rows[0]?.frontier_day;
  if (!today) return null;

  const statuses: StageStatus[] = stages.rows.map((row) => ({
    leagueId: row.league_id,
    bracketId: row.bracket_id,
    lastPlayedDay: row.last_played_day,
    previousPlayedDay: row.previous_played_day,
    unplayedSeries: Number(row.unplayed_series),
  }));

  // Narrowed to this league in SQL, so there is exactly one advance to take.
  return resolveBoardAdvance(statuses, today)[0] ?? null;
}

/**
 * Which generation of player ratings a held board should read.
 *
 * Player ratings are snapshots per recompute rather than a time series, so a
 * board cannot simply read "as of" a date the way team ratings can -- it has to
 * pick the generation whose data stops at or before the stage being shown.
 *
 * Falls back to the OLDEST generation held when none is old enough, not the
 * newest: every candidate is then past the target, so the oldest is nearest to
 * it. That only happens when history is shorter than the hold, which is
 * transient at one recompute a day.
 */
async function resolvePlayerGeneration(
  pool: Pool,
  scope: PlayerRatingScope,
  window: RatingWindow,
  asOfDate: string | null,
): Promise<Date | null> {
  if (!asOfDate) return null;
  const { rows } = await pool.query<{ computed_at: Date; data_frontier: string | null }>(
    `SELECT DISTINCT ON (data_frontier) computed_at, data_frontier::text
       FROM player_ratings_history
      WHERE scope = $1 AND rating_window = $2 AND data_frontier IS NOT NULL
      ORDER BY data_frontier, computed_at DESC`,
    [scope, window],
  );
  if (rows.length === 0) return null;

  const ordered = [...rows].sort((a, b) => (a.data_frontier! < b.data_frontier! ? -1 : 1));
  const qualifying = ordered.filter((row) => row.data_frontier! <= asOfDate);
  return (qualifying.length > 0 ? qualifying[qualifying.length - 1] : ordered[0]).computed_at;
}

async function computeRankChanges(
  pool: Pool,
  ranked: { id: number; rank: number }[],
  international: boolean,
  advance: BoardAdvance | null,
): Promise<BoardRankChanges> {
  const changes = new Map<number, number | null>(ranked.map((t) => [t.id, null]));
  if (ranked.length === 0) return { changes, comparedTo: null };
  const teamIds = ranked.map((t) => t.id);

  // A held board compares stage against stage. Taking everything before the
  // shown day instead would put the end of a week against its own middle,
  // which is the half-round comparison the stage cadence exists to remove.
  if (advance) {
    if (!advance.previousAsOfDate) return { changes, comparedTo: null };
    return computeRankChangesAgainst(pool, ranked, international, advance.asOfDate, advance.previousAsOfDate);
  }

  // The international board only moves on games at international events.
  const gameScope = international
    ? `JOIN series s ON s.id = g.series_id
       JOIN tournaments tn ON tn.id = s.tournament_id AND tn.tournament_type = 'international'`
    : '';
  const matchDay = await pool.query<{ day: string | null }>(
    `SELECT max(g.datetime_utc)::date::text AS day FROM games g ${gameScope}
     WHERE g.team1_id = ANY($1) OR g.team2_id = ANY($1)`,
    [teamIds],
  );
  const baselineDay = matchDay.rows[0]?.day;
  if (!baselineDay) return { changes, comparedTo: null };

  // Unscoped: data freshness, not board activity. Scoped to international it
  // floats to the last event and keeps carets up for months after it ended.
  const newestRow = await pool.query<{ newest: string | null }>(
    `SELECT max(datetime_utc)::date::text AS newest FROM games`,
  );
  const newestDay = newestRow.rows[0]?.newest;
  if (!newestDay) return { changes, comparedTo: null };
  // The whole board dashes, never single teams, or the rest stop reconciling.
  if (daysBetween(baselineDay, newestDay) > RANK_CHANGE_STALE_DAYS) return { changes, comparedTo: null };

  // id breaks the as_of_date tie -- see getTeams. $3 is cast to date, not
  // passed as a Date: a JS Date is local midnight, which under a negative UTC
  // offset lands hours INTO the match day and pulls its own games into "prior".
  const snapshots = await pool.query<{ team_id: number; mu_ctx: string; phi_ctx: string; as_of_date: string }>(
    `SELECT DISTINCT ON (team_id) team_id, mu_ctx, phi_ctx, as_of_date::text FROM team_ratings_history
     WHERE team_id = ANY($1) AND scope = $2 AND as_of_date < $3::date
     ORDER BY team_id, as_of_date DESC, id DESC`,
    [teamIds, international ? 'international' : 'overall', baselineDay],
  );

  // mu - phi orders identically to the displayed floor: fromGlicko2Scale is linear.
  const priorBoard = snapshots.rows
    .map((row) => ({ id: row.team_id, score: Number(row.mu_ctx) - Number(row.phi_ctx) }))
    .sort((a, b) => b.score - a.score);

  // Both ranks over the teams on both boards, or a team that has since joined
  // or left counts as movement someone else made.
  const currentRank = new Map(ranked.map((t) => [t.id, t.rank]));
  const nowOrder = priorBoard
    .map((t) => ({ id: t.id, rank: currentRank.get(t.id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank);

  priorBoard.forEach((team, index) => {
    const nowRank = nowOrder.findIndex((t) => t.id === team.id);
    if (nowRank >= 0) changes.set(team.id, index - nowRank);
  });

  // Each team's own last snapshot before the match day, so the newest of them is
  // the freshest state the prior board contains. ISO days compare as strings.
  const comparedTo = snapshots.rows.reduce<string | null>(
    (newest, row) => (newest === null || row.as_of_date > newest ? row.as_of_date : newest),
    null,
  );
  return { changes, comparedTo };
}

/**
 * Rank change between two stage boundaries, for a board on the stage cadence.
 * Both ends are pinned: the prior board is the state at the end of the previous
 * stage, not merely "before today", so a completed week is compared with the
 * previous completed week rather than with its own middle.
 */
async function computeRankChangesAgainst(
  pool: Pool,
  ranked: { id: number; rank: number }[],
  international: boolean,
  shownDay: string | null,
  priorDay: string,
): Promise<BoardRankChanges> {
  const changes = new Map<number, number | null>(ranked.map((t) => [t.id, null]));
  const teamIds = ranked.map((t) => t.id);

  const newestRow = await pool.query<{ newest: string | null }>(
    `SELECT max(datetime_utc)::date::text AS newest FROM games`,
  );
  const newestDay = newestRow.rows[0]?.newest;
  // Staleness still counts from the data, not the clock, and dashes the whole
  // board rather than single teams so the rest keep reconciling.
  if (!newestDay || !shownDay || daysBetween(shownDay, newestDay) > RANK_CHANGE_STALE_DAYS) {
    return { changes, comparedTo: null };
  }

  const snapshots = await pool.query<{ team_id: number; mu_ctx: string; phi_ctx: string }>(
    `SELECT DISTINCT ON (team_id) team_id, mu_ctx, phi_ctx FROM team_ratings_history
     WHERE team_id = ANY($1) AND scope = $2 AND as_of_date <= $3::date
     ORDER BY team_id, as_of_date DESC, id DESC`,
    [teamIds, international ? 'international' : 'overall', priorDay],
  );

  const priorBoard = snapshots.rows
    .map((row) => ({ id: row.team_id, score: Number(row.mu_ctx) - Number(row.phi_ctx) }))
    .sort((a, b) => b.score - a.score);

  const currentRank = new Map(ranked.map((t) => [t.id, t.rank]));
  const nowOrder = priorBoard
    .map((t) => ({ id: t.id, rank: currentRank.get(t.id) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.rank - b.rank);

  priorBoard.forEach((team, index) => {
    const nowRank = nowOrder.findIndex((t) => t.id === team.id);
    if (nowRank >= 0) changes.set(team.id, index - nowRank);
  });
  return { changes, comparedTo: priorDay };
}

/**
 * A league slug ranks on contextual rating alone (the shared meta cancels) and
 * isn't comparable between regions. 'international' ranks on cross-region games
 * with the league prior off; teams under MIN_INTERNATIONAL_GAMES are absent.
 */
export async function getTeams(pool: Pool, scope: string): Promise<TeamSummaryDto[]> {
  const international = scope === 'international';
  const advance = international ? null : await getBoardAdvance(pool, scope);
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
          -- Played only -- see the international strip above.
          AND EXISTS (SELECT 1 FROM series s JOIN games g ON g.series_id = s.id WHERE s.tournament_id = tn.id)
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
      -- A team takes several snapshots in one day (roster_decay then
      -- game_update) and as_of_date is a DATE, so ordering on it alone returns
      -- an arbitrary one. Replay inserts chronologically: highest id wins.
      -- Bounded to the stage the board has advanced to, so a part-played week
      -- is not on screen: a team playing Saturday would otherwise leapfrog one
      -- playing Sunday and drop back a day later.
      SELECT mu_ctx, phi_ctx FROM team_ratings_history
      WHERE team_id = t.id AND scope = $1
        AND ($3::text IS NULL OR as_of_date <= $3::date)
      ORDER BY as_of_date DESC, id DESC LIMIT 1
    ) tr ON true
    WHERE tlg.last_game_at >= lls.latest_split_start
      AND ($2::text IS NULL OR l.slug = $2)
    `,
    [international ? 'international' : 'overall', international ? null : scope, advance?.asOfDate ?? null],
  );

  const summaries = toTeamSummaries(result.rows);
  const { changes, comparedTo } = await computeRankChanges(pool, summaries, international, advance);
  return summaries.map((team) => {
    const rankChange = changes.get(team.id) ?? null;
    return { ...team, rankChange, comparedTo: rankChange === null ? null : comparedTo };
  });
}

export async function getTeamById(pool: Pool, teamId: number): Promise<TeamDetailDto | null> {
  const leagueRow = await pool.query<{ slug: string }>(
    `SELECT l.slug FROM teams t
     JOIN team_league_memberships tlm ON tlm.team_id = t.id AND tlm.end_date IS NULL
     JOIN leagues l ON l.id = tlm.league_id WHERE t.id = $1`,
    [teamId],
  );
  if (leagueRow.rows.length === 0) return null;
  const leagueSlug = leagueRow.rows[0].slug;
  const teams = await getTeams(pool, leagueSlug);
  const team = teams.find((t) => t.id === teamId);
  if (!team) return null;

  // The roster must read the generation this league's board is held at, so a
  // player's rating here matches the board its roleRank comes from.
  const rosterAdvance = await getBoardAdvance(pool, leagueSlug);
  const rosterGeneration = await resolvePlayerGeneration(pool, 'regional', 'all', rosterAdvance?.asOfDate ?? null);

  const rosterResult = await pool.query<{
    player_id: number;
    handle: string;
    role: RosterEntryDto['role'];
    is_starter: boolean;
    rating: string | null;
    games_played: number | null;
    raw_rating: string | null;
    effective_games: string | null;
    has_international: boolean;
    secondary_team: string | null;
  }>(
    `
    SELECT p.id AS player_id, p.handle, COALESCE(prh.role, rm.role) AS role, rm.is_starter,
           prh.rating, prh.games_played, prh.raw_rating, prh.effective_games, rm.secondary_team,
           EXISTS (
             SELECT 1 FROM player_ratings_history intl
             WHERE intl.player_id = p.id AND intl.scope = 'international'
           ) AS has_international
    FROM roster_memberships rm
    JOIN players p ON p.id = rm.player_id
    JOIN team_league_memberships tlm ON tlm.team_id = rm.team_id AND tlm.end_date IS NULL
    -- Must name the same group the player board does, or the roster shows a
    -- rating earned in a league this player has left. Role preference matches
    -- getPlayers exactly for the same reason -- see the note there.
    LEFT JOIN LATERAL (
      SELECT role, rating, games_played, raw_rating, effective_games
      FROM player_ratings_history prh_inner
      WHERE prh_inner.player_id = p.id
        AND prh_inner.scope = 'regional'
        AND prh_inner.rating_window = 'all'
        AND prh_inner.league_id = tlm.league_id
        -- Same generation the league's player board is pinned to. Reading the
        -- newest instead let a held board show one rating here and another on
        -- /players, with a roleRank taken off the other one.
        AND ($2::timestamptz IS NULL OR prh_inner.computed_at = $2::timestamptz)
      ORDER BY prh_inner.computed_at DESC, (prh_inner.role = rm.role) DESC, prh_inner.games_played DESC
      LIMIT 1
    ) prh ON true
    WHERE rm.team_id = $1 AND rm.end_date IS NULL
    -- In-game order (TOP/JNG/MID/BOT/SUP), not alphabetical; starters lead within a role.
    -- Sorted on the role shown, or a player whose rated role differs from the
    -- squad page's would sit under a heading he is not labelled with.
    ORDER BY array_position(ARRAY['TOP','JNG','MID','BOT','SUP']::text[], COALESCE(prh.role, rm.role)),
             rm.is_starter DESC, p.handle
    `,
    [teamId, rosterGeneration],
  );

  // The league's board, so a roster rank is the same number that board shows
  // when it is filtered to the role -- ranking in SQL could drift from it.
  const leagueBoard = await getPlayers(pool, leagueRow.rows[0].slug);
  const roleOrder = new Map<string, number[]>();
  for (const player of leagueBoard) {
    if (!roleOrder.has(player.role)) roleOrder.set(player.role, []);
    roleOrder.get(player.role)!.push(player.id);
  }

  const roster: RosterEntryDto[] = rosterResult.rows.map((row) => {
    const effectiveGames = row.effective_games !== null ? Number(row.effective_games) : 0;
    const rating = row.rating !== null ? Number(row.rating) : NEUTRAL_SCORE;
    const peers = roleOrder.get(row.role) ?? [];
    return {
      playerId: row.player_id,
      handle: row.handle,
      role: row.role,
      isStarter: row.is_starter,
      rating,
      rawRating: row.raw_rating !== null ? Number(row.raw_rating) : rating,
      confidence: effectiveGames / (effectiveGames + DEFAULT_SHRINKAGE_GAMES),
      gamesPlayed: row.games_played ?? 0,
      roleRank: peers.indexOf(row.player_id) + 1,
      rolePeerCount: peers.length,
      hasInternational: row.has_international,
      // Only on a zero-game row -- the case a second squad actually explains.
      alsoPlaysFor: (row.games_played ?? 0) === 0 ? row.secondary_team : null,
    };
  });

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
    // As the JSON aggregate builds it: the stage marker is raw here and becomes
    // TeamSeriesDto's isPlayoff below.
    series: (Omit<TeamSeriesDto, 'isPlayoff'> & { bracketId: string | null })[];
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
             END AS format,
             s.bracket_id
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
                   'won', winner_team_id = $1,
                   'bracketId', bracket_id
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
    // null, not false, where Liquipedia gave us no stage marker: `stageKind`
    // reads a missing one as bracket play, which is the right fail-safe for
    // advancing a board but would paint every unmarked series as a playoff.
    // bracket_id arrived with migration 0016, so 2026 is complete and the two
    // seasons before it have none.
    series: (row.series ?? []).map(({ bracketId, ...s }) => ({
      ...s,
      isPlayoff: bracketId ? stageKind(bracketId) === 'bracket' : null,
    })),
    placement: row.placement,
    type: row.tournament_type,
  }));

  // The board rates internationals on a fixed six-event window (recent_events),
  // not the team's own last six -- a team present at fewer than six would
  // otherwise reach back past it. Match that window here by name.
  const recentIntl = await pool.query<{ name: string }>(
    `SELECT name FROM tournaments WHERE tournament_type = 'international' ORDER BY date_start DESC LIMIT 6`,
  );
  const recentIntlNames = new Set(recentIntl.rows.map((r) => r.name));

  return {
    ...team,
    roster,
    // Regional runs newest-first, so the team's last six splits are the first six.
    regional: records.filter((r) => r.type !== 'international').slice(0, 6).map(({ type: _type, ...rest }) => rest),
    international: records
      .filter((r) => r.type === 'international' && recentIntlNames.has(r.event))
      .map(({ type: _type, ...rest }) => rest),
  };
}

/**
 * Places gained since the previous generation, positive upward. Null until a
 * second generation exists, so every row dashes before the next ingestion run.
 */
async function computePlayerRankChanges(
  pool: Pool,
  ranked: { id: number; rank: number }[],
  scope: PlayerRatingScope,
  ratingWindow: RatingWindow,
  /** The generation the board is showing, when the stage cadence pinned one. */
  shownGeneration: Date | null,
  /** The board's own league. Null only on the pooled board, which the UI never shows. */
  leagueSlug: string | null,
): Promise<BoardRankChanges> {
  const changes = new Map<number, number | null>(ranked.map((p) => [p.id, null]));
  if (ranked.length === 0) return { changes, comparedTo: null };
  const playerIds = ranked.map((p) => p.id);
  const international = scope === 'international';

  // The board's group predicate without its LIMIT 1, or a transfer is compared
  // against a rating earned in the league they left.
  const history = await pool.query<{
    player_id: number;
    computed_at: Date;
    rating: string;
    data_frontier: string | null;
    method_version: number;
  }>(
    // One row per (player, generation): role is preferred rather than required,
    // matching getPlayers, so a player rated in two roles in one league would
    // otherwise appear twice per generation and rank against himself. Callers
    // key on computed_at and re-sort by rating, so this ORDER BY is free to
    // lead with the DISTINCT ON columns.
    `SELECT DISTINCT ON (prh.player_id, prh.computed_at)
            prh.player_id, prh.computed_at, prh.rating, prh.data_frontier::text, prh.method_version
     FROM players p
     LEFT JOIN roster_memberships rm ON rm.player_id = p.id AND rm.end_date IS NULL
     LEFT JOIN teams t ON t.id = rm.team_id
     LEFT JOIN team_league_memberships tlm ON tlm.team_id = t.id AND tlm.end_date IS NULL
     JOIN player_ratings_history prh ON prh.player_id = p.id
       AND prh.scope = $2 AND prh.rating_window = $3
       -- The BOARD's league, not the player's current roster league. Taking it
       -- from the roster compared a transfer against the wrong pool: Viper sits
       -- on LCK's all-time board off 229 games and is rostered in the LPL, so
       -- his LCK caret was computed from his LPL rating history. A player with
       -- no roster row at all matched nothing and silently lost their caret.
       AND ($2 = 'international' OR $4::text IS NULL
            OR prh.league_id = (SELECT id FROM leagues WHERE slug = $4))
     WHERE p.id = ANY($1)
     ORDER BY prh.player_id, prh.computed_at, (prh.role = rm.role) DESC, prh.games_played DESC`,
    [playerIds, scope, ratingWindow, leagueSlug],
  );
  if (history.rows.length === 0) return { changes, comparedTo: null };

  // A held board must not read carets past the generation it is showing, or the
  // arrows describe results the ratings beside them do not include.
  const shownAt = shownGeneration?.getTime();
  if (new Set(history.rows.map((r) => r.computed_at.getTime())).size < 2) return { changes, comparedTo: null };

  const intlJoin = international
    ? `JOIN series s ON s.id = g.series_id
       JOIN tournaments tn ON tn.id = s.tournament_id AND tn.tournament_type = 'international'`
    : '';
  const matchDay = await pool.query<{ day: string | null }>(
    `SELECT max(g.datetime_utc)::date::text AS day
     FROM player_game_performance pgp
     JOIN games g ON g.id = pgp.game_id
     ${intlJoin}
     WHERE pgp.player_id = ANY($1)`,
    [playerIds],
  );
  const lastPlayed = matchDay.rows[0]?.day;
  if (!lastPlayed) return { changes, comparedTo: null };
  // Unscoped, as on the team board.
  const newestRow = await pool.query<{ newest: string | null }>(
    `SELECT max(datetime_utc)::date::text AS newest FROM games`,
  );
  const newestDay = newestRow.rows[0]?.newest;
  if (!newestDay) return { changes, comparedTo: null };
  if (daysBetween(lastPlayed, newestDay) > RANK_CHANGE_STALE_DAYS) return { changes, comparedTo: null };

  const byGeneration = new Map<number, Generation>();
  for (const row of history.rows) {
    byGeneration.set(row.computed_at.getTime(), {
      computedAt: row.computed_at.getTime(),
      dataFrontier: row.data_frontier,
      methodVersion: row.method_version,
    });
  }
  const chosen = selectCaretGenerations([...byGeneration.values()], lastPlayed, shownAt);
  if (!chosen || chosen.baseline === null) return { changes, comparedTo: null };
  const baseline = chosen.baseline;
  // The generation's data frontier, not when it was computed: a rerun on the
  // same games would otherwise name a day whose results it does not contain.
  const comparedTo = byGeneration.get(baseline)?.dataFrontier ?? null;

  const priorBoard = history.rows
    .filter((row) => row.computed_at.getTime() === baseline)
    .map((row) => ({ id: row.player_id, rating: Number(row.rating) }))
    .sort((a, b) => b.rating - a.rating);

  // Both ranks over the players in both generations, or a signing or departure
  // counts as movement someone else made.
  const currentRank = new Map(ranked.map((p) => [p.id, p.rank]));
  const nowOrder = priorBoard
    .filter((p) => currentRank.has(p.id))
    .map((p) => ({ id: p.id, rank: currentRank.get(p.id)! }))
    .sort((a, b) => a.rank - b.rank);

  priorBoard
    .filter((p) => currentRank.has(p.id))
    .forEach((player, index) => {
      const nowRank = nowOrder.findIndex((p) => p.id === player.id);
      if (nowRank >= 0) changes.set(player.id, index - nowRank);
    });
  return { changes, comparedTo };
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

  // Only a named regional league can be held: the stage cadence is per league,
  // and international is bracket-shaped throughout so it never holds. The
  // pooled call (no league) is left ungated -- it is not a board the UI shows,
  // since regional percentiles from different leagues are not comparable.
  const advance = scope === 'international' || !leagueSlug ? null : await getBoardAdvance(pool, leagueSlug);
  const generation = await resolvePlayerGeneration(pool, scope, ratingWindow, advance?.asOfDate ?? null);
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
    raw_rating: string | null;
    effective_games: string | null;
    secondary_team: string | null;
    moved_to_team: string | null;
    moved_to_league: string | null;
    last_team_name: string | null;
    last_played_on: string | null;
  }>(
    `
    WITH ${LEAGUE_LATEST_SPLIT_CTE},
    -- A board is a list of everyone who PLAYED in it over the window, and only
    -- them. It used to be the current squads, so a player absent from a
    -- Liquipedia squad page was computed and then filtered out -- 73 players
    -- with 1,679 games in 2026, Frog's 15 for Kiwoom DRX among them.
    --
    -- Squads are deliberately NOT unioned in. A rostered player with no games in
    -- the window has no rating, only the neutral 50 standing in for one, and
    -- sorting that placeholder among real measurements pushed every genuine
    -- sub-50 player down a rank -- 34 such rows across the six split boards. A
    -- board ranks by evidence; the team page is the surface whose job is the
    -- complete squad, and it marks anyone who has not played.
    --
    -- The window then decides who belongs with no extra rule, which is what
    -- keeps a departed player off the current-split board and on 'year'/'all':
    -- the model writes a row only for a (league, role) group they have games in,
    -- so Humanoid has an 'all' and a 'year' row for LEC and no 'split' one.
    board AS (
      SELECT DISTINCT prh.player_id, prh.league_id
      FROM player_ratings_history prh
      LEFT JOIN leagues l2 ON l2.id = prh.league_id
      WHERE prh.scope = $2
        AND prh.rating_window = $3
        AND ($4::timestamptz IS NULL OR prh.computed_at = $4::timestamptz)
        AND ($2 = 'international' OR $1::text IS NULL OR l2.slug = $1)
    )
    SELECT b.player_id AS id, p.handle,
           rt.team_id, rt.team_slug, rt.team_name,
           -- International rows carry no league_id, so the Region column falls
           -- back to where the player is currently rostered. Regional rows
           -- always name the board's own league.
           COALESCE(lg.slug, rt.league_slug) AS league_slug,
           COALESCE(prh.role, rt.role) AS role,
           prh.rating, prh.games_played, prh.raw_rating, prh.effective_games, rt.secondary_team,
           away.team_name AS moved_to_team, away.league_slug AS moved_to_league,
           played.team_name AS last_team_name, played.last_played_on::text AS last_played_on
    FROM board b
    JOIN players p ON p.id = b.player_id
    LEFT JOIN leagues lg ON lg.id = b.league_id
    -- Their roster row IN THIS LEAGUE, which is what the Team column may show.
    -- The international board is not a league's board, so any current team is
    -- the right one there -- it is where the player is from, not a claim about
    -- the pool they are ranked in.
    LEFT JOIN LATERAL (
      SELECT t.id AS team_id, t.slug AS team_slug, t.name AS team_name, rm.role,
             rm.secondary_team, l4.slug AS league_slug
      FROM roster_memberships rm
      JOIN teams t ON t.id = rm.team_id
      JOIN team_league_memberships tlm ON tlm.team_id = t.id AND tlm.end_date IS NULL
      JOIN leagues l4 ON l4.id = tlm.league_id
      WHERE rm.player_id = b.player_id
        AND ($2 = 'international' OR tlm.league_id = b.league_id)
      LIMIT 1
    ) rt ON true
    LEFT JOIN LATERAL (
      SELECT role, rating, games_played, raw_rating, effective_games FROM player_ratings_history prh_inner
      WHERE prh_inner.player_id = b.player_id
        AND prh_inner.scope = $2
        AND prh_inner.rating_window = $3
        AND ($2 = 'international' OR prh_inner.league_id = b.league_id)
        -- Pinned to the generation the stage cadence allows, when one applies.
        AND ($4::timestamptz IS NULL OR prh_inner.computed_at = $4::timestamptz)
      -- Role is PREFERRED, not required. Liquipedia's squad role can disagree
      -- with the role actually played, and requiring equality threw the rating
      -- away and showed an unrated 50 instead -- Spica is rostered SUP on NRG
      -- and has 60 JNG games rated 49.8. Newest generation first so an unpinned
      -- read still cannot mix generations; most games breaks a two-role tie.
      ORDER BY prh_inner.computed_at DESC, (prh_inner.role = rt.role) DESC, prh_inner.games_played DESC
      LIMIT 1
    ) prh ON true
    -- Only for a player with no roster row here: where they are NOW. Without it
    -- a transfer reads as "no team" -- Viper is on LCK's all-time board off 229
    -- games and currently plays for Bilibili Gaming in the LPL.
    LEFT JOIN LATERAL (
      SELECT t2.name AS team_name, l3.slug AS league_slug
      FROM roster_memberships rm2
      JOIN teams t2 ON t2.id = rm2.team_id
      JOIN team_league_memberships tlm2 ON tlm2.team_id = t2.id AND tlm2.end_date IS NULL
      JOIN leagues l3 ON l3.id = tlm2.league_id
      WHERE rt.team_id IS NULL AND rm2.player_id = b.player_id
      LIMIT 1
    ) away ON true
    -- The team they last played for on this board, for the note. Past tense with
    -- a date is a statement about games; the Team column stays a claim about now.
    LEFT JOIN LATERAL (
      SELECT t3.name AS team_name, max(g.datetime_utc)::date AS last_played_on
      FROM game_lineups gl
      JOIN games g ON g.id = gl.game_id
      JOIN teams t3 ON t3.id = gl.team_id
      JOIN team_league_memberships tlm3 ON tlm3.team_id = t3.id AND tlm3.end_date IS NULL
      WHERE rt.team_id IS NULL AND gl.player_id = b.player_id
        AND ($2 = 'international' OR tlm3.league_id = b.league_id)
      GROUP BY t3.name
      ORDER BY 2 DESC
      LIMIT 1
    ) played ON true
    -- Global tab: no international games, no row.
    WHERE ($2 <> 'international' OR prh.rating IS NOT NULL)
    `,
    [leagueSlug ?? null, scope, ratingWindow, generation],
  );

  const withRatings = result.rows
    .filter((row) => row.role !== null)
    .map((row) => {
      const rating = row.rating !== null ? Number(row.rating) : NEUTRAL_SCORE; // no games yet
      // A row from before migration 0013 has neither figure; 0 confidence and no
      // tail reads as "nothing vouches for this", which is what we know about it.
      const effectiveGames = row.effective_games !== null ? Number(row.effective_games) : 0;
      return {
        id: row.id,
        handle: row.handle,
        teamId: row.team_id,
        teamSlug: row.team_slug,
        teamName: row.team_name,
        leagueSlug: row.league_slug,
        role: row.role as PlayerSummaryDto['role'],
        rating,
        rawRating: row.raw_rating !== null ? Number(row.raw_rating) : rating,
        confidence: effectiveGames / (effectiveGames + DEFAULT_SHRINKAGE_GAMES),
        scope,
        window: ratingWindow,
        gamesPlayed: row.games_played ?? 0,
        movedToTeam: row.moved_to_team,
        movedToLeague: row.moved_to_league,
        lastTeamName: row.last_team_name,
        lastPlayedOn: row.last_played_on,
      };
    });

  withRatings.sort((a, b) => b.rating - a.rating);
  const ranked = withRatings.map((row, index) => ({ ...row, rank: index + 1, rankChange: null as number | null }));
  const { changes, comparedTo } = await computePlayerRankChanges(
    pool,
    ranked,
    scope,
    ratingWindow,
    generation,
    leagueSlug ?? null,
  );
  return ranked.map((row) => {
    const rankChange = changes.get(row.id) ?? null;
    return { ...row, rankChange, comparedTo: rankChange === null ? null : comparedTo };
  });
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

// Which panel stat each rating component is shown as. winRate is deliberately
// absent: it carries half the rating but is reported as the record above the
// grid, not as a stat in it. Kills/deaths/assists have no component of their own
// -- they are the raw numbers behind KDA, shown for detail.
const COMPONENT_STATS: Partial<Record<PlayerComponent, keyof PlayerStatsDto>> = {
  kda: 'kda',
  csMin: 'csPerMin',
  goldDiff: 'goldDiff',
  goldShare: 'goldShare',
  damageShare: 'damageShare',
  killParticipation: 'killParticipation',
  objControl: 'objectiveControl',
};

/** The panel stats that carry weight at this role, read off the tuned weights themselves. */
function ratedStatsForRole(role: string): (keyof PlayerStatsDto)[] {
  return Object.entries(componentWeightsForRole(role))
    .filter(([, weight]) => (weight ?? 0) > 0)
    .map(([component]) => COMPONENT_STATS[component as PlayerComponent])
    .filter((key): key is keyof PlayerStatsDto => key !== undefined);
}

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
    // The roster names the league when there is one, and their ratings name it
    // when there is not. A board is now a list of who played, so it carries
    // players with no roster row at all -- Bwipo has 218 LCS games and no squad
    // page. Without the fallback the panel found no league, counted no games and
    // reported 0 next to a board row saying 218. One round trip, not two.
    const leagueRow = await pool.query<{ id: number; slug: string }>(
      `SELECT id, slug FROM (
         SELECT l.id, l.slug, 0 AS pref, 0 AS games, NULL::timestamptz AS computed_at
         FROM roster_memberships rm
         JOIN team_league_memberships tlm ON tlm.team_id = rm.team_id AND tlm.end_date IS NULL
         JOIN leagues l ON l.id = tlm.league_id
         WHERE rm.player_id = $1 AND rm.end_date IS NULL
         UNION ALL
         SELECT l.id, l.slug, 1 AS pref, prh.games_played, prh.computed_at
         FROM player_ratings_history prh
         JOIN leagues l ON l.id = prh.league_id
         WHERE prh.player_id = $1 AND prh.scope = 'regional' AND prh.rating_window = $2
       ) x
       ORDER BY pref, computed_at DESC NULLS LAST, games DESC
       LIMIT 1`,
      [playerId, ratingWindow],
    );
    leagueSlug = leagueRow.rows[0]?.slug;
    leagueId = leagueRow.rows[0]?.id;
  }

  const summaries = await getPlayers(pool, leagueSlug, scope, ratingWindow);
  let summary = summaries.find((p) => p.id === playerId);
  // Only a player with no games can have a second squad worth naming, and only
  // the team page can reach one, since boards now carry played rows only.
  let rosterSecondaryTeam: string | null = null;
  if (!summary) {
    // Boards rank by evidence, so a rostered player with no games in this window
    // is not on one. The team page still lists them and opens this panel, so
    // build the neutral row it needs rather than 404ing a roster member.
    const solo = await pool.query<{
      handle: string;
      team_id: number | null;
      team_slug: string | null;
      team_name: string | null;
      league_slug: string | null;
      role: PlayerSummaryDto['role'] | null;
      secondary_team: string | null;
    }>(
      `SELECT p.handle, t.id AS team_id, t.slug AS team_slug, t.name AS team_name,
              l.slug AS league_slug, rm.role, rm.secondary_team
       FROM players p
       LEFT JOIN roster_memberships rm ON rm.player_id = p.id AND rm.end_date IS NULL
       LEFT JOIN teams t ON t.id = rm.team_id
       LEFT JOIN team_league_memberships tlm ON tlm.team_id = t.id AND tlm.end_date IS NULL
       LEFT JOIN leagues l ON l.id = tlm.league_id
       WHERE p.id = $1
       LIMIT 1`,
      [playerId],
    );
    const row = solo.rows[0];
    if (!row || row.role === null) return null;
    rosterSecondaryTeam = row.secondary_team;
    summary = {
      id: playerId,
      handle: row.handle,
      teamId: row.team_id,
      teamSlug: row.team_slug,
      teamName: row.team_name,
      leagueSlug: row.league_slug,
      role: row.role,
      rating: NEUTRAL_SCORE,
      rawRating: NEUTRAL_SCORE,
      confidence: 0,
      scope,
      window: ratingWindow,
      gamesPlayed: 0,
      // Not on a board, so there is no rank and nothing to compare against.
      rank: 0,
      rankChange: null,
      comparedTo: null,
      movedToTeam: null,
      movedToLeague: null,
      lastTeamName: null,
      lastPlayedOn: null,
    };
  }

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
    // peerIds keeps the board's own order, which is by rating.
    roleRank: peerIds.indexOf(playerId) + 1,
    ratedStats: ratedStatsForRole(summary.role),
    alsoPlaysFor: rosterSecondaryTeam,
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
