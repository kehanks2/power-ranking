export const LEAGUE_SLUGS = ['LCK', 'LPL', 'LEC', 'LCS', 'CBLOL', 'LCP'] as const;

export type LeagueSlug = (typeof LEAGUE_SLUGS)[number];

/**
 * Which board is being shown. There is no global board: every board is one
 * pool of evidence. A league slug means "ranked on games inside that region",
 * and those numbers are not comparable between regions. 'international' means
 * "ranked on cross-region games only" -- the one board that can compare
 * regions, because those teams played each other.
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

/** `scope` is a league slug or 'international'; ISO date, null if never played. */
export interface BoardUpdated {
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
  /** Places gained since this team last played, positive upward; null when idle. */
  rankChange: number | null;
  games: number;
  recentRosterChange: boolean;
  /** Finish at each of the last four international events this team played. */
  results: { event: string; placement: string | null }[];
  /** Most recent international when none of the last four were attended; otherwise null. */
  lastInternational: string | null;
}

export interface RosterEntry {
  playerId: number;
  handle: string;
  role: 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP';
  isStarter: boolean;
  /** In this team's league at this role -- the same figures the player board serves. */
  rating: number;
  rawRating: number;
  confidence: number;
  gamesPlayed: number;
  /** Their place among the league's players at this position, by rating. */
  roleRank: number;
  rolePeerCount: number;
  /**
   * Whether this player is rated internationally at all. Only ~30% of rostered
   * players are, so the panel offers that board only where there is one.
   */
  hasInternational: boolean;
}

/** A team's record at one tournament, in games and in series. */
export interface TeamRecord {
  /** The tournament as Liquipedia names it: "LEC 2026 Summer". */
  event: string;
  startDate: string;
  wins: number;
  losses: number;
  seriesWins: number;
  seriesLosses: number;
  /** Series lengths played here, ascending: [3, 5] is a Bo3 stage and a Bo5 playoff. */
  formats: number[];
  /** The decided series themselves, oldest first, for the expanded row. */
  series: TeamSeries[];
  /** Finish where standings exist; text, since shared finishes are ranges. */
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
}

export interface TeamDetail extends TeamSummary {
  roster: RosterEntry[];
  /** Split by split, newest first. */
  regional: TeamRecord[];
  /** Each international event, newest first. */
  international: TeamRecord[];
}

/**
 * Which pool a player's rating was measured against. 'regional' is a
 * percentile within (league, role) and is only meaningful inside one league;
 * 'international' is measured across everyone with international experience
 * and IS cross-league comparable. Never compare one to the other.
 */
export type PlayerRatingScope = 'regional' | 'international';

/**
 * Which stretch of play a regional rating covers. 'all' is everything we hold,
 * recency-weighted; the other two are that league's current calendar year and
 * its current split. Per-league, because the leagues don't run on the same
 * calendar. The international board only has 'all' — its events are sparse
 * enough that a split window would leave nothing rated.
 */
export const RATING_WINDOWS = ['all', 'year', 'split'] as const;

export type RatingWindow = (typeof RATING_WINDOWS)[number];

/** In-game order. Every roster in the sport is read TOP-JNG-MID-BOT-SUP. */
export const ROLES = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'] as const;

export type Role = (typeof ROLES)[number];

export interface PlayerSummary {
  id: number;
  handle: string;
  /** Their current team, for linking through to it. Null when unrostered. */
  teamId: number | null;
  teamSlug: string | null;
  /** Display name ("Gen.G"), not the slug. */
  teamName: string | null;
  leagueSlug: string | null;
  role: Role;
  rating: number;
  rank: number;
  /** Places gained since this player last played, positive upward; null when idle. */
  rankChange: number | null;
  scope: PlayerRatingScope;
  /** Which stretch of play it was measured over. Always 'all' internationally. */
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
  /**
   * Another squad they are concurrently active on -- almost always an academy
   * or partner team. Set only when they have no games on this board, which is
   * the case it explains.
   */
  alsoPlaysFor: string | null;
}

/**
 * A stat and where it places the player among the same-role players on this
 * board. `place` is 1-based and always oriented so 1st is best, including for
 * deaths, where the better raw number is the lower one. Ties share a place.
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
  /** The same games grouped into series -- the unit that decides placement. */
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
  /** Measured over exactly the games this scope's rating was computed from. */
  stats: PlayerStats;
  /** The denominator behind every `place`: same-role players on this board. */
  peerCount: number;
  /** Where they sit by rating among those peers -- the board's rank filtered to their role. */
  roleRank: number;
  /**
   * Which stats carry weight at this role; the rest are shown as context. Comes
   * from the server, which reads the tuned weights directly — restating them
   * here would let the panel and the model drift apart.
   */
  ratedStats: (keyof PlayerStats)[];
}
