import type { Pool } from 'pg';
import { fetchActiveTeams, fetchAllActiveSquadPlayers, type LiquipediaSquadPlayer } from './liquipediaApi.js';
import { upsertPlayer } from './upsert.js';
import { resolvePosition, resolveTeamPagename } from './liquipediaMappings.js';

export interface RosterImportResult {
  teamsMatched: number;
  teamsUnmatched: string[];
  membershipsInserted: number;
  playersCreated: number;
}

/**
 * Liquipedia explicitly tags bench players via role="Substitute" -- everyone
 * else (empty/missing role, "Loan", "Captain", etc.) is genuinely playing
 * that position right now. Two players both resolving to is_starter=true for
 * the same role IS the "shared role" case (see module doc) -- not a bug.
 * Defensively treats a missing/null role (not just "") as non-substitute,
 * since a bug here would silently crash INSERTs for every normal starter.
 */
export function isStarterFromRole(role: string | null | undefined): boolean {
  return (role ?? '').trim().toLowerCase() !== 'substitute';
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

  const client = await pool.connect();
  let membershipsInserted = 0;
  let playersCreated = 0;
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM roster_memberships');

    for (const { teamId, pagename } of matchedTeams) {
      const squad = squadByPagename.get(pagename) ?? [];

      for (const member of squad) {
        const role = resolvePosition(member.position);
        if (!role) continue; // non-standard/blank position -- not a starting role we track

        const playerLookup = await client.query<{ id: number }>(
          `SELECT id FROM players WHERE lower(handle) = lower($1) LIMIT 1`,
          [member.id],
        );
        let playerId: number;
        if (playerLookup.rows.length > 0) {
          playerId = playerLookup.rows[0].id;
        } else {
          playerId = await upsertPlayer(client as unknown as Pool, {
            leaguepediaPage: `liquipedia:player:${member.id}`,
            handle: member.id,
          });
          playersCreated += 1;
        }

        const startDate = member.joindate && member.joindate !== '0000-01-01' ? member.joindate : new Date().toISOString().slice(0, 10);
        const isStarter = isStarterFromRole(member.role);
        await client.query(
          `INSERT INTO roster_memberships (team_id, player_id, role, is_starter, start_date, end_date)
           VALUES ($1, $2, $3, $4, $5, NULL)`,
          [teamId, playerId, role, isStarter, startDate],
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

  return { teamsMatched: matchedTeams.length, teamsUnmatched, membershipsInserted, playersCreated };
}
