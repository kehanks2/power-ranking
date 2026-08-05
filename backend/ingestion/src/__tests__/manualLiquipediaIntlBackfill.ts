/** Manual one-off runner: backfill First Stand 2026 via Liquipedia (tests the international classification path). Run with tsx. */
import { createPool } from '../db.js';
import { ingestLiquipediaMatches } from '../liquipediaMatchIngest.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

async function main() {
  const pool = createPool(DATABASE_URL);
  const result = await ingestLiquipediaMatches(pool, '[[series::First Stand Tournament]] AND [[date::>2026-01-01]]');
  console.log('Result:', JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error('Liquipedia international backfill failed:', err);
  process.exit(1);
});
