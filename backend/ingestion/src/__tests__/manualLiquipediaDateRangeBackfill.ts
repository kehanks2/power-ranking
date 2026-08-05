/** Manual one-off runner: backfill one league over an explicit date range via Liquipedia. Run with tsx <this file> <SeriesName> <StartDate> <EndDate>. */
import { createPool } from '../db.js';
import { ingestLiquipediaMatches } from '../liquipediaMatchIngest.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const [seriesName, startDate, endDate] = process.argv.slice(2);
if (!seriesName || !startDate || !endDate) {
  console.error('Usage: tsx manualLiquipediaDateRangeBackfill.ts "<SeriesName>" <YYYY-MM-DD start> <YYYY-MM-DD end>');
  process.exit(1);
}

async function main() {
  const pool = createPool(DATABASE_URL);
  const result = await ingestLiquipediaMatches(pool, `[[series::${seriesName}]] AND [[date::>${startDate}]] AND [[date::<${endDate}]]`);
  console.log('Result:', JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error('Liquipedia date-range backfill failed:', err);
  process.exit(1);
});
