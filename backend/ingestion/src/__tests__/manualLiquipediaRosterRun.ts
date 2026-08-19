/** Manual one-off runner: replace roster_memberships with Liquipedia squad data. Run with tsx. */
import { createPool } from '../db.js';
import { populateRosterFromLiquipedia } from '../populateRosterFromLiquipedia.js';

async function main() {
  const pool = createPool();
  const result = await populateRosterFromLiquipedia(pool);
  console.log('Result:', JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error('Liquipedia roster run failed:', err);
  process.exit(1);
});
