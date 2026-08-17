/** Shared read-API response shapes, consumed by both backend/api and the Angular frontend. */

export interface LeagueSummaryDto {
  slug: string;
  name: string;
  logoUrl: string | null;
  rating: number;
  rd: number;
  rank: number;
}

/**
 * Which pool a team's rating was measured against. A league slug is NOT
 * comparable between regions; 'international' is the one scope that can compare
 * them, because those teams played each other.
 */
export type TeamRatingScope = 'international' | string;

/** `scope` is a league slug or 'international'; ISO date, null if never played. */
export interface BoardUpdatedDto {
  scope: string;
  lastUpdated: string | null;
}

export interface TeamSummaryDto {
  id: number;
  slug: string;
  name: string;
  logoUrl: string | null;
  brandColor: string | null;
  leagueSlug: string;
  rating: number;
  rd: number;
  /** rating - rd. What the board is ranked by: the level we're confident they're at least at. */
  floor: number;
  rank: number;
  /** Games behind this rating, in whichever scope it was computed. */
  games: number;
  /** A roster change in the last 60 days, which is why the range is wide. */
  recentRosterChange: boolean;
  // Finish at each of the last four international events. `placement` is text
  // (shared finishes are ranges, "5-6") and null when standings are missing.
  results: { event: string; placement: string | null }[];
  /** Most recent international, when none of the last four were attended; otherwise null. */
  lastInternational: string | null;
  /** Places gained on the board's last day of play; null when that is long past. */
  rankChange: number | null;
  /** ISO day `rankChange` measures from. Null exactly when `rankChange` is. */
  comparedTo: string | null;
}

export interface RosterEntryDto {
  playerId: number;
  handle: string;
  role: 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP';
  isStarter: boolean;
  // The player's rating in this team's league at this role -- the same figures
  // the player board serves, so the roster draws the same confidence range. An
  // unrated signing sits at the neutral 50 rather than dropping off the roster.
  rating: number;
  rawRating: number;
  confidence: number;
  gamesPlayed: number;
  // Where they sit among the league's players at their position, which is the
  // board's rank filtered to that role. Read off the board itself rather than
  // ranked in SQL, so the roster cannot disagree with the page it links to.
  roleRank: number;
  rolePeerCount: number;
  // Whether this player is rated on the international board at all. Only ~30% of
  // rostered players are (it needs 10+ international games), so the panel offers
  // that pool only where there is one, rather than switching to an empty grid.
  hasInternational: boolean;
}

/** One series a team played, oriented to them: `ownScore`-`opponentScore`. */
export interface TeamSeriesDto {
  /** ISO date of the series' first game. */
  date: string;
  /** Who they faced, by display name. */
  opponent: string;
  ownScore: number;
  opponentScore: number;
  /** Derived from the scoreline like TeamRecordDto.formats; null if undecided. */
  format: number | null;
  won: boolean;
}

/** A team's record at one tournament. */
export interface TeamRecordDto {
  /** The tournament as Liquipedia names it: "LEC 2026 Summer". */
  event: string;
  /** ISO date the tournament started, for ordering and for showing the year. */
  startDate: string;
  wins: number;
  losses: number;
  seriesWins: number;
  seriesLosses: number;
  // Series lengths, ascending ([3, 5] = a Bo3 stage and a Bo5 playoff). Derived
  // from the scoreline, not the unreliable `series.best_of`.
  formats: number[];
  /** The decided series themselves, most recent first, for the expanded row. */
  series: TeamSeriesDto[];
  /** Finish where standings exist. Text, because shared finishes read "5-8". */
  placement: string | null;
}

export interface TeamDetailDto extends TeamSummaryDto {
  roster: RosterEntryDto[];
  /** Record per split, newest first. */
  regional: TeamRecordDto[];
  /** Record at each international event, newest first. */
  international: TeamRecordDto[];
}

/**
 * Which pool a player's rating was computed against. These are NOT comparable
 * to each other -- see db/migrations/0003_player_rating_scope.sql.
 */
export type PlayerRatingScope = 'regional' | 'international';

// Which stretch a regional rating covers. 'all' is the default and the only
// international window; the bounded ones are per-league (leagues run on different
// calendars). See db/migrations/0011.
export const RATING_WINDOWS = ['all', 'year', 'split'] as const;

export type RatingWindow = (typeof RATING_WINDOWS)[number];

export function isRatingWindow(value: unknown): value is RatingWindow {
  return typeof value === 'string' && (RATING_WINDOWS as readonly string[]).includes(value);
}

/** Each league's current split start, which both bounded windows key off. */
export const LEAGUE_SPLIT_START_CTE = `
  league_split_start AS (
    SELECT canonical_league_id, MAX(date_start) AS latest_split_start
    FROM tournaments
    WHERE canonical_league_id IS NOT NULL
    GROUP BY canonical_league_id
  )
`;

// SQL keeping only games inside a window. Shared so ingestion (which computes the
// rating) and the API (which draws the panel) can't drift apart.
export function playerWindowPredicate(window: RatingWindow, gameTime: string, splitStart: string): string {
  switch (window) {
    case 'split':
      return `${gameTime} >= ${splitStart}`;
    case 'year':
      return `${gameTime} >= date_trunc('year', ${splitStart})`;
    default:
      return 'TRUE';
  }
}

export interface PlayerSummaryDto {
  id: number;
  handle: string;
  /** Their current team, for linking through to it. Null when unrostered. */
  teamId: number | null;
  teamSlug: string | null;
  /** Display name ("Gen.G"), not the slug. */
  teamName: string | null;
  /** The player's current region/league (e.g. 'LCK'); null if unresolved. */
  leagueSlug: string | null;
  role: 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP';
  rating: number;
  rank: number;
  /** Places gained since the previous generation; null until a second one exists. */
  rankChange: number | null;
  /** ISO day `rankChange` measures from. Null exactly when `rankChange` is. */
  comparedTo: string | null;
  /** Which pool `rating` was measured against -- it is meaningless without this. */
  scope: PlayerRatingScope;
  /** Which stretch of play it was measured over. Always 'all' internationally. */
  window: RatingWindow;
  // Games behind `rating`: ratings shrink toward 50 by sample size, so a low one
  // on few games means "not established", not "bad".
  gamesPlayed: number;
  /** The composite before shrinkage -- where `rating` settles if this form holds. */
  rawRating: number;
  // How much of the raw score the games have earned, 0-1. Served rather than
  // derived from gamesPlayed: the shrink runs on a recency-weighted count, and a
  // transferred player is shrunk toward a carryover anchor instead of 50.
  confidence: number;
  // Another squad Liquipedia lists this player on (usually academy/partner, what
  // a zero-game tier-1 row means); attributed to Liquipedia since it can't be
  // told from an unclosed transfer.
  alsoPlaysFor: string | null;
}

// One stat plus its place among same-role players (value alone says little: 8.1
// CS/min is strong for a support, poor for a mid). `place` is 1-based, 1st always
// best (including deaths, where lower is better); ties share a place.
export interface PlayerStatDto {
  value: number | null;
  place: number | null;
}

export interface PlayerStatsDto {
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  // The same games grouped into series -- the unit that decides placement, and
  // routinely disagrees with the game count.
  seriesWins: number;
  seriesLosses: number;
  seriesWinRate: number;
  kills: PlayerStatDto;
  deaths: PlayerStatDto;
  assists: PlayerStatDto;
  /** (kills + assists) / deaths, aggregated over games rather than averaged per game. */
  kda: PlayerStatDto;
  /** Null where game length is missing, which Liquipedia leaves off some games. */
  csPerMin: PlayerStatDto;
  /** Average gold against the same-role opponent. Negative is behind. */
  goldDiff: PlayerStatDto;
  killParticipation: PlayerStatDto;
  damageShare: PlayerStatDto;
  goldShare: PlayerStatDto;
  /** The player's team's share of neutral objectives -- a jungle-defining stat. */
  objectiveControl: PlayerStatDto;
}

export interface PlayerDetailDto extends PlayerSummaryDto {
  /** Over exactly the games this scope's rating was computed from. */
  stats: PlayerStatsDto;
  /** The denominator behind every `place`: same-role players on this board. */
  peerCount: number;
  /** Where they sit by rating among those peers -- the board's rank filtered to their role. */
  roleRank: number;
  // Which stats carry weight at this role, so the panel can show the rest as
  // context rather than as drivers. Served, not mirrored: the weights are tuned
  // constants and restating them here would let the two drift apart.
  ratedStats: (keyof PlayerStatsDto)[];
}
