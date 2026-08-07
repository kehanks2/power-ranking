import type { Pool } from 'pg';
import { fetchPlacements, type LiquipediaPlacement } from './liquipediaApi.js';
import { ourNameToLiquipediaName, HISTORICAL_LIQUIPEDIA_NAME_ALIASES } from './liquipediaMappings.js';

export interface PlacementImportResult {
  tournamentsProcessed: number;
  placementsInserted: number;
  /** Liquipedia team names we hold no team for -- usually wildcard regions outside our six leagues. */
  unmatchedTeams: string[];
}

/**
 * Lowest number in a placement, for ordering. Liquipedia writes shared
 * finishes as ranges ("5-6", "7-8") wherever a bracket has no third-place or
 * consolation match, so "5-6" sorts as 5 while still displaying as the range.
 */
export function placementSortValue(placement: string): number | null {
  const match = /^(\d+)/.exec(placement.trim());
  return match ? Number(match[1]) : null;
}

/**
 * A placement row is a real team standing, rather than an individual award or
 * a blank. `opponenttype` is "solo" for player awards (MVP and the like),
 * which share the endpoint but are not standings.
 */
export function isTeamStanding(row: LiquipediaPlacement): boolean {
  return row.opponenttype === 'team' && placementSortValue(row.placement ?? '') !== null;
}

/**
 * Fills tournament_placements for EVERY tournament we hold, regional splits
 * included. Games record who beat whom, not who won: a team can go 6-4 and
 * finish 3rd or 9th depending on bracket path, so the finish has to be read.
 *
 * Names are batched into OR-ed requests (see fetchPlacements) rather than one
 * per tournament, which is what made the regional half affordable -- 57
 * tournaments is 6 requests of the 60/hour, not 57.
 *
 * Team names are matched through the same alias table the roster import uses,
 * because Liquipedia's naming and ours differ in small ways -- it writes
 * "Secret Whales" where we hold "Team Secret Whales".
 */
export async function ingestPlacements(pool: Pool): Promise<PlacementImportResult> {
  const tournaments = await pool.query<{ id: number; name: string }>(
    `SELECT id, name FROM tournaments ORDER BY date_start DESC`,
  );
  const teams = await pool.query<{ id: number; name: string }>('SELECT id, name FROM teams');

  // Matched on the Liquipedia-facing form of our name, so the alias table is
  // applied in the same direction the roster import uses it.
  const teamIdByName = new Map<string, number>();
  for (const team of teams.rows) {
    teamIdByName.set(ourNameToLiquipediaName(team.name).toLowerCase(), team.id);
    teamIdByName.set(team.name.toLowerCase(), team.id);
  }
  // Standings are historical, so a team appears under whatever name it used at
  // the time -- Movistar KOI placed at 2024 events as MAD Lions KOI. Same
  // problem match ingestion already solves, same map.
  for (const [historical, current] of Object.entries(HISTORICAL_LIQUIPEDIA_NAME_ALIASES)) {
    const teamId = teamIdByName.get(current.toLowerCase());
    if (teamId) teamIdByName.set(historical.toLowerCase(), teamId);
  }

  const unmatched = new Set<string>();
  let inserted = 0;

  // Every request first, then the write. A batched response carries rows for
  // several tournaments at once, so they have to be keyed back to ours by name.
  const tournamentIdByName = new Map(tournaments.rows.map((t) => [t.name.toLowerCase(), t.id]));
  const rows = await fetchPlacements(tournaments.rows.map((t) => t.name));

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM tournament_placements');

    for (const row of rows) {
      if (!isTeamStanding(row)) continue;

      const tournamentId = tournamentIdByName.get((row.tournament ?? '').toLowerCase());
      if (!tournamentId) continue;

      const teamId = teamIdByName.get((row.opponentname ?? '').toLowerCase());
      if (!teamId) {
        unmatched.add(row.opponentname);
        continue;
      }

      await client.query(
        `INSERT INTO tournament_placements (tournament_id, team_id, placement, placement_sort, prize_money)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tournament_id, team_id) DO UPDATE
           SET placement = EXCLUDED.placement,
               placement_sort = EXCLUDED.placement_sort,
               prize_money = EXCLUDED.prize_money`,
        [tournamentId, teamId, row.placement, placementSortValue(row.placement), row.prizemoney ?? null],
      );
      inserted += 1;
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }

  return {
    tournamentsProcessed: tournaments.rows.length,
    placementsInserted: inserted,
    unmatchedTeams: [...unmatched].sort(),
  };
}
