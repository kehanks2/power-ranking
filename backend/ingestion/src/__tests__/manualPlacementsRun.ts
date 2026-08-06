/** Manual one-off runner: fill tournament_placements from Liquipedia. Run with tsx. */
import { createPool } from '../db.js';
import { ingestPlacements } from '../ingestPlacements.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

async function main() {
  const pool = createPool(DATABASE_URL);
  const result = await ingestPlacements(pool);
  console.log('Result:', JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error('Placement ingest failed:', err);
  process.exit(1);
});
