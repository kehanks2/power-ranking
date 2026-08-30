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
import { pathToFileURL } from 'node:url';
import { createPool } from './db.js';
import {
  ingestLiquipediaMatches,
  REGIONAL_SERIES_TO_LEAGUE_SLUG,
  INTERNATIONAL_SERIES,
  AMERICAS_SERIES,
} from './liquipediaMatchIngest.js';
import { computeRatings } from './computeRatings.js';
import { refreshStatlessGames } from './refreshStatlessGames.js';
import { computeAllPlayerRatingWindows, computeInternationalPlayerRatings } from './computePlayerRatings.js';

export const ALL_SERIES = [...Object.keys(REGIONAL_SERIES_TO_LEAGUE_SLUG), AMERICAS_SERIES, ...INTERNATIONAL_SERIES];
const FORWARD_DAYS = 21;
const MAX_LOOKBACK_DAYS = 14;

const shiftDays = (day: string, delta: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86_400_000).toISOString().slice(0, 10);

/**
 * Where the pull starts.
 *
 * Not simply the newest game held. A game held back for its stat lines does not
 * advance that frontier, but ANOTHER league playing the same day does -- so the
 * held-back game falls out of the window before its grace expires, and nothing
 * ever asks for it again. That stranded 13 games across five LCS and LPL series
 * on 2026-08-16: LEC played the 17th, the frontier moved past them, and both of
 * the 18th's runs queried `date::>2026-08-17`.
 *
 * So the window also covers the oldest decided series still missing its games.
 * That set is self-clearing -- past STATS_GRACE_DAYS a result is ingested with
 * or without stat lines -- but a series whose games Liquipedia later withdraws
 * would pin the window open forever, hence the floor.
 *
 * The extra day is for the boundary: `[[date::>S]]` matches times after
 * midnight on S, so a match timed exactly 00:00:00 needs the day before it.
 */
export function resolvePullStart(frontier: string, oldestPending: string | null): string {
  const floor = shiftDays(frontier, -MAX_LOOKBACK_DAYS);
  let start = frontier;
  if (oldestPending && oldestPending < start) start = oldestPending;
  if (start < floor) start = floor;
  return shiftDays(start, -1);
}

/**
 * Whether a run should report failure.
 *
 * Only a total blackout does. A partial pull self-heals: `resolvePullStart`
 * reaches back from the oldest decided series still missing its games, so the
 * next run asks for everything this one missed -- which is exactly what
 * recovered the 429 on 2026-08-26. Failing on a partial made the only alarm
 * this job has, a red run in the Actions list, mean "no action needed" most of
 * the time, and an alarm nobody opens is not an alarm.
 */
export function isTotalPullFailure(failed: readonly string[], attempted: readonly string[]): boolean {
  return attempted.length > 0 && failed.length === attempted.length;
}

async function main() {
  const pool = createPool();
  // UTC throughout: Liquipedia dates are UTC, and building this from a local
  // date reports the wrong day west of Greenwich.
  const cutoff = new Date(Date.now() + FORWARD_DAYS * 86_400_000).toISOString().slice(0, 10);

  const before = await pool.query<{ frontier: string | null; pending: string | null; pendingCount: string }>(
    `WITH pending AS (
       SELECT s.date_utc::date::text AS day
         FROM series s
        WHERE s.winner_team_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM games g WHERE g.series_id = s.id)
     )
     SELECT (SELECT max(datetime_utc)::date::text FROM games) AS frontier,
            (SELECT min(day) FROM pending) AS pending,
            (SELECT count(*)::text FROM pending) AS "pendingCount"`,
  );
  const frontier = before.rows[0]?.frontier;
  if (!frontier) throw new Error('No games held; run a backfill before scheduling daily updates.');
  const { pending, pendingCount } = before.rows[0];
  const startDate = resolvePullStart(frontier, pending);

  console.log(`[${new Date().toISOString()}] pulling (${startDate}, ${cutoff}), end exclusive, ${FORWARD_DAYS}d ahead`);
  if (pending) console.log(`  reaching back to ${pending}: ${pendingCount} decided series still missing their games`);

  let games = 0;
  let incomplete = 0;
  let withoutStats = 0;
  const failed: string[] = [];
  for (const series of ALL_SERIES) {
    try {
      const result = await ingestLiquipediaMatches(
        pool,
        `[[series::${series}]] AND [[date::>${startDate}]] AND [[date::<${cutoff}]]`,
      );
      games += result.gamesProcessed;
      incomplete += result.gamesSkippedIncomplete;
      withoutStats += result.gamesIngestedWithoutStats;
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

  // Report the ones taken WITHOUT stats, not just the ones held back. Past
  // STATS_GRACE_DAYS a result is ingested regardless, counting toward team
  // ratings and contributing nothing to player ratings.
  console.log(
    `[${new Date().toISOString()}] ${games} games ingested` +
      (withoutStats > 0 ? `, ${withoutStats} WITHOUT stat lines (player ratings miss these)` : '') +
      (incomplete > 0 ? `, ${incomplete} held back for missing stat lines` : ''),
  );

  // Before the recompute, so anything recovered lands in this run's ratings.
  try {
    const refreshed = await refreshStatlessGames(pool);
    if (refreshed.candidates > 0) {
      const plural = refreshed.requests === 1 ? 'request' : 'requests';
      console.log(
        `  re-asked ${refreshed.candidates} series holding statless games in ${refreshed.requests} ${plural}: ` +
          `${refreshed.gamesGainedStats} games gained stat lines`,
      );
    }
  } catch (err) {
    // A best-effort catch-up must never cost the run its recompute.
    console.error(`  statless refresh FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Ratings are rebuilt even when nothing new arrived: the carets read the
  // newest generation, and skipping the recompute would leave them a day stale.
  console.log(`[${new Date().toISOString()}] recomputing`);
  await computeAllPlayerRatingWindows(pool);
  await computeInternationalPlayerRatings(pool);
  const ratings = await computeRatings(pool);

  const after = await pool.query<{ day: string | null }>(`SELECT max(datetime_utc)::date::text AS day FROM games`);
  console.log(
    `[${new Date().toISOString()}] done. newest game ${after.rows[0]?.day}, ` +
      `${ratings.teamRows} team rows, ${ratings.internationalRows} international`,
  );
  if (failed.length > 0) {
    const blackout = isTotalPullFailure(failed, ALL_SERIES) ? 'EVERY series failed; ' : '';
    console.log(`${blackout}series to retry next run: ${failed.join(', ')}`);
  }

  await pool.end();
  if (isTotalPullFailure(failed, ALL_SERIES)) process.exitCode = 1;
}

// Guarded so importing resolvePullStart does not run a pull.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Daily update failed:', err);
    process.exit(1);
  });
}
