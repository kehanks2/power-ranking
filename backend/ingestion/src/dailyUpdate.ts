/**
 * Scheduled daily update: pull, then recompute.
 *
 * The pull deliberately reaches PAST today. It used to stop at "today,
 * exclusive" so a board could not be built on a part-played day, but boards no
 * longer advance on days at all -- a regional board waits for its whole stage
 * (see resolveBoardAdvance), which is the same protection at the granularity
 * that actually matters. That makes the old cutoff redundant, and reaching
 * forward is what makes stage completion knowable: "does this week still owe
 * fixtures" cannot be answered without the fixtures.
 *
 * Unplayed series arrive as Liquipedia's -1 to -1 rows, are stored with no
 * games, and move no rating. They exist so the cadence logic can see what is
 * still outstanding.
 *
 * The forward window is bounded rather than open-ended: opponents far out are
 * often placeholders that resolve to nothing, and every one of those is logged
 * as an unresolved team. Three weeks covers any real gap to a league's next
 * fixture without dragging in a whole split of TBDs.
 *
 * Safe to re-run, and safe to run early: ingestion upserts, unplayed games are
 * skipped rather than stored, and every rating table is rebuilt from the games
 * that result. Running before a day's play has finished now costs nothing --
 * the board holds until the stage does.
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
const FORWARD_DAYS = 21;

async function main() {
  const pool = createPool(DATABASE_URL);
  // UTC throughout: Liquipedia dates are UTC, and building this from a local
  // date reports the wrong day west of Greenwich.
  const cutoff = new Date(Date.now() + FORWARD_DAYS * 86_400_000).toISOString().slice(0, 10);

  const before = await pool.query<{ day: string | null }>(`SELECT max(datetime_utc)::date::text AS day FROM games`);
  const startDate = before.rows[0]?.day;
  if (!startDate) throw new Error('No games held; run a backfill before scheduling daily updates.');

  console.log(`[${new Date().toISOString()}] pulling (${startDate}, ${cutoff}), end exclusive, ${FORWARD_DAYS}d ahead`);

  let games = 0;
  let incomplete = 0;
  const failed: string[] = [];
  for (const series of ALL_SERIES) {
    try {
      const result = await ingestLiquipediaMatches(
        pool,
        `[[series::${series}]] AND [[date::>${startDate}]] AND [[date::<${cutoff}]]`,
      );
      games += result.gamesProcessed;
      incomplete += result.gamesSkippedIncomplete;
      if (result.gamesProcessed > 0 || result.gamesSkippedIncomplete > 0) {
        const waiting = result.gamesSkippedIncomplete > 0 ? `, ${result.gamesSkippedIncomplete} awaiting stat lines` : '';
        console.log(`  ${series}: ${result.gamesProcessed} games${waiting}`);
      }
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
  console.log(
    `[${new Date().toISOString()}] ${games} games ingested` +
      (incomplete > 0 ? `, ${incomplete} held back for missing stat lines` : '') +
      '; recomputing',
  );
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
