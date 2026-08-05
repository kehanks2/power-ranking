/**
 * Manual one-off runner: recompute ratings from already-ingested game data.
 * Run with tsx. Deliberately does NOT touch roster_memberships -- that's now
 * populated from Liquipedia (see manualLiquipediaRosterRun.ts), a separate,
 * deliberately-invoked step, not bundled into every ratings recompute (which
 * would mean hitting Liquipedia's rate-limited API on every routine run).
 * roster_memberships is a pure display table rating computation never reads
 * (see teamLineups.ts's comment) -- skipping it here doesn't affect ratings.
 */
import { createPool } from '../db.js';
import { computeRatings } from '../computeRatings.js';
import { computePlayerRatings, computeInternationalPlayerRatings } from '../computePlayerRatings.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

async function main() {
  const pool = createPool(DATABASE_URL);

  console.log('Computing player ratings (regional)...');
  const playerRatingRows = await computePlayerRatings(pool);
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
