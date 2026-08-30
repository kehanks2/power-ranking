/**
 * Manual one-off runner: refresh roster_memberships and team crests from
 * Liquipedia. Run with tsx.
 *
 * Rosters are not display-only -- computeRatings seeds a team's international
 * rating from them -- so follow this with a recompute (manualRecompute.ts).
 */
import { createPool } from '../db.js';
import { populateRosterFromLiquipedia } from '../populateRosterFromLiquipedia.js';
import { fetchTeamLogos } from '../fetchTeamLogos.js';

async function main() {
  const pool = createPool();
  const result = await populateRosterFromLiquipedia(pool);
  console.log('Result:', JSON.stringify(result, null, 2));

  // After the roster import, which is what refreshes logo_url.
  const logos = await fetchTeamLogos(pool);
  console.log('Logos:', JSON.stringify(logos, null, 2));
  await pool.end();
}

main().catch((err) => {
  console.error('Liquipedia roster run failed:', err);
  process.exit(1);
});
