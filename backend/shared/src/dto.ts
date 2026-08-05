/** Shared read-API response shapes, consumed by both backend/api and the Angular frontend. */

export interface LeagueSummaryDto {
  slug: string;
  name: string;
  logoUrl: string | null;
  rating: number;
  rd: number;
  rank: number;
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
  rank: number;
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
