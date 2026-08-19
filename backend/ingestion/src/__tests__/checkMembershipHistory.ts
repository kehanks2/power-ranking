/**
 * Reports whether the membership tables can answer "which league was this team
 * in THEN", which the walk-forward sweeps depend on not needing.
 *
 * Both tables are current-state: every row is open-ended, so `end_date IS NULL`
 * selects everything and there is no history to be as-of against. That is
 * harmless only while the mapping is time-invariant -- no team has ever played
 * outside the league its membership row names, so reading it inside a
 * historical fold is future information carrying no information.
 *
 * The sweeps no longer read it for regional games (they take the league from
 * the tournament), but international events have no regional league of their
 * own and still fall back to it. This prints the numbers behind that.
 *
 * Run with: tsx --env-file=../../.env src/__tests__/checkMembershipHistory.ts
 */
import { createPool } from '../db.js';

async function main() {
  const pool = createPool();

  const shape = await pool.query<{ table: string; rows: string; closed: string; subjects: string; multi: string }>(`
    SELECT 'team_league_memberships' AS table,
           count(*)::text AS rows,
           count(*) FILTER (WHERE end_date IS NOT NULL)::text AS closed,
           count(DISTINCT team_id)::text AS subjects,
           (SELECT count(*)::text FROM (
              SELECT team_id FROM team_league_memberships GROUP BY team_id HAVING count(DISTINCT league_id) > 1
            ) x) AS multi
      FROM team_league_memberships
    UNION ALL
    SELECT 'roster_memberships',
           count(*)::text,
           count(*) FILTER (WHERE end_date IS NOT NULL)::text,
           count(DISTINCT player_id)::text,
           (SELECT count(*)::text FROM (
              SELECT player_id FROM roster_memberships GROUP BY player_id HAVING count(DISTINCT team_id) > 1
            ) x)
      FROM roster_memberships
  `);

  console.log('table                     rows  closed  subjects  in>1 group');
  for (const row of shape.rows) {
    console.log(
      `${row.table.padEnd(24)} ${row.rows.padStart(5)} ${row.closed.padStart(7)} ${row.subjects.padStart(9)} ${row.multi.padStart(11)}`,
    );
  }

  // The invariant the sweeps rely on: a team's played league never differs from
  // the one its membership names, so the current-state map is also the
  // historical one. Measured against tournaments, which are independent of it.
  const drift = await pool.query<{ pairs: string; mismatched: string; teams: string }>(`
    WITH played AS (
      SELECT DISTINCT pgp.team_id, t.canonical_league_id AS played_league
        FROM player_game_performance pgp
        JOIN games g ON g.id = pgp.game_id
        JOIN series s ON s.id = g.series_id
        JOIN tournaments t ON t.id = s.tournament_id
       WHERE t.canonical_league_id IS NOT NULL
    )
    SELECT count(*)::text AS pairs,
           count(*) FILTER (WHERE p.played_league <> tlm.league_id)::text AS mismatched,
           count(DISTINCT p.team_id) FILTER (WHERE p.played_league <> tlm.league_id)::text AS teams
      FROM played p JOIN team_league_memberships tlm ON tlm.team_id = p.team_id
  `);
  const { pairs, mismatched, teams } = drift.rows[0];
  console.log(`\nteam/played-league pairs: ${pairs}, mismatched: ${mismatched} across ${teams} teams`);

  if (Number(mismatched) > 0) {
    console.log(
      '\nA team has played outside its membership league. The current-state map is no\n' +
        'longer the historical one, so the international fallback in the sweeps is now a\n' +
        'real walk-forward leak and these tables need genuine history -- see issue #27.',
    );
  } else {
    console.log('\nMapping is time-invariant: reading it in a historical fold leaks nothing.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Membership history check failed:', err);
  process.exit(1);
});
