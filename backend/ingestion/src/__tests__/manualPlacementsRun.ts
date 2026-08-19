/** Manual one-off runner: fill tournament_placements from Liquipedia. Run with tsx. */
import { createPool } from '../db.js';
import { ingestPlacements } from '../ingestPlacements.js';

async function main() {
  const pool = createPool();
  const result = await ingestPlacements(pool);
  console.log('Result:', JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error('Placement ingest failed:', err);
  process.exit(1);
});
