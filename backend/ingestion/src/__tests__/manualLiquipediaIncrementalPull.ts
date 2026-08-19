/**
 * Manual runner: pull every series over a bounded date window.
 *
 * The upper bound is the point -- an unbounded pull picks up matches from a
 * tournament still in progress, and a half-played weekend moves ratings on
 * evidence that isn't final. `end` is exclusive, so 2026-08-12 stops at the end
 * of 08-11.
 *
 * `start` defaults to the newest game we already hold. Liquipedia compares a
 * bare date as midnight, so that day's matches are re-pulled rather than
 * skipped; ingestion is idempotent, so re-pulling rewrites in place.
 *
 * Run with: tsx <this file> <YYYY-MM-DD end, exclusive> [YYYY-MM-DD start]
 */
import { createPool } from '../db.js';
import {
  ingestLiquipediaMatches,
  REGIONAL_SERIES_TO_LEAGUE_SLUG,
  INTERNATIONAL_SERIES,
  AMERICAS_SERIES,
} from '../liquipediaMatchIngest.js';

const [endDate, startArg] = process.argv.slice(2);

if (!endDate || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
  console.error('Usage: tsx manualLiquipediaIncrementalPull.ts <YYYY-MM-DD end, exclusive> [YYYY-MM-DD start]');
  process.exit(1);
}

const ALL_SERIES = [...Object.keys(REGIONAL_SERIES_TO_LEAGUE_SLUG), AMERICAS_SERIES, ...INTERNATIONAL_SERIES];

async function main() {
  const pool = createPool();
  const completed: string[] = [];

  const frontier = await pool.query<{ day: string | null }>(
    `SELECT max(datetime_utc)::date::text AS day FROM games`,
  );
  const startDate = startArg ?? frontier.rows[0]?.day;
  if (!startDate) {
    console.error('No games in the database and no start date given.');
    process.exit(1);
  }

  console.log(`Pulling ${ALL_SERIES.length} series over (${startDate}, ${endDate}), end exclusive.`);
  console.log(`Newest game currently held: ${frontier.rows[0]?.day ?? 'none'}\n`);

  let totalGames = 0;
  try {
    for (const series of ALL_SERIES) {
      const result = await ingestLiquipediaMatches(
        pool,
        `[[series::${series}]] AND [[date::>${startDate}]] AND [[date::<${endDate}]]`,
      );
      completed.push(series);
      totalGames += result.gamesProcessed;
      console.log(`${series}: ${result.seriesProcessed} series, ${result.gamesProcessed} games`);
      if (result.teamsUnresolved.length > 0) {
        console.log(`  unresolved teams: ${result.teamsUnresolved.join(', ')}`);
      }
    }
  } finally {
    console.log(`\nCompleted ${completed.length}/${ALL_SERIES.length} series, ${totalGames} games.`);
    const remaining = ALL_SERIES.filter((s) => !completed.includes(s));
    if (remaining.length > 0) console.log(`Remaining (re-run to resume): ${remaining.join(', ')}`);
    const after = await pool.query<{ day: string | null }>(`SELECT max(datetime_utc)::date::text AS day FROM games`);
    console.log(`Newest game now held: ${after.rows[0]?.day ?? 'none'}`);
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Liquipedia incremental pull failed:', err);
  process.exit(1);
});
