import type { Pool } from 'pg';

/**
 * Test helper: snapshot and restore the whole `roster_memberships` table.
 *
 * Needed because these integration tests run against the LIVE dev database
 * and exercise `populateRosterMemberships`, which begins with an unscoped
 * `DELETE FROM roster_memberships` and then rebuilds rows for EVERY team from
 * OE lineup data -- not just the synthetic team under test. Without this,
 * simply running the test suite silently replaced the real Liquipedia-sourced
 * rosters with the deprecated heuristic's output, which is exactly the
 * regression the Liquipedia populator was introduced to fix (Cloud9 wrong,
 * Shopify Rebellion missing their support, Dignitas listing a dropped player).
 *
 * Deleting `populateRosterMemberships` and these tests removes the need for
 * this entirely -- nothing in production calls it any more.
 */
export interface RosterMembershipRow {
  team_id: number;
  player_id: number;
  role: string;
  is_starter: boolean;
  start_date: string;
  end_date: string | null;
}

export async function snapshotRosterMemberships(pool: Pool): Promise<RosterMembershipRow[]> {
  const result = await pool.query<RosterMembershipRow>(
    `SELECT team_id, player_id, role, is_starter, start_date, end_date FROM roster_memberships`,
  );
  return result.rows;
}

export async function restoreRosterMemberships(pool: Pool, rows: RosterMembershipRow[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM roster_memberships');
    for (const row of rows) {
      await client.query(
        `INSERT INTO roster_memberships (team_id, player_id, role, is_starter, start_date, end_date)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [row.team_id, row.player_id, row.role, row.is_starter, row.start_date, row.end_date],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
