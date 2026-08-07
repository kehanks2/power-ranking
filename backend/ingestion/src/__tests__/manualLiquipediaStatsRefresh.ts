/**
 * Manual runner: re-pull every Riot-official series in one pass to populate
 * columns added after the original backfill (written for migration 0007's
 * creep_score/gold_diff, which left 54,796 rows null). Ingestion is idempotent,
 * so this rewrites in place and picks up newer matches as a side effect. A run
 * that dies partway is safe to re-run once the rate-limit window reopens.
 *
 * Run with: tsx <this file> [YYYY-MM-DD start, default 2024-01-01]
 */
import { createPool } from '../db.js';
import {
  ingestLiquipediaMatches,
  REGIONAL_SERIES_TO_LEAGUE_SLUG,
  INTERNATIONAL_SERIES,
  AMERICAS_SERIES,
} from '../liquipediaMatchIngest.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const startDate = process.argv[2] ?? '2024-01-01';

const ALL_SERIES = [...Object.keys(REGIONAL_SERIES_TO_LEAGUE_SLUG), AMERICAS_SERIES, ...INTERNATIONAL_SERIES];

async function main() {
  const pool = createPool(DATABASE_URL);
  const completed: string[] = [];

  try {
    for (const series of ALL_SERIES) {
      const result = await ingestLiquipediaMatches(pool, `[[series::${series}]] AND [[date::>${startDate}]]`);
      completed.push(series);
      console.log(`${series}: ${result.seriesProcessed} series, ${result.gamesProcessed} games`);
      if (result.teamsUnresolved.length > 0) {
        console.log(`  unresolved teams: ${result.teamsUnresolved.join(', ')}`);
      }
    }
  } finally {
    console.log(`\nCompleted ${completed.length}/${ALL_SERIES.length} series.`);
    const remaining = ALL_SERIES.filter((s) => !completed.includes(s));
    if (remaining.length > 0) console.log(`Remaining (re-run to resume): ${remaining.join(', ')}`);
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Liquipedia stats refresh failed:', err);
  process.exit(1);
});
