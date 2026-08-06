import type { Pool } from 'pg';
import {
  fetchActiveTeams,
  fetchAllActiveSquadPlayers,
  fetchActivePlayersForTeams,
  type LiquipediaSquadPlayer,
  type LiquipediaPlayer,
} from './liquipediaApi.js';
import type { Role } from '@power-ranking/rating-engine';
import { upsertPlayer } from './upsert.js';
import { resolvePosition, resolveTeamPagename } from './liquipediaMappings.js';

export interface RosterImportResult {
  teamsMatched: number;
  teamsUnmatched: string[];
  membershipsInserted: number;
  playersCreated: number;
  /** Matched teams squadplayer had nothing for, recovered via the v3/player fallback. */
  teamsFromPlayerFallback: string[];
  /**
   * Matched teams that ended up with NO roster from either source. Surfaced
   * rather than left silent: a team quietly having zero players is exactly the
   * failure that went unnoticed with Leviatán.
   */
  teamsWithNoRoster: string[];
}

/**
 * A blank role is a starter; anything Liquipedia bothers to label is not.
 *
 * Surveyed against every active player row on the wiki, the only labels that
 * occur are "Substitute" (56) and "Loan" (2) -- "Inactive" exists but only on
 * `former` rows. Both labels mean the player is not in the starting five, so
 * the test is "is there a label", not a list of known ones. That way a label
 * we have not seen fails safe, instead of promoting someone to starter.
 *
 * Two players both resolving to is_starter=true for the same role IS the
 * "shared role" case (see module doc) -- not a bug. A missing/null role is
 * treated as blank, since a throw here would take out every normal starter.
 */
export function isStarterFromRole(role: string | null | undefined): boolean {
  return (role ?? '').trim() === '';
}

/**
 * A player loaned OUT plays for someone else and does not belong on this
 * squad. `role: "Loan"` alone cannot say which way the loan runs, so the
 * direction is read from `extradata.loanedto`. Currently 2 rows wiki-wide,
 * neither in our six leagues -- this is a latent hole being closed, not an
 * observed defect.
 */
export function isLoanedAway(row: LiquipediaSquadPlayer): boolean {
  return row.extradata?.loanedto === true;
}

/** A roster slot, normalised from whichever Liquipedia dataset supplied it. */
export interface ResolvedSquadMember {
  handle: string;
  role: Role;
  isStarter: boolean;
  startDate: string | null;
}

/**
 * Normalises a `v3/player` row into a roster slot, or undefined if it isn't
 * one.
 *
 * Two filters matter here, both confirmed against Leviatán's real data:
 *
 * 1. `type` must be "player". That team's active list also contains
 *    LautaLoval and Kouke, both `type: "staff"` with `extradata.role: "coach"`
 *    -- Kouke's `roles` map even lists "jungle" and "top" as secondary
 *    entries, so filtering on the role strings alone would field a coach.
 * 2. Position comes from `extradata.role`, not a top-level column -- `v3/player`
 *    has no `position` field at all.
 *
 * `v3/player` carries no join date and no substitute flag, so members resolved
 * this way are treated as starters with an unknown start date. That is the
 * cost of the fallback and why squadplayer stays the primary source.
 */
export function squadMemberFromPlayerRow(row: LiquipediaPlayer): ResolvedSquadMember | undefined {
  if ((row.type ?? '').trim().toLowerCase() !== 'player') return undefined;
  const role = resolvePosition(row.extradata?.role);
  if (!role) return undefined;
  return { handle: row.id, role, isStarter: true, startDate: null };
}

/** Normalises a `v3/squadplayer` row into a roster slot, or undefined if it isn't one. */
export function squadMemberFromSquadRow(row: LiquipediaSquadPlayer): ResolvedSquadMember | undefined {
  if (isLoanedAway(row)) return undefined; // out at another team; not this squad
  const role = resolvePosition(row.position);
  if (!role) return undefined; // non-standard/blank position -- not a starting role we track
  return {
    handle: row.id,
    role,
    isStarter: isStarterFromRole(row.role),
    startDate: row.joindate && row.joindate !== '0000-01-01' ? row.joindate : null,
  };
}

/**
 * The SOLE writer of roster_memberships. It replaces the table wholesale with
 * Liquipedia's own current squad data -- authoritative, not inferred from
 * lineup persistence heuristics.
 *
 * There used to be a second writer (populateRosterMemberships, which derived
 * rosters from game lineups; deleted, see git history). Both began with an
 * unscoped `DELETE FROM roster_memberships`, so whichever ran last silently
 * won, and the LCS rosters regressed twice that way. If a second writer is
 * ever added, scope its delete.
 *
 * Confirmed against real data this fixes a whole class of bug the lineup
 * heuristic couldn't: Liquipedia models "two players sharing a position"
 * (e.g. Cloud9 running APA/Loki at MID and Zven/Tactical at BOT) as a
 * first-class active state, not something a starter/substitute binary can
 * represent -- both simply show is_starter=true here, no forced "pick one."
 *
 * roster_memberships is a pure DISPLAY table (see teamLineups.ts's comment --
 * rating computation reads game_lineups directly, never this table), so
 * replacing its population source doesn't touch the rating engine.
 *
 * Team/player identity: Liquipedia's own page-identity system doesn't overlap
 * with OE's teamid/playerid hashes our existing rows are keyed on, so teams
 * are matched by exact name against Liquipedia's active-team list (only for
 * teams we already track -- this never pulls in a team outside the 6-league
 * scope), and players by handle, creating a new player row (keyed
 * `liquipedia:player:<id>`, distinct from OE's `oe:player:<hash>` keys) for
 * anyone not already known from OE data.
 */
export async function populateRosterFromLiquipedia(pool: Pool): Promise<RosterImportResult> {
  const ourTeams = await pool.query<{ id: number; name: string }>('SELECT id, name FROM teams');
  // Two broad, paginated requests total (teams + all active squad players),
  // not one request per team -- see liquipediaApi.ts's module doc for why
  // that matters against their documented 60/hour limit.
  const liquipediaTeams = await fetchActiveTeams();
  const allSquadPlayers = await fetchAllActiveSquadPlayers();
  const pagenameByName = new Map(liquipediaTeams.map((t) => [t.name, t.pagename]));
  const squadByPagename = new Map<string, LiquipediaSquadPlayer[]>();
  for (const player of allSquadPlayers) {
    if (!squadByPagename.has(player.pagename)) squadByPagename.set(player.pagename, []);
    squadByPagename.get(player.pagename)!.push(player);
  }

  const teamsUnmatched: string[] = [];
  const matchedTeams: { teamId: number; pagename: string }[] = [];
  for (const team of ourTeams.rows) {
    const pagename = resolveTeamPagename(team.name, pagenameByName);
    if (pagename) matchedTeams.push({ teamId: team.id, pagename });
    else teamsUnmatched.push(team.name);
  }

  // Squadplayer is incomplete -- see fetchActivePlayersForTeams. Any matched
  // team it returns nothing for gets a second look via v3/player, which is
  // keyed on the player's page instead and does have them.
  const pagenamesMissingSquad = matchedTeams
    .map(({ pagename }) => pagename)
    .filter((pagename) => (squadByPagename.get(pagename) ?? []).length === 0);
  const fallbackPlayers = await fetchActivePlayersForTeams([...new Set(pagenamesMissingSquad)]);
  const fallbackByPagename = new Map<string, LiquipediaPlayer[]>();
  for (const player of fallbackPlayers) {
    const pagename = player.teampagename;
    if (!pagename) continue;
    if (!fallbackByPagename.has(pagename)) fallbackByPagename.set(pagename, []);
    fallbackByPagename.get(pagename)!.push(player);
  }

  const teamsFromFallback: string[] = [];
  const teamsStillEmpty: string[] = [];

  const client = await pool.connect();
  let membershipsInserted = 0;
  let playersCreated = 0;
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM roster_memberships');

    const today = new Date().toISOString().slice(0, 10);

    for (const { teamId, pagename } of matchedTeams) {
      const squad = squadByPagename.get(pagename) ?? [];
      let members = squad
        .map(squadMemberFromSquadRow)
        .filter((m): m is ResolvedSquadMember => m !== undefined);

      if (members.length === 0) {
        members = (fallbackByPagename.get(pagename) ?? [])
          .map(squadMemberFromPlayerRow)
          .filter((m): m is ResolvedSquadMember => m !== undefined);
        if (members.length > 0) teamsFromFallback.push(pagename);
        else teamsStillEmpty.push(pagename);
      }

      for (const member of members) {
        const playerLookup = await client.query<{ id: number }>(
          `SELECT id FROM players WHERE lower(handle) = lower($1) LIMIT 1`,
          [member.handle],
        );
        let playerId: number;
        if (playerLookup.rows.length > 0) {
          playerId = playerLookup.rows[0].id;
        } else {
          playerId = await upsertPlayer(client as unknown as Pool, {
            leaguepediaPage: `liquipedia:player:${member.handle}`,
            handle: member.handle,
          });
          playersCreated += 1;
        }

        await client.query(
          `INSERT INTO roster_memberships (team_id, player_id, role, is_starter, start_date, end_date)
           VALUES ($1, $2, $3, $4, $5, NULL)`,
          [teamId, playerId, member.role, member.isStarter, member.startDate ?? today],
        );
        membershipsInserted += 1;
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    teamsMatched: matchedTeams.length,
    teamsUnmatched,
    membershipsInserted,
    playersCreated,
    teamsFromPlayerFallback: teamsFromFallback,
    teamsWithNoRoster: teamsStillEmpty,
  };
}
