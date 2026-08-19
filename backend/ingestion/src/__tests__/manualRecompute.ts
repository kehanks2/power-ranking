/**
 * Manual runner: recompute ratings from already-ingested game data. Does NOT
 * touch roster_memberships -- that's a display-only table populated separately
 * from Liquipedia's rate-limited API (manualLiquipediaRosterRun.ts), and rating
 * computation never reads it, so skipping it here changes nothing.
 */
import { createPool } from '../db.js';
import { computeRatings } from '../computeRatings.js';
import { computeAllPlayerRatingWindows, computeInternationalPlayerRatings } from '../computePlayerRatings.js';

async function main() {
  const pool = createPool();

  // All three regional windows: all-time, this calendar year, this split.
  console.log('Computing player ratings (regional, all windows)...');
  const playerRatingRows = await computeAllPlayerRatingWindows(pool);
  console.log('Regional player rating rows:', playerRatingRows);

  // Independent of the regional pass -- different games, different peer pool,
  // its own scope in the table. Powers the Global tab.
  console.log('Computing player ratings (international)...');
  const intlRatingRows = await computeInternationalPlayerRatings(pool);
  console.log('International player rating rows:', intlRatingRows);

  console.log('Computing team/league ratings...');
  const ratingResult = await computeRatings(pool);
  console.log('Rating result:', JSON.stringify(ratingResult, null, 2));

  const counts = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM team_ratings_history) AS team_ratings_history,
      (SELECT COUNT(*) FROM league_ratings_history) AS league_ratings_history,
      (SELECT COUNT(*) FROM roster_memberships) AS roster_memberships,
      (SELECT COUNT(*) FROM player_ratings_history) AS player_ratings_history
  `);
  console.log('DB counts:', counts.rows[0]);

  await pool.end();
}

main().catch((err) => {
  console.error('Manual recompute failed:', err);
  process.exit(1);
});
