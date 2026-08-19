/**
 * Read-only diagnostic: how far forward each regional board may read, and why.
 * Writes nothing.
 *
 *   npx tsx --env-file=../../.env src/__tests__/checkBoardAdvance.ts
 *
 * `holding` is the normal state mid-week -- the board is pinned to the last
 * completed stage while the current one still owes fixtures. `stage-stalled`
 * means the fail-safe released a week that went quiet, which is worth looking
 * at: it usually means a postponed match or a fixture that will never happen.
 */
import { createPool } from '../db.js';
import { resolveBoardAdvance, stageKind, STAGE_STATUS_SQL, type StageStatus } from '@power-ranking/shared';

const pool = createPool();

const { rows } = await pool.query<{
  league_id: number;
  bracket_id: string | null;
  stage_name: string | null;
  last_played_day: string | null;
  previous_played_day: string | null;
  unplayed_series: string;
  frontier_day: string | null;
}>(STAGE_STATUS_SQL, [null]);

const leagues = await pool.query<{ id: number; slug: string }>(`SELECT id, slug FROM leagues`);
const slugOf = new Map(leagues.rows.map((l) => [l.id, l.slug]));

const statuses: StageStatus[] = rows.map((r) => ({
  leagueId: r.league_id,
  bracketId: r.bracket_id,
  stageName: r.stage_name,
  lastPlayedDay: r.last_played_day,
  previousPlayedDay: r.previous_played_day,
  unplayedSeries: Number(r.unplayed_series),
}));

// The frontier, not the wall clock: the stall window has to be measured against
// the data we hold, or a board goes stale purely because ingestion is behind.
const today = rows[0]?.frontier_day ?? new Date().toISOString().slice(0, 10);
console.log(`data frontier ${today}\n`);

const advances = resolveBoardAdvance(statuses, today);

console.log('league   as of        stage           reason');
for (const a of advances.sort((x, y) => (slugOf.get(x.leagueId) ?? '').localeCompare(slugOf.get(y.leagueId) ?? ''))) {
  console.log(
    `${(slugOf.get(a.leagueId) ?? String(a.leagueId)).padEnd(8)} ${(a.asOfDate ?? '--').padEnd(12)} ` +
      `${(a.stage ?? '--').padEnd(15)} ${a.reason}`,
  );
}

console.log('\ncurrent stage per league:');
for (const a of advances) {
  const league = statuses.filter((s) => s.leagueId === a.leagueId && s.lastPlayedDay !== null);
  const current = league.sort((x, y) => (x.lastPlayedDay! < y.lastPlayedDay! ? -1 : 1)).pop();
  if (!current) continue;
  console.log(
    `  ${(slugOf.get(a.leagueId) ?? '').padEnd(8)} ${(current.bracketId ?? '--').padEnd(15)} ` +
      `${stageKind(current.bracketId).padEnd(8)} last result ${current.lastPlayedDay}, ` +
      `${current.unplayedSeries} fixture(s) outstanding`,
  );
}

await pool.end();
