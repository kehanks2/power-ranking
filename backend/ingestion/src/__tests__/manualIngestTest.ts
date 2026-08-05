/**
 * Manual, one-off validation script (not part of the automated test suite) --
 * pulls one small recent window of real LCS data end-to-end to validate the
 * orchestrator against live Leaguepedia data before committing to a full
 * multi-league backfill. Run directly with tsx, not vitest.
 */
import { createPool } from '../db.js';
import { ingestLeagueTournaments } from '../orchestrator.js';
import type { LeagueAlias } from '../leagueAlias.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

async function main() {
  const pool = createPool(DATABASE_URL);
  const leaguesResult = await pool.query<{ slug: string; id: number }>('SELECT slug, id FROM leagues');
  const aliases: LeagueAlias[] = leaguesResult.rows.map((row) => ({
    rawLeagueName: row.slug,
    canonicalLeagueId: row.id,
    validFrom: '2010-01-01',
    validTo: null,
  }));

  console.log('Starting live LCS ingestion test (recent tournaments only)...');
  const result = await ingestLeagueTournaments(pool, 'LCS', aliases, { sinceDate: '2026-06-01' });
  console.log('Result:', JSON.stringify(result, null, 2));

  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM tournaments) AS tournaments,
      (SELECT COUNT(*) FROM teams) AS teams,
      (SELECT COUNT(*) FROM series) AS series,
      (SELECT COUNT(*) FROM games) AS games,
      (SELECT COUNT(*) FROM game_lineups) AS game_lineups,
      (SELECT COUNT(*) FROM players) AS players
  `);
  console.log('DB counts:', counts.rows[0]);

  await pool.end();
}

main().catch((err) => {
  console.error('Manual ingest test failed:', err);
  process.exit(1);
});
