export type LeagueSlug = 'LCK' | 'LPL' | 'LEC' | 'LCS' | 'CBLOL' | 'LCP';

export interface LeagueSummary {
  slug: LeagueSlug;
  name: string;
  logoUrl: string | null;
  rating: number;
  rd: number;
  rank: number;
}

export interface TeamSummary {
  id: number;
  slug: string;
  name: string;
  logoUrl: string | null;
  brandColor: string | null;
  leagueSlug: LeagueSlug;
  rating: number;
  rd: number;
  rank: number;
}

export interface RosterEntry {
  playerId: number;
  handle: string;
  role: 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP';
  isStarter: boolean;
}

export interface TeamDetail extends TeamSummary {
  roster: RosterEntry[];
}

/**
 * Which pool a player's rating was measured against. 'regional' is a
 * percentile within (league, role) and is only meaningful inside one league;
 * 'international' is measured across everyone with international experience
 * and IS cross-league comparable. Never compare one to the other.
 */
export type PlayerRatingScope = 'regional' | 'international';

export interface PlayerSummary {
  id: number;
  handle: string;
  teamSlug: string | null;
  leagueSlug: string | null;
  role: 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP';
  rating: number;
  rank: number;
  scope: PlayerRatingScope;
  gamesPlayed: number;
}
