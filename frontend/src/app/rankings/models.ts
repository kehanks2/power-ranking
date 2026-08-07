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
  /** Finish where standings exist; text, since shared finishes are ranges. */
  placement: string | null;
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
  scope: PlayerRatingScope;
  gamesPlayed: number;
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
  kills: PlayerStat;
  deaths: PlayerStat;
  assists: PlayerStat;
  kda: PlayerStat;
  csPerMin: PlayerStat;
  goldDiff: PlayerStat;
  killParticipation: PlayerStat;
  damageShare: PlayerStat;
  goldShare: PlayerStat;
}

export interface PlayerDetail extends PlayerSummary {
  /** Measured over exactly the games this scope's rating was computed from. */
  stats: PlayerStats;
  /** The denominator behind every `place`: same-role players on this board. */
  peerCount: number;
}
