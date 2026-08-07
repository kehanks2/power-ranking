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
  RosterEntryDto,
} from '@power-ranking/shared';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
// META_WEIGHT is imported, not restated: combination happens at read time
// rather than being baked into the stored mu_ctx/mu_meta, so the API has to
// apply exactly the weight the replay used or displayed ratings disagree with
// what was computed.
// A team with no game in its league's latest split is treated as no longer
// actively competing (e.g. relegated, or just not in the current split's
// lineup) -- team_league_memberships only ever grows an open (end_date IS
// NULL) row per team, never automatically closes one just because a team
// stopped appearing in new data, so without this a team that competed a
// while ago would show up in the "current" team/player lists forever.
// Deliberately keyed to each league's OWN latest split (via tournaments'
// date_start), not a flat day-count off the dataset's global max game date:
// a team can have a recent-looking game date yet still have missed their
// league's current split (confirmed in practice: Los Ratones' last game was
// ~175 days before the dataset's global max, under an earlier flat 200-day
// threshold, but that game predated their own league's latest split entirely).
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
    // Weighted, so the Leagues board reports the credit these teams actually
    // carry rather than the raw internal parameter.
    const display = metaToDisplayOffset(meta, META_WEIGHT, PHI_INIT_MAX);
    return { slug: row.slug, name: row.name, logoUrl: row.logo_url, rating: display.rating, rd: display.rd };
  });

  withRatings.sort((a, b) => conservativeRank(b, DEFAULT_CONSERVATIVE_K) - conservativeRank(a, DEFAULT_CONSERVATIVE_K));
  return withRatings.map((row, index) => ({ ...row, rank: index + 1 }));
}

/**
 * Shared CTEs for the team boards: which events count as "the recent
 * internationals", who attended them, each team's most recent international,
 * and whether they changed roster recently.
 *
 * Six events, matching the window the international rating itself is built
 * from (INTERNATIONAL_EVENT_WINDOW). Showing four while rating on six meant
 * the board's own evidence column disagreed with the number beside it, and
 * with three events a year six is exactly two years.
 */
const TEAM_CONTEXT_CTE = `
  recent_events AS (
    SELECT id, name, date_start,
           CASE WHEN name ILIKE '%First Stand%' THEN 'FS'
                WHEN name ILIKE '%Mid-Season%'  THEN 'MSI'
                ELSE 'W' END || substring(date_start::text, 3, 2) AS code
    FROM tournaments WHERE tournament_type = 'international'
    ORDER BY date_start DESC LIMIT 6
  ),
  -- One row per team per event they played, carrying the finish where we have
  -- it. Ordered newest-first so the board can render fixed columns.
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
  -- Games at international events, matching exactly what the international
  -- board rates on. Includes intra-region matchups played there: two LPL sides
  -- meeting at Worlds is international play.
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
  ),
  all_game_count AS (
    SELECT team_id, COUNT(*) AS games FROM (
      SELECT team1_id AS team_id FROM games UNION ALL SELECT team2_id FROM games
    ) z GROUP BY team_id
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

  // Ranked on the floor, not the rating: a high but thinly-evidenced number
  // should not sit above one we actually know. See conservativeRank.
  withRatings.sort((a, b) => b.floor - a.floor);
  return withRatings.map((row, index) => ({ ...row, rank: index + 1 }));
}

/**
 * One board per pool of evidence.
 *
 * A league slug ranks that league's teams on their CONTEXTUAL rating alone --
 * games played inside the region. The league meta is deliberately not added:
 * every team on the board shares it, so it would cancel, and the per-team
 * participation factor was actively reordering teams within their own region
 * (BNK FEARX outranked Dplus Kia in LCK partly for having attended a recent
 * international). These numbers are not comparable between regions.
 *
 * 'international' ranks on the international-only rating -- cross-region games
 * with the league prior switched off. It is the only scope that can compare
 * regions, and only teams with at least MIN_INTERNATIONAL_GAMES appear; the
 * rest are absent rather than ranked low, because nothing has been shown.
 */
export async function getTeams(pool: Pool, scope: string): Promise<TeamSummaryDto[]> {
  const international = scope === 'international';
  const result = await pool.query<TeamRow>(
    `
    WITH ${LEAGUE_LATEST_SPLIT_CTE},
    ${TEAM_CONTEXT_CTE}
    SELECT t.id, t.slug, t.name, t.logo_url, t.brand_color, l.slug AS league_slug,
           tr.mu_ctx AS mu, tr.phi_ctx AS phi,
           ${international ? 'igc.games' : 'agc.games'} AS games,
           att.results, li.code AS last_code,
           (rc.team_id IS NOT NULL) AS churn
    FROM teams t
    JOIN team_league_memberships tlm ON tlm.team_id = t.id AND tlm.end_date IS NULL
    JOIN leagues l ON l.id = tlm.league_id
    JOIN team_last_game tlg ON tlg.team_id = t.id
    JOIN league_latest_split lls ON lls.canonical_league_id = l.id
    LEFT JOIN attendance att ON att.team_id = t.id
    LEFT JOIN last_intl li ON li.team_id = t.id
    LEFT JOIN recent_churn rc ON rc.team_id = t.id
    LEFT JOIN intl_game_count igc ON igc.team_id = t.id
    LEFT JOIN all_game_count agc ON agc.team_id = t.id
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
    -- In-game order, not alphabetical. TOP/JNG/MID/BOT/SUP is how a roster is
    -- read and written everywhere in the sport; sorting the text puts BOT
    -- first and SUP before TOP, which reads as scrambled to anyone who plays.
    -- Starters lead within a role, so a substitute never heads the list.
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

  // One row per tournament the team played, in games AND in series, with the
  // series lengths that were played. A series record on its own is not
  // comparable between leagues -- a 12-6 in Bo1s is a different season from a
  // 12-6 in Bo5s -- so the formats column is what makes it readable rather
  // than a reason to withhold it. Placements exist for internationals only;
  // we hold no regional standings.
  const recordResult = await pool.query<{
    event: string;
    start_date: string;
    tournament_type: string;
    wins: number;
    losses: number;
    series_wins: number;
    series_losses: number;
    formats: number[] | null;
    placement: string | null;
  }>(
    `
    WITH team_series AS (
      SELECT s.id,
             s.tournament_id,
             s.winner_team_id,
             -- Derived from the scoreline, NOT from series.best_of, which
             -- Liquipedia fills with the declared format on some rows and the
             -- number of games played on others -- so a Bo5 won 3-1 arrives
             -- as "Bo4" and a Bo3 won 2-0 as "Bo2". A decided series always
             -- ran to (2 * winner's score - 1) games' worth of format; a draw
             -- is the one even format there is.
             CASE
               WHEN s.team1_score IS NULL OR s.team2_score IS NULL THEN NULL
               WHEN GREATEST(s.team1_score, s.team2_score) <= 0 THEN NULL
               WHEN s.team1_score = s.team2_score THEN 2 * s.team1_score
               ELSE 2 * GREATEST(s.team1_score, s.team2_score) - 1
             END AS format
      FROM series s
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
      -- Only decided series count. An unplayed fixture has a null winner (see
      -- migration 0010) and would otherwise land in the loss column.
      SELECT tournament_id,
             COUNT(*) FILTER (WHERE winner_team_id = $1)::int AS wins,
             COUNT(*) FILTER (WHERE winner_team_id IS NOT NULL AND winner_team_id <> $1)::int AS losses,
             ARRAY_AGG(DISTINCT format) FILTER (WHERE format IS NOT NULL) AS formats
      FROM team_series
      GROUP BY tournament_id
    )
    SELECT tn.name AS event,
           -- ::text, so node-pg hands back the ISO string rather than parsing
           -- it into a Date that stringifies as "Wed Apr 01" -- and without
           -- the timezone shift a Date round-trip can introduce.
           tn.date_start::text AS start_date,
           tn.tournament_type,
           gr.wins,
           gr.losses,
           sr.wins AS series_wins,
           sr.losses AS series_losses,
           sr.formats,
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
    placement: row.placement,
    type: row.tournament_type,
  }));

  return {
    ...team,
    roster,
    regional: records.filter((r) => r.type !== 'international').map(({ type: _type, ...rest }) => rest),
    international: records.filter((r) => r.type === 'international').map(({ type: _type, ...rest }) => rest),
  };
}

/**
 * `scope: 'regional'` (default) ranks players on their within-league
 * percentile, so it only makes sense filtered to a single league -- that is
 * what the per-region tabs use.
 *
 * `scope: 'international'` powers the Global tab: players rated purely on
 * their international games, against a role peer group drawn from everyone
 * else who has played internationally. Because that pool genuinely played
 * each other, these numbers ARE cross-league comparable. Players with no
 * international record are absent rather than assigned a guessed rating, so
 * this list is much shorter than the regional one, and `leagueSlug` here is
 * just the player's home region for display -- it plays no part in the rating.
 */
export async function getPlayers(
  pool: Pool,
  leagueSlug?: string,
  scope: PlayerRatingScope = 'regional',
): Promise<PlayerSummaryDto[]> {
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
    -- The group has to match the board. A regional board asks "how good are
    -- they in THIS league", so it reads the (league, role) group for the league
    -- the player is rostered in -- otherwise someone who transferred is ranked
    -- on games from the league they left (6 of 324 rostered players). The
    -- international pool has no league dimension, so there it is role only.
    LEFT JOIN LATERAL (
      SELECT rating, games_played FROM player_ratings_history prh_inner
      WHERE prh_inner.player_id = p.id
        AND prh_inner.scope = $2
        AND prh_inner.role = rm.role
        AND ($2 = 'international' OR prh_inner.league_id = l.id)
      ORDER BY as_of_date DESC LIMIT 1
    ) prh ON true
    WHERE ($1::text IS NULL OR l.slug = $1)
      AND (t.id IS NULL OR tlg.last_game_at >= lls.latest_split_start)
      -- The Global tab makes a claim only where there is evidence: no
      -- international games, no row. The regional list keeps unrated players
      -- (new signings) at the neutral 50 so a roster is never missing anyone.
      AND ($2 <> 'international' OR prh.rating IS NOT NULL)
    `,
    [leagueSlug ?? null, scope],
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
      gamesPlayed: row.games_played ?? 0,
      // Only surfaced where it explains something. Liquipedia lists plenty of
      // established pros on a second squad for reasons that are not academy
      // arrangements -- Gen.G's collegiate programme puts Ruler on Ohio State
      // with 273 games to his name -- and "Ruler also plays for Ohio State"
      // would be nonsense. A player with no games on this board is the case
      // the second squad actually accounts for.
      alsoPlaysFor: (row.games_played ?? 0) === 0 ? row.secondary_team : null,
    }));

  withRatings.sort((a, b) => b.rating - a.rating);
  return withRatings.map((row, index) => ({ ...row, rank: index + 1 }));
}

/**
 * Must match computePlayerRatings.ts. The international rating is computed over
 * international games from the last 36 months only; showing a stat line over
 * any other set of games would put numbers next to a rating that disagrees
 * with them.
 */
const INTERNATIONAL_WINDOW_MONTHS = 36;

interface PlayerStatsRow {
  role: string;
  games: number;
  wins: number;
  [metric: string]: number | string | null;
}

/**
 * Every metric the panel shows, with the direction that counts as better.
 * Deaths is the only one where the better raw number is the lower one, so it
 * sorts ascending while everything else sorts descending -- 1st always means
 * best, whichever way the underlying number runs.
 */
const STAT_METRICS = [
  { key: 'kills', expr: 'AVG(s.kills)', better: 'higher' },
  { key: 'deaths', expr: 'AVG(s.deaths)', better: 'lower' },
  { key: 'assists', expr: 'AVG(s.assists)', better: 'higher' },
  { key: 'kda', expr: '(SUM(s.kills) + SUM(s.assists))::numeric / GREATEST(SUM(s.deaths), 1)', better: 'higher' },
  // Aggregated as total CS over total time, not the mean of per-game rates:
  // a 20-minute stomp and a 40-minute grind are not equal evidence. Games
  // missing either side are excluded from both halves rather than counted as
  // zero.
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
] as const;

/**
 * A player's stat line for one scope, each figure placed against same-role
 * peers in that same scope.
 *
 * Scoped to exactly the games the rating was computed from, so the panel's
 * game count is the board's Games column rather than a second, larger number:
 * on a regional board that is the player's games in THAT league (Berserker has
 * 130 in LCS and 88 in LCK, and the two are different stat lines, not one), and
 * on the international board it is their international games in the window.
 *
 * Peers are taken from the board itself rather than rebuilt from a query, so
 * "3rd of 12" always agrees with the rows a reader can count on screen. Only
 * peers who actually have games in the group are counted -- a player who just
 * transferred in has no stat line to place.
 */
export async function getPlayerById(pool: Pool, playerId: number, scope: PlayerRatingScope): Promise<PlayerDetailDto | null> {
  // Regional ratings are within-league percentiles, so the board has to be the
  // player's own league -- ranking them against a pool of every league at once
  // is the cross-league comparison the whole design refuses to make.
  // International is already one pool, so it needs no narrowing.
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

  const summaries = await getPlayers(pool, leagueSlug, scope);
  const summary = summaries.find((p) => p.id === playerId);
  if (!summary) return null;

  const peerIds = summaries.filter((p) => p.role === summary.role).map((p) => p.id);

  // Regional restricts to games played for a team in this league, matching
  // fetchPlayerGameRows' grouping; international restricts to the event type
  // and window computeInternationalPlayerRatings uses. Either way the set of
  // games is the one behind the rating.
  // The league parameter only exists on the regional path, so the role
  // placeholder shifts with it -- passing an unreferenced parameter leaves
  // Postgres unable to infer its type (42P18).
  const isInternational = scope === 'international';
  const roleParam = isInternational ? '$3' : '$4';
  const scopeJoin = isInternational
    ? `JOIN series se ON se.id = g.series_id
       JOIN tournaments tn ON tn.id = se.tournament_id
         AND tn.tournament_type = 'international'
         AND g.datetime_utc > NOW() - INTERVAL '${INTERNATIONAL_WINDOW_MONTHS} months'`
    : `JOIN team_league_memberships tlm ON tlm.team_id = pgp.team_id AND tlm.end_date IS NULL
         AND tlm.league_id = $3`;

  const aggregates = STAT_METRICS.map((m) => `${m.expr} AS "${m.key}"`).join(',\n      ');
  // rank(), not percent_rank(): the panel reports a place, so ties share a
  // place (1, 1, 3) the way a leaderboard does. NULLS LAST keeps a player with
  // no value for a stat from taking 1st in it.
  const places = STAT_METRICS.map(
    (m) => `rank() OVER (ORDER BY "${m.key}" ${m.better === 'lower' ? 'ASC' : 'DESC'} NULLS LAST)::int AS "${m.key}_place"`,
  ).join(',\n      ');

  const result = await pool.query<PlayerStatsRow>(
    `
    WITH scoped AS (
      SELECT pgp.player_id, pgp.role, pgp.kills, pgp.deaths, pgp.assists,
             pgp.creep_score, pgp.gold_diff, pgp.kill_participation,
             pgp.damage_share, pgp.gold_share,
             g.gamelength_seconds,
             (g.winner_team_id = pgp.team_id) AS won
      FROM player_game_performance pgp
      JOIN games g ON g.id = pgp.game_id
      ${scopeJoin}
      WHERE pgp.player_id = ANY($2::int[]) AND pgp.role = ${roleParam}
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
    SELECT * FROM ranked WHERE player_id = $1
    `,
    isInternational ? [playerId, peerIds, summary.role] : [playerId, peerIds, leagueId, summary.role],
  );

  // A player with no games in this group still has a board row (rated 50,
  // "not yet established"), so the panel reports an empty stat line rather
  // than 404ing and looking broken.
  const row = result.rows[0];
  const num = (v: number | string | null | undefined): number | null => (v === null || v === undefined ? null : Number(v));
  // A missing value has no standing to report. rank() still assigns NULLS LAST
  // rows a place, so the place is dropped alongside the value rather than
  // reported as a genuine last.
  const stat = (key: string) => {
    const value = num(row?.[key]);
    return { value, place: value === null ? null : num(row?.[`${key}_place`]) };
  };

  const games = row?.games ?? 0;
  const wins = row?.wins ?? 0;

  return {
    ...summary,
    // Every same-role row on the board, not just the rankable ones, so the
    // denominator is what a reader can count on screen. A peer who has not
    // played in this group yet (a fresh signing) simply takes no place, which
    // is why the highest place can be short of this number.
    peerCount: peerIds.length,
    stats: {
      games,
      wins,
      losses: games - wins,
      winRate: games > 0 ? wins / games : 0,
      kills: stat('kills'),
      deaths: stat('deaths'),
      assists: stat('assists'),
      kda: stat('kda'),
      csPerMin: stat('csPerMin'),
      goldDiff: stat('goldDiff'),
      killParticipation: stat('killParticipation'),
      damageShare: stat('damageShare'),
      goldShare: stat('goldShare'),
    },
  };
}
