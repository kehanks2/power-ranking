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
  /** Short codes for the last four international events this team played (e.g. ["MSI26","W25"]). */
  attendance: string[];
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
