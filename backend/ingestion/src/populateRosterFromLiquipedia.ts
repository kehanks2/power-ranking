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
  /** Matched teams that ended up with NO roster from either source. */
  teamsWithNoRoster: string[];
  /** Academy squads dropped from a parent team's page -- see withoutAcademyCohorts. */
  academyCohortsDropped: { team: string; squad: string; handles: string[] }[];
}

// Blank role = starter; any label ("Substitute", "Loan") = not. Testing for a
// label, not a known list, so an unseen one fails safe.
export function isStarterFromRole(role: string | null | undefined): boolean {
  return (role ?? '').trim() === '';
}

// A player loaned OUT belongs to another squad; `role: "Loan"` can't say which
// way the loan runs, so direction comes from `extradata.loanedto`.
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
 * Which OTHER squad each player is concurrently active on, keyed by handle --
 * nearly always an academy/partner team (Vitality's second five on Rising Bees).
 * A second tracked team is a real transfer mid-sweep, not academy, so it's
 * skipped. Can't distinguish a concurrent academy slot from a transfer whose old
 * row the wiki hasn't closed, so the UI attributes this to Liquipedia.
 */
export function buildSecondaryTeams(
  rows: LiquipediaSquadPlayer[],
  trackedPagenames: Set<string>,
): Map<string, string> {
  const pagenamesByHandle = new Map<string, Set<string>>();
  for (const row of rows) {
    if ((row.type ?? '').trim().toLowerCase() !== 'player') continue;
    if (!pagenamesByHandle.has(row.id)) pagenamesByHandle.set(row.id, new Set());
    pagenamesByHandle.get(row.id)!.add(row.pagename);
  }

  const secondary = new Map<string, string>();
  for (const [handle, pagenames] of pagenamesByHandle) {
    const untracked = [...pagenames].filter((p) => !trackedPagenames.has(p));
    // Only meaningful when they're also on a team we track.
    const onTracked = [...pagenames].some((p) => trackedPagenames.has(p));
    if (!onTracked || untracked.length === 0) continue;
    // Deterministic across several untracked squads.
    const sorted = [...untracked].sort((a, b) => a.localeCompare(b));
    secondary.set(handle, sorted[0]);
  }
  return secondary;
}

/** Liquipedia page names read as "Rising_Bees"; nobody says it that way. */
export function humanizePagename(pagename: string): string {
  return pagename.replaceAll('_', ' ');
}

/**
 * Three, not two, so a double academy call-up survives the rule. Any value 2-5
 * fits today's data -- Rising Bees is the only group above one.
 */
export const ACADEMY_COHORT_MIN = 3;

/**
 * Drops an academy squad that Liquipedia lists on its parent team's page.
 * Team_Vitality returned ten players: the real five plus the five Rising Bees,
 * who then sat on the LEC board at a neutral 50 with no games.
 *
 * The discriminator is the COHORT, never `secondary_team` alone. Measured over
 * every active roster, Rising Bees is the only untracked squad named by more
 * than one player; every other is a single player and real -- a signing who has
 * not debuted, or collegiate noise like Ruler's "Ohio State University".
 */
export function withoutAcademyCohorts<T extends { handle: string }>(
  members: T[],
  secondaryTeamByHandle: Map<string, string>,
): { kept: T[]; dropped: { handle: string; squad: string }[] } {
  const countBySquad = new Map<string, number>();
  for (const member of members) {
    const squad = secondaryTeamByHandle.get(member.handle);
    if (squad) countBySquad.set(squad, (countBySquad.get(squad) ?? 0) + 1);
  }

  const kept: T[] = [];
  const dropped: { handle: string; squad: string }[] = [];
  for (const member of members) {
    const squad = secondaryTeamByHandle.get(member.handle);
    if (squad && (countBySquad.get(squad) ?? 0) >= ACADEMY_COHORT_MIN) {
      dropped.push({ handle: member.handle, squad: humanizePagename(squad) });
    } else {
      kept.push(member);
    }
  }
  return { kept, dropped };
}

/**
 * Normalises a `v3/player` row into a roster slot, or undefined. `type` must be
 * "player" (staff carry role "coach" with lane strings in their `roles` map, so
 * filtering on role alone would field a coach), and position comes from
 * `extradata.role` since v3/player has no position column. No join date or
 * substitute flag here, so these are treated as starters with unknown start date.
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
 * The SOLE writer of roster_memberships, replacing the table wholesale with
 * Liquipedia's current squad data. If a second writer is ever added, scope its
 * DELETE -- an unscoped one here regressed the LCS rosters twice. Two players
 * can share a position (Cloud9's APA/Loki at MID); both show is_starter=true.
 * Teams are matched by name (tracked teams only) and players by handle, creating
 * a new `liquipedia:player:<id>` row for anyone not already known from OE.
 *
 * NOT display-only: `computeRatings` reads this table to seed a team's
 * international rating from its roster's player ratings, so a roster edit can
 * move a rating. Only a rostered player who HAS a player rating contributes,
 * which is why dropping the five zero-game Rising Bees moved nothing.
 */
export async function populateRosterFromLiquipedia(pool: Pool): Promise<RosterImportResult> {
  const ourTeams = await pool.query<{ id: number; name: string }>('SELECT id, name FROM teams');
  // Two broad paginated requests (teams + all squad players), not one per team --
  // see liquipediaApi.ts on the 60/hour limit.
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

  const secondaryTeamByHandle = buildSecondaryTeams(
    allSquadPlayers,
    new Set(matchedTeams.map(({ pagename }) => pagename)),
  );

  // Squadplayer is incomplete: a matched team it returns nothing for gets a
  // second look via v3/player (keyed on the player's page). See fetchActivePlayersForTeams.
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
  const academyCohortsDropped: RosterImportResult['academyCohortsDropped'] = [];

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

      const { kept, dropped } = withoutAcademyCohorts(members, secondaryTeamByHandle);
      members = kept;
      for (const squad of new Set(dropped.map((d) => d.squad))) {
        academyCohortsDropped.push({
          team: humanizePagename(pagename),
          squad,
          handles: dropped.filter((d) => d.squad === squad).map((d) => d.handle),
        });
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

        const secondaryPagename = secondaryTeamByHandle.get(member.handle);
        await client.query(
          `INSERT INTO roster_memberships (team_id, player_id, role, is_starter, start_date, end_date, secondary_team)
           VALUES ($1, $2, $3, $4, $5, NULL, $6)`,
          [
            teamId,
            playerId,
            member.role,
            member.isStarter,
            member.startDate ?? today,
            secondaryPagename ? humanizePagename(secondaryPagename) : null,
          ],
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
    academyCohortsDropped,
  };
}
