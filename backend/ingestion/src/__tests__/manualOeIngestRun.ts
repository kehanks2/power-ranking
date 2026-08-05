/** Manual one-off runner: ingest one or more downloaded Oracle's Elixir CSVs, then compute ratings. Run with tsx. */
import { readFileSync } from 'node:fs';
import { createPool } from '../db.js';
import { ingestOracleElixirCsv, ingestInternationalOeCsv } from '../oracleElixirCsv.js';
import { computeRatings } from '../computeRatings.js';
import { computePlayerRatings } from '../computePlayerRatings.js';
import type { LeagueAlias } from '../leagueAlias.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const csvPaths = process.argv.slice(2);
if (csvPaths.length === 0) {
  console.error('Usage: tsx manualOeIngestRun.ts <path-to-csv> [<path-to-csv> ...]');
  process.exit(1);
}

async function main() {
  const pool = createPool(DATABASE_URL);
  // Load the REAL seeded league_aliases table (raw name -> canonical, date-ranged),
  // not a reconstructed identity-only list -- that was a latent bug: the LTA N/S
  // remap was seeded in the DB but never actually consulted by this script.
  // pg returns DATE columns as real Date objects, not strings -- resolveLeagueAlias
  // normalizes internally now, but typing this accurately avoids re-introducing
  // the bug that normalization was built to fix.
  const aliasesResult = await pool.query<{
    raw_league_name: string;
    canonical_league_id: number;
    valid_from: Date;
    valid_to: Date | null;
  }>('SELECT raw_league_name, canonical_league_id, valid_from, valid_to FROM league_aliases');
  const aliases: LeagueAlias[] = aliasesResult.rows.map((row) => ({
    rawLeagueName: row.raw_league_name,
    canonicalLeagueId: row.canonical_league_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
  }));

  for (const csvPath of csvPaths) {
    console.log(`Reading ${csvPath}...`);
    const csvText = readFileSync(csvPath, 'utf8');

    console.log('Ingesting regional-split games...');
    const ingestResult = await ingestOracleElixirCsv(pool, csvText, aliases);
    console.log('Ingest result:', JSON.stringify(ingestResult, null, 2));

    console.log('Ingesting international games...');
    const intlResult = await ingestInternationalOeCsv(pool, csvText, aliases);
    console.log('International ingest result:', JSON.stringify(intlResult, null, 2));
  }

  // Deliberately does NOT populate roster_memberships. That table is owned by
  // populateRosterFromLiquipedia (manualLiquipediaRosterRun.ts) and nothing
  // else. It used to call the OE-lineup-derived populateRosterMemberships
  // here, and since BOTH functions start with `DELETE FROM
  // roster_memberships`, whichever ran last silently won -- so every OE ingest
  // reverted the Liquipedia rosters and the display regressed to the old
  // heuristic's output (Cloud9 wrong, Shopify Rebellion missing their support
  // entirely, Dignitas still listing a dropped player). Rosters are Liquipedia's
  // job now; run manualLiquipediaRosterRun.ts to refresh them.

  // Must run before computeRatings: roster-change decay now uses real
  // player-implied priors from player_ratings_history.
  console.log('Computing player ratings...');
  const playerRatingRows = await computePlayerRatings(pool);
  console.log('Player rating rows:', playerRatingRows);

  console.log('Computing team/league ratings...');
  const ratingResult = await computeRatings(pool);
  console.log('Rating result:', JSON.stringify(ratingResult, null, 2));

  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM tournaments) AS tournaments,
      (SELECT COUNT(*) FROM teams) AS teams,
      (SELECT COUNT(*) FROM series) AS series,
      (SELECT COUNT(*) FROM games) AS games,
      (SELECT COUNT(*) FROM game_lineups) AS game_lineups,
      (SELECT COUNT(*) FROM players) AS players,
      (SELECT COUNT(*) FROM player_game_performance) AS player_game_performance,
      (SELECT COUNT(*) FROM roster_memberships) AS roster_memberships,
      (SELECT COUNT(*) FROM player_ratings_history) AS player_ratings_history
  `);
  console.log('DB counts:', counts.rows[0]);

  await pool.end();
}

main().catch((err) => {
  console.error('Manual OE ingest run failed:', err);
  process.exit(1);
});
