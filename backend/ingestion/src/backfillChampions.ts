/**
 * Fills `player_game_performance.champion` and `game_bans` for games already
 * held, without touching anything else.
 *
 * Deliberately NOT a re-run of ingestLiquipediaMatches over the window: that
 * would re-upsert games, series and every stat line, so any correction
 * Liquipedia has made since would silently move ratings. This writes the two
 * draft columns and nothing more, so it can be re-run at any time and a
 * recompute is never owed.
 *
 * Games are matched on `leaguepedia_unique_line`, picks on (game, team, role) --
 * the same slot ingestion keyed them by, so no player identity is re-resolved.
 *
 *   npx tsx --env-file=../../.env src/backfillChampions.ts 2025-01-01 2027-01-01
 */

import pg from 'pg';
import type { Pool } from 'pg';
import { fetchMatches, bansFromExtradata } from './liquipediaApi.js';
import { resolvePosition } from './liquipediaMappings.js';
import { bulkInsert, dedupeByKey } from './bulkInsert.js';
import { ALL_SERIES } from './dailyUpdate.js';
import { SERIES_EXTRA_CONDITIONS } from './liquipediaMatchIngest.js';

interface Pick {
  uniqueLine: string;
  teamIndex: 0 | 1;
  role: string;
  champion: string;
}

interface Ban {
  uniqueLine: string;
  teamIndex: 0 | 1;
  banOrder: number;
  champion: string;
}

export function collectDraft(matches: Awaited<ReturnType<typeof fetchMatches>>): { picks: Pick[]; bans: Ban[] } {
  const picks: Pick[] = [];
  const bans: Ban[] = [];
  for (const match of matches) {
    for (const game of match.match2games ?? []) {
      const uniqueLine = `liquipedia:${match.match2id}_${game.match2gameid}`;
      for (const [teamIndex, opponent] of (game.opponents ?? []).entries()) {
        for (const player of opponent.players ?? []) {
          const role = resolvePosition(player.role);
          if (!role || !player.character) continue;
          picks.push({ uniqueLine, teamIndex: teamIndex === 0 ? 0 : 1, role, champion: player.character });
        }
      }
      for (const ban of bansFromExtradata(game.extradata)) {
        bans.push({ uniqueLine, teamIndex: ban.teamIndex, banOrder: ban.order, champion: ban.champion });
      }
    }
  }
  return { picks, bans };
}

/**
 * A pool must NOT be held across the API paging between series: minutes pass
 * with no query, the host drops the idle connections while `pg` still believes
 * they are live, and every client in the pool then fails -- a retry on the same
 * pool just draws another dead one. Each attempt therefore builds its own pool
 * and discards it. The host also drops live connections mid-write under load
 * (the free plan has very little headroom), so attempts are retried; every write
 * here is idempotent, which is what makes that safe.
 */
async function withFreshPool<T>(run: (pool: Pool) => Promise<T>): Promise<T> {
  const attempts = 4;
  for (let attempt = 1; ; attempt += 1) {
    // One connection, not the shared pool's four: this script is strictly
    // sequential, and the free plan's 20 slots are mostly background workers.
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    try {
      return await run(pool);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= attempts || !/Connection terminated|ECONNRESET|socket hang up|timeout/i.test(message)) throw err;
      console.warn(`  ${message}; retrying (${attempt}/${attempts - 1})`);
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    } finally {
      await pool.end().catch(() => {});
    }
  }
}

/**
 * Small batches with a breath between them. A two-year backfill in full-sized
 * statements repeatedly took the free-plan instance offline mid-write -- not a
 * parameter or size limit (10k-row statements succeed in isolation) but
 * sustained write pressure on an instance with very little CPU. Pacing costs a
 * couple of minutes across the whole run and is the difference between it
 * finishing and it killing the database.
 */
const WRITE_BATCH = 200;
const WRITE_PAUSE_MS = 400;

async function paced<T>(rows: readonly T[], run: (slice: T[]) => Promise<void>): Promise<void> {
  for (let start = 0; start < rows.length; start += WRITE_BATCH) {
    await run(rows.slice(start, start + WRITE_BATCH));
    if (start + WRITE_BATCH < rows.length) await new Promise((resolve) => setTimeout(resolve, WRITE_PAUSE_MS));
  }
}

async function writeDraft(pool: Pool, picks: Pick[], bans: Ban[]): Promise<{ picks: number; bans: number }> {
  const lines = [...new Set([...picks, ...bans].map((row) => row.uniqueLine))];
  if (lines.length === 0) return { picks: 0, bans: 0 };

  const held = await pool.query<{ id: number; line: string; team1: number; team2: number }>(
    `SELECT id, leaguepedia_unique_line AS line, team1_id AS team1, team2_id AS team2
       FROM games WHERE leaguepedia_unique_line = ANY($1::text[])`,
    [lines],
  );
  const byLine = new Map(held.rows.map((row) => [row.line, row]));

  const pickRows = picks.flatMap((pick) => {
    const game = byLine.get(pick.uniqueLine);
    if (!game) return [];
    return [[game.id, pick.teamIndex === 0 ? game.team1 : game.team2, pick.role, pick.champion] as const];
  });

  let picksWritten = 0;
  await paced(pickRows, async (slice) => {
    const updated = await pool.query(
      `UPDATE player_game_performance p
          SET champion = d.champion
         FROM unnest($1::int[], $2::int[], $3::text[], $4::text[]) AS d(game_id, team_id, role, champion)
        WHERE p.game_id = d.game_id AND p.team_id = d.team_id AND p.role = d.role
          AND p.champion IS DISTINCT FROM d.champion`,
      [slice.map((r) => r[0]), slice.map((r) => r[1]), slice.map((r) => r[2]), slice.map((r) => r[3])],
    );
    picksWritten += updated.rowCount ?? 0;
  });

  // Games whose bans are already stored are skipped outright, so a run
  // interrupted mid-way resumes instead of rewriting everything it already did.
  // The host drops connections under sustained write load, which makes cheap
  // re-runs the difference between finishing and not.
  const alreadyBanned = await pool.query<{ game_id: number }>(
    'SELECT DISTINCT game_id FROM game_bans WHERE game_id = ANY($1::int[])',
    [[...byLine.values()].map((game) => game.id)],
  );
  const haveBans = new Set(alreadyBanned.rows.map((row) => row.game_id));

  const banRows = dedupeByKey(
    bans.flatMap((ban) => {
      const game = byLine.get(ban.uniqueLine);
      if (!game || haveBans.has(game.id)) return [];
      return [{ gameId: game.id, teamId: ban.teamIndex === 0 ? game.team1 : game.team2, order: ban.banOrder, champion: ban.champion }];
    }),
    (row) => `${row.gameId}:${row.teamId}:${row.order}`,
  );
  let bansWritten = 0;
  await paced(banRows, async (slice) => {
    bansWritten += await bulkInsert(
      pool,
      'game_bans',
      ['game_id', 'team_id', 'ban_order', 'champion'],
      slice.map((row) => [row.gameId, row.teamId, row.order, row.champion]),
      'ON CONFLICT (game_id, team_id, ban_order) DO UPDATE SET champion = EXCLUDED.champion',
    );
  });

  return { picks: picksWritten, bans: bansWritten };
}

async function main(): Promise<void> {
  const [from, to, only] = process.argv.slice(2);
  if (!from || !to) {
    throw new Error('usage: backfillChampions.ts <from YYYY-MM-DD> <to YYYY-MM-DD> [series substring]');
  }

  // The host tends to drop the connection before a full two-year pass finishes,
  // and a bare re-run re-fetches all ten series to discover it has nothing to
  // do -- ten requests of a 40/hour budget. Naming one series resumes it for the
  // cost of one.
  const wanted = only
    ? ALL_SERIES.filter((series) => series.toLowerCase().includes(only.toLowerCase()))
    : ALL_SERIES;
  if (wanted.length === 0) throw new Error(`no series matches "${only}": ${ALL_SERIES.join(', ')}`);

  let totalPicks = 0;
  let totalBans = 0;
  for (const series of wanted) {
    const extra = SERIES_EXTRA_CONDITIONS[series];
    const matches = await fetchMatches(
      `[[series::${series}]] AND [[date::>${from}]] AND [[date::<${to}]]` + (extra ? ` AND ${extra}` : ''),
    );
    const { picks, bans } = collectDraft(matches);
    const written = await withFreshPool((pool) => writeDraft(pool, picks, bans));
    totalPicks += written.picks;
    totalBans += written.bans;
    // "changed", not "seen": the pick update skips rows already holding the
    // right champion, so a re-run reporting 0 means agreement, not a miss.
    console.log(
      `  ${series}: ${matches.length} series, ${picks.length} picks seen (${written.picks} changed), ${bans.length} bans seen`,
    );
  }
  console.log(`${totalPicks} picks and ${totalBans} bans written`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('backfillChampions.ts')) {
  await main();
}
