import type { Pool } from 'pg';
import {
  toDisplayRating,
  metaToDisplayOffset,
  initialLeagueMeta,
  internationalParticipationFactor,
  conservativeRank,
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
  PlayerRatingScope,
  RosterEntryDto,
} from '@power-ranking/shared';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
// Must match computeRatings.ts's META_WEIGHT (backtest-tuned to 0.8) -- this
// combination happens at read time, not baked into the stored mu_ctx/mu_meta
// values, so the API has to apply the same weight+confidence-shrinkage the
// replay used or displayed ratings won't match what was actually computed.
const META_WEIGHT = 0.8;
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
    const display = metaToDisplayOffset(meta);
    return { slug: row.slug, name: row.name, logoUrl: row.logo_url, rating: display.rating, rd: display.rd };
  });

  withRatings.sort((a, b) => conservativeRank(b, DEFAULT_CONSERVATIVE_K) - conservativeRank(a, DEFAULT_CONSERVATIVE_K));
  return withRatings.map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function getTeams(pool: Pool, leagueSlug?: string): Promise<TeamSummaryDto[]> {
  const result = await pool.query<{
    id: number;
    slug: string;
    name: string;
    logo_url: string | null;
    brand_color: string | null;
    league_slug: string;
    mu_ctx: string | null;
    phi_ctx: string | null;
    mu_meta: string | null;
    phi_meta: string | null;
    last_intl_game_at: Date | null;
  }>(
    `
    WITH ${LEAGUE_LATEST_SPLIT_CTE}
    SELECT t.id, t.slug, t.name, t.logo_url, t.brand_color, l.slug AS league_slug,
           tr.mu_ctx, tr.phi_ctx, lr.mu_meta, lr.phi_meta, tlig.last_intl_game_at
    FROM teams t
    JOIN team_league_memberships tlm ON tlm.team_id = t.id AND tlm.end_date IS NULL
    JOIN leagues l ON l.id = tlm.league_id
    JOIN team_last_game tlg ON tlg.team_id = t.id
    JOIN league_latest_split lls ON lls.canonical_league_id = l.id
    LEFT JOIN team_last_intl_game tlig ON tlig.team_id = t.id
    LEFT JOIN LATERAL (
      SELECT mu_ctx, phi_ctx FROM team_ratings_history
      WHERE team_id = t.id ORDER BY as_of_date DESC LIMIT 1
    ) tr ON true
    LEFT JOIN LATERAL (
      SELECT mu_meta, phi_meta FROM league_ratings_history
      WHERE league_id = l.id ORDER BY as_of_date DESC LIMIT 1
    ) lr ON true
    WHERE ($1::text IS NULL OR l.slug = $1)
      AND tlg.last_game_at >= lls.latest_split_start
    `,
    [leagueSlug ?? null],
  );

  const withRatings = result.rows.map((row) => {
    const contextual = toRatingState(row.mu_ctx, row.phi_ctx) ?? coldStartState();
    const meta = toRatingState(row.mu_meta, row.phi_meta) ?? initialLeagueMeta(PHI_INIT_MAX);
    const daysSinceLastIntl = row.last_intl_game_at
      ? (Date.now() - row.last_intl_game_at.getTime()) / (1000 * 60 * 60 * 24)
      : null;
    const participationFactor = internationalParticipationFactor(daysSinceLastIntl);
    const display = toDisplayRating(contextual, meta, META_WEIGHT, PHI_INIT_MAX, participationFactor);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      logoUrl: row.logo_url,
      brandColor: row.brand_color,
      leagueSlug: row.league_slug,
      rating: display.rating,
      rd: display.rd,
    };
  });

  // Rank conservatively (rating - RD), not by raw rating -- see
  // conservativeRank's doc comment. `rating` itself is left untouched so the
  // UI still shows the true point estimate, only the ORDER accounts for how
  // uncertain that estimate is.
  withRatings.sort((a, b) => conservativeRank(b, DEFAULT_CONSERVATIVE_K) - conservativeRank(a, DEFAULT_CONSERVATIVE_K));
  return withRatings.map((row, index) => ({ ...row, rank: index + 1 }));
}

export async function getTeamById(pool: Pool, teamId: number): Promise<TeamDetailDto | null> {
  const teams = await getTeams(pool);
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
    ORDER BY rm.role
    `,
    [teamId],
  );

  const roster: RosterEntryDto[] = rosterResult.rows.map((row) => ({
    playerId: row.player_id,
    handle: row.handle,
    role: row.role,
    isStarter: row.is_starter,
  }));

  return { ...team, roster };
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
    team_slug: string | null;
    league_slug: string | null;
    role: PlayerSummaryDto['role'] | null;
    rating: string | null;
    games_played: number | null;
  }>(
    `
    WITH ${LEAGUE_LATEST_SPLIT_CTE}
    SELECT p.id, p.handle, t.slug AS team_slug, l.slug AS league_slug, rm.role,
           prh.rating, prh.games_played
    FROM players p
    LEFT JOIN roster_memberships rm ON rm.player_id = p.id AND rm.end_date IS NULL
    LEFT JOIN teams t ON t.id = rm.team_id
    LEFT JOIN team_league_memberships tlm ON tlm.team_id = t.id AND tlm.end_date IS NULL
    LEFT JOIN leagues l ON l.id = tlm.league_id
    LEFT JOIN team_last_game tlg ON tlg.team_id = t.id
    LEFT JOIN league_latest_split lls ON lls.canonical_league_id = l.id
    LEFT JOIN LATERAL (
      SELECT rating, games_played FROM player_ratings_history
      WHERE player_id = p.id AND scope = $2 ORDER BY as_of_date DESC LIMIT 1
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
      teamSlug: row.team_slug,
      leagueSlug: row.league_slug,
      role: row.role as PlayerSummaryDto['role'],
      rating: row.rating !== null ? Number(row.rating) : 50, // 50 = neutral composite score, no games yet
      scope,
      gamesPlayed: row.games_played ?? 0,
    }));

  withRatings.sort((a, b) => b.rating - a.rating);
  return withRatings.map((row, index) => ({ ...row, rank: index + 1 }));
}
