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
 * Which pool a team's rating was measured against.
 *
 * A league slug means "ranked against other teams in that league, on games
 * played inside it". Those numbers are NOT comparable between regions.
 * 'international' means "ranked on cross-region games only" -- the one scope
 * that can compare regions, because those teams played each other.
 */
export type TeamRatingScope = 'international' | string;

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
  /**
   * The team's finish at each of the last four international events it played.
   * `placement` is text because shared finishes are reported as ranges
   * ("5-6"), and null when the event is in our data but its standings are not.
   */
  results: { event: string; placement: string | null }[];
  /** Most recent international, when none of the last four were attended; otherwise null. */
  lastInternational: string | null;
}

export interface RosterEntryDto {
  playerId: number;
  handle: string;
  role: 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP';
  isStarter: boolean;
}

export interface TeamDetailDto extends TeamSummaryDto {
  roster: RosterEntryDto[];
}

/**
 * Which pool a player's rating was computed against. These are NOT comparable
 * to each other -- see db/migrations/0003_player_rating_scope.sql.
 */
export type PlayerRatingScope = 'regional' | 'international';

export interface PlayerSummaryDto {
  id: number;
  handle: string;
  teamSlug: string | null;
  /** The player's current region/league (e.g. 'LCK'); null if unresolved. */
  leagueSlug: string | null;
  role: 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP';
  rating: number;
  rank: number;
  /** Which pool `rating` was measured against -- it is meaningless without this. */
  scope: PlayerRatingScope;
  /**
   * Games behind `rating`, in whichever scope it was computed. Worth showing:
   * ratings are shrunk toward 50 by sample size, so a low rating on few games
   * means "not yet established", not "bad".
   */
  gamesPlayed: number;
}

/**
 * One stat, with the context needed to read it.
 *
 * `value` alone says very little -- 8.1 CS/min is strong for a support and
 * poor for a mid -- so every stat also carries where it places the player among
 * the same-role players on the same board.
 *
 * `place` is 1-based and always oriented so 1st is best, including for stats
 * where the better raw number is the lower one (deaths). Ties share a place.
 * Null when the stat is unavailable for this player.
 */
export interface PlayerStatDto {
  value: number | null;
  place: number | null;
}

export interface PlayerStatsDto {
  games: number;
  wins: number;
  losses: number;
  winRate: number;
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
}

export interface PlayerDetailDto extends PlayerSummaryDto {
  /**
   * Measured over exactly the games the player's rating for this scope was
   * computed from -- international games in the window for the International
   * board, games in that one league for a regional one. Anything else would
   * put a stat line next to a rating that disagrees with it.
   */
  stats: PlayerStatsDto;
  /** The denominator behind every `place`: same-role players on this board. */
  peerCount: number;
}
