export const LEAGUE_SLUGS = ['LCK', 'LPL', 'LEC', 'LCS', 'CBLOL', 'LCP'] as const;

export type LeagueSlug = (typeof LEAGUE_SLUGS)[number];

/**
 * A league slug means "ranked on games inside that region", and those numbers
 * are not comparable between regions. 'international' is the one board that
 * can compare regions, because those teams played each other.
 */
export type BoardScope = 'international' | LeagueSlug;

export const BOARD_SCOPES: BoardScope[] = ['international', ...LEAGUE_SLUGS];

export function isBoardScope(value: string | null | undefined): value is BoardScope {
  return value === 'international' || isLeagueSlug(value);
}

/** Narrows an untrusted string (e.g. a `?league=` query param) to a real league. */
export function isLeagueSlug(value: string | null | undefined): value is LeagueSlug {
  return value !== null && value !== undefined && (LEAGUE_SLUGS as readonly string[]).includes(value);
}

export interface BoardUpdated {
  /** A league slug or 'international'. */
  scope: string;
  lastUpdated: string | null;
}

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
  /** rating - rd. What the board is ranked by. */
  floor: number;
  rank: number;
  /** Positive is upward; null when idle. */
  rankChange: number | null;
  /** ISO day `rankChange` measures from. Null exactly when `rankChange` is. */
  comparedTo: string | null;
  games: number;
  recentRosterChange: boolean;
  /** Finish at each of the last four international events this team played. */
  results: { event: string; placement: string | null }[];
  /** Most recent international when none of the last four were attended. */
  lastInternational: string | null;
}

export interface RosterEntry {
  playerId: number;
  handle: string;
  role: 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP';
  isStarter: boolean;
  /** In this team's league at this role -- the figures the player board serves. */
  rating: number;
  rawRating: number;
  confidence: number;
  gamesPlayed: number;
  roleRank: number;
  rolePeerCount: number;
  /** Only ~30% of rostered players are, so the panel offers that board only where there is one. */
  hasInternational: boolean;
  /** The other squad Liquipedia names, when this player has no games here. */
  alsoPlaysFor: string | null;
}

export interface TeamRecord {
  /** As Liquipedia names it: "LEC 2026 Summer". */
  event: string;
  startDate: string;
  wins: number;
  losses: number;
  seriesWins: number;
  seriesLosses: number;
  /** Series lengths played here, ascending: [3, 5] is a Bo3 stage and a Bo5 playoff. */
  formats: number[];
  /** Decided series only, oldest first. */
  series: TeamSeries[];
  /** Text, since shared finishes are ranges. */
  placement: string | null;
}

/** One series, oriented to this team: `ownScore`-`opponentScore`. */
export interface TeamSeries {
  date: string;
  opponent: string;
  ownScore: number;
  opponentScore: number;
  format: number | null;
  won: boolean;
  /** Null where we have no stage marker. */
  isPlayoff: boolean | null;
}

export interface TeamDetail extends TeamSummary {
  roster: RosterEntry[];
  /** Split by split, newest first. */
  regional: TeamRecord[];
  /** Newest first. */
  international: TeamRecord[];
}

/**
 * 'regional' is a percentile within (league, role) and is only meaningful
 * inside one league; 'international' is measured across everyone with
 * international experience. Never compare one to the other.
 */
export type PlayerRatingScope = 'regional' | 'international';

/**
 * Per-league, because the leagues don't run on the same calendar. The
 * international board only has 'all' -- its events are sparse enough that a
 * split window would leave nothing rated.
 */
export const RATING_WINDOWS = ['all', 'year', 'split'] as const;

export type RatingWindow = (typeof RATING_WINDOWS)[number];

/** In-game order. Every roster in the sport is read TOP-JNG-MID-BOT-SUP. */
export const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'] as const;

export type Role = (typeof ROLES)[number];

export interface PlayerSummary {
  id: number;
  handle: string;
  /** Null when unrostered. */
  teamId: number | null;
  teamSlug: string | null;
  /** Display name ("Gen.G"), not the slug. */
  teamName: string | null;
  /** Non-null when a crest can be served for `teamId`. */
  teamLogoUrl: string | null;
  leagueSlug: string | null;
  role: Role;
  rating: number;
  rank: number;
  /** Positive is upward; null when idle. */
  rankChange: number | null;
  /** ISO day `rankChange` measures from. Null exactly when `rankChange` is. */
  comparedTo: string | null;
  scope: PlayerRatingScope;
  /** Always 'all' internationally. */
  window: RatingWindow;
  gamesPlayed: number;
  /** The composite before shrinkage -- where `rating` settles if this form holds. */
  rawRating: number;
  /**
   * How much of `rawRating` the games have earned, 0-1. Served rather than
   * derived from `gamesPlayed`: the shrink runs on a recency-weighted count,
   * and a transferred player is shrunk toward a carryover anchor, not 50.
   */
  confidence: number;
  /** Where they are now, when they hold no roster row in this board's league. */
  movedToTeam: string | null;
  movedToLeague: string | null;
  /** The team they last played for on this board, and the day of that game. */
  lastTeamName: string | null;
  lastPlayedOn: string | null;
}

/**
 * `place` is 1-based and always oriented so 1st is best, including for deaths,
 * where the better raw number is the lower one. Ties share a place.
 */
export interface PlayerStat {
  value: number | null;
  place: number | null;
}

export interface PlayerStats {
  games: number;
  wins: number;
  losses: number;
  winRate: number;
  /** Series are the unit that decides placement. */
  seriesWins: number;
  seriesLosses: number;
  seriesWinRate: number;
  kills: PlayerStat;
  deaths: PlayerStat;
  assists: PlayerStat;
  kda: PlayerStat;
  csPerMin: PlayerStat;
  goldDiff: PlayerStat;
  killParticipation: PlayerStat;
  damageShare: PlayerStat;
  goldShare: PlayerStat;
  objectiveControl: PlayerStat;
}

export interface PlayerDetail extends PlayerSummary {
  alsoPlaysFor: string | null;
  /** Measured over exactly the games this scope's rating was computed from. */
  stats: PlayerStats;
  /** The denominator behind every `place`: same-role players on this board. */
  peerCount: number;
  roleRank: number;
  /**
   * Which stats carry weight at this role. Comes from the server, which reads
   * the tuned weights directly -- restating them here would let the panel and
   * the model drift apart.
   */
  ratedStats: (keyof PlayerStats)[];
}
