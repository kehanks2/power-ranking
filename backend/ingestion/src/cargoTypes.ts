/** Row shapes for the Leaguepedia Cargo tables this pipeline reads, per confirmed field names. */

export interface CargoTournamentRow {
  OverviewPage: string;
  Name: string;
  League: string;
  DateStart: string;
  DateEnd: string;
}

export interface CargoScoreboardGameRow {
  UniqueLine: string;
  GameId: string;
  MatchId: string;
  Tournament: string;
  Team1: string;
  Team2: string;
  WinTeam: string;
  DateTime_UTC: string;
  Team1Score: string;
  Team2Score: string;
  Team1Gold: string;
  Team2Gold: string;
  Gamelength_Number: string;
  Patch: string;
}

export interface CargoScoreboardPlayerRow {
  GameId: string;
  Tournament: string;
  Link: string; // canonical player page
  Team: string;
  IngameRole: string; // Top/Jungle/Mid/Bot/Support
  Kills: string;
  Deaths: string;
  Assists: string;
  Gold: string;
  DamageToChampions: string;
}

export interface CargoTournamentRosterRow {
  Team: string;
  RosterLinks: string; // pipe-separated player links
  Roles: string; // pipe-separated roles, aligned with RosterLinks
  Tournament: string;
}

const ROLE_MAP: Record<string, 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP'> = {
  Top: 'TOP',
  Jungle: 'JNG',
  Mid: 'MID',
  Bot: 'BOT',
  Support: 'SUP',
};

/** Normalizes Leaguepedia's IngameRole strings ("Top"/"Jungle"/...) to this project's Role enum. */
export function normalizeRole(ingameRole: string): 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP' | null {
  return ROLE_MAP[ingameRole] ?? null;
}
