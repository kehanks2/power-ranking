/** Manual one-off runner: full historical backfill for one league via Liquipedia. Run with tsx <this file> <SeriesName> <StartDate>. */
import { createPool } from '../db.js';
import { ingestLiquipediaMatches } from '../liquipediaMatchIngest.js';

const [seriesName, startDate] = process.argv.slice(2);
if (!seriesName || !startDate) {
  console.error('Usage: tsx manualLiquipediaFullLeagueBackfill.ts "<SeriesName>" <YYYY-MM-DD>');
  process.exit(1);
}

async function main() {
  const pool = createPool();
  const result = await ingestLiquipediaMatches(pool, `[[series::${seriesName}]] AND [[date::>${startDate}]]`);
  console.log('Result:', JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error('Liquipedia full league backfill failed:', err);
  process.exit(1);
});
