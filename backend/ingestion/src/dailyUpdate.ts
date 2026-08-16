/**
 * Scheduled daily update: pull complete Liquipedia dates, then recompute.
 *
 * Runs at 14:00 UTC. Liquipedia dates a series by its start, so the cutoff is
 * simply "today, exclusive" -- whole dates only. Anything still being played
 * carries today's date, is skipped, and arrives on the next run.
 *
 * Why 14:00: a date's last series finishes at most 02:15 UTC the next day
 * (measured over 138 play days), and results were observed appearing 3-6 hours
 * after a match ends. 14:00 clears the worst case by ~12 hours.
 *
 * Safe to re-run: ingestion upserts, unplayed games are skipped rather than
 * stored, and every rating table is rebuilt from the games that result.
 */
import { createPool } from './db.js';
import {
  ingestLiquipediaMatches,
  REGIONAL_SERIES_TO_LEAGUE_SLUG,
  INTERNATIONAL_SERIES,
  AMERICAS_SERIES,
} from './liquipediaMatchIngest.js';
import { computeRatings } from './computeRatings.js';
import { computeAllPlayerRatingWindows, computeInternationalPlayerRatings } from './computePlayerRatings.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const ALL_SERIES = [...Object.keys(REGIONAL_SERIES_TO_LEAGUE_SLUG), AMERICAS_SERIES, ...INTERNATIONAL_SERIES];

async function main() {
  const pool = createPool(DATABASE_URL);
  const cutoff = new Date().toISOString().slice(0, 10);

  const before = await pool.query<{ day: string | null }>(`SELECT max(datetime_utc)::date::text AS day FROM games`);
  const startDate = before.rows[0]?.day;
  if (!startDate) throw new Error('No games held; run a backfill before scheduling daily updates.');

  console.log(`[${new Date().toISOString()}] pulling (${startDate}, ${cutoff}), end exclusive`);

  let games = 0;
  const failed: string[] = [];
  for (const series of ALL_SERIES) {
    try {
      const result = await ingestLiquipediaMatches(
        pool,
        `[[series::${series}]] AND [[date::>${startDate}]] AND [[date::<${cutoff}]]`,
      );
      games += result.gamesProcessed;
      if (result.gamesProcessed > 0) console.log(`  ${series}: ${result.gamesProcessed} games`);
      if (result.teamsUnresolved.length > 0) console.log(`  ${series} unresolved: ${result.teamsUnresolved.join(', ')}`);
    } catch (err) {
      // One series failing (rate limit, a page moving) must not cost the rest;
      // ingestion is idempotent, so the next run picks up whatever was missed.
      failed.push(series);
      console.error(`  ${series} FAILED: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Ratings are rebuilt even when nothing new arrived: the carets read the
  // newest generation, and skipping the recompute would leave them a day stale.
  console.log(`[${new Date().toISOString()}] ${games} games ingested; recomputing`);
  await computeAllPlayerRatingWindows(pool);
  await computeInternationalPlayerRatings(pool);
  const ratings = await computeRatings(pool);

  const after = await pool.query<{ day: string | null }>(`SELECT max(datetime_utc)::date::text AS day FROM games`);
  console.log(
    `[${new Date().toISOString()}] done. newest game ${after.rows[0]?.day}, ` +
      `${ratings.teamRows} team rows, ${ratings.internationalRows} international`,
  );
  if (failed.length > 0) console.log(`series to retry next run: ${failed.join(', ')}`);

  await pool.end();
  // Non-zero so a scheduler surfaces a partial pull rather than reporting success.
  if (failed.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Daily update failed:', err);
  process.exit(1);
});
