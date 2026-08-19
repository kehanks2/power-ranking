/** Manual one-off runner: backfill the LPL Split 3 gap (missing from the OE CSV) via Liquipedia. Run with tsx. */
import { createPool } from '../db.js';
import { ingestLiquipediaMatches } from '../liquipediaMatchIngest.js';

async function main() {
  const pool = createPool();
  // LPL Split 3 games from 2026-06-14 (where the OE CSV stopped) onward.
  const result = await ingestLiquipediaMatches(pool, '[[series::LoL Pro League]] AND [[date::>2026-06-14]]');
  console.log('Result:', JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error('Liquipedia match backfill failed:', err);
  process.exit(1);
});
