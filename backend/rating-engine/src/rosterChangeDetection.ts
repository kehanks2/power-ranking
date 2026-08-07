/**
 * Detects roster changes from actual per-game lineups (ScoreboardPlayers),
 * not declared TournamentRosters -- see plan's "Ingestion pipeline &
 * roster-change detection". A different player occupying a role must persist
 * for N consecutive games before it counts as a real swap, so a one-off
 * substitute appearance (illness, visa issue) doesn't trigger a full
 * roster-decay event.
 */

export type Role = 'TOP' | 'JNG' | 'MID' | 'BOT' | 'SUP';

export interface LineupGame {
  gameId: string;
  /** Chronological order key, e.g. datetime_utc as an ISO string or epoch ms. */
  playedAt: string | number;
  lineup: Record<Role, string>; // role -> playerId
}

export interface RosterChangeEvent {
  role: Role;
  previousPlayerId: string;
  newPlayerId: string;
  /** The first game of the new, now-persistent lineup -- the date this event is recorded against. */
  effectiveGameId: string;
  effectiveAt: string | number;
}

const ROLES: Role[] = ['TOP', 'JNG', 'MID', 'BOT', 'SUP'];

/**
 * Walks a team's games in chronological order and returns one event per role
 * change that persisted for at least `persistenceGames` consecutive games.
 * A substitute who plays fewer than that before the original player returns
 * produces no event at all.
 */
export function detectRosterChanges(games: LineupGame[], persistenceGames: number): RosterChangeEvent[] {
  const sorted = [...games].sort((a, b) => (a.playedAt < b.playedAt ? -1 : a.playedAt > b.playedAt ? 1 : 0));
  const events: RosterChangeEvent[] = [];

  for (const role of ROLES) {
    let activePlayerId: string | null = null;
    let candidatePlayerId: string | null = null;
    let candidateStreak = 0;
    let candidateStartIndex = -1;

    sorted.forEach((game, index) => {
      const playerInRole = game.lineup[role];
      if (activePlayerId === null) {
        activePlayerId = playerInRole;
        return;
      }

      if (playerInRole === activePlayerId) {
        candidatePlayerId = null;
        candidateStreak = 0;
        return;
      }

      if (playerInRole === candidatePlayerId) {
        candidateStreak += 1;
      } else {
        candidatePlayerId = playerInRole;
        candidateStreak = 1;
        candidateStartIndex = index;
      }

      if (candidateStreak >= persistenceGames) {
        events.push({
          role,
          previousPlayerId: activePlayerId,
          newPlayerId: candidatePlayerId,
          effectiveGameId: sorted[candidateStartIndex].gameId,
          effectiveAt: sorted[candidateStartIndex].playedAt,
        });
        activePlayerId = candidatePlayerId;
        candidatePlayerId = null;
        candidateStreak = 0;
      }
    });
  }

  return events;
}

/** Fraction of the 5 starting roles that changed in a set of detected events (for the same period). */
export function computeTurnover(events: RosterChangeEvent[]): number {
  const changedRoles = new Set(events.map((e) => e.role));
  return changedRoles.size / ROLES.length;
}
