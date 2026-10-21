/**
 * Manual read-only check: roster-change events that a substitute stint
 * produced. detectRosterChanges ignores a sub shorter than the persistence
 * threshold, but a longer one yields two events -- sub in, starter back -- for
 * a roster that never changed. Lists every A -> B -> A pair per (team, role).
 */
import { createPool } from '../db.js';
import { buildTeamLineupGames } from '../teamLineups.js';
import { detectRosterChanges } from '@power-ranking/rating-engine';

const PERSISTENCE_GAMES = 5;

const pool = createPool();
const lineupGamesByTeam = await buildTeamLineupGames(pool);
const teamNames = new Map(
  (await pool.query<{ id: number; name: string }>('SELECT id, name FROM teams')).rows.map((r) => [String(r.id), r.name]),
);
await pool.end();

let totalEvents = 0;
let stintEvents = 0;
const stints: string[] = [];
for (const [teamId, lineupGames] of lineupGamesByTeam) {
  const events = detectRosterChanges(lineupGames, PERSISTENCE_GAMES);
  totalEvents += events.length;
  for (const [i, out] of events.entries()) {
    const back = events
      .slice(i + 1)
      .find((e) => e.role === out.role && e.previousPlayerId === out.newPlayerId && e.newPlayerId === out.previousPlayerId);
    if (!back) continue;
    stintEvents += 2;
    const days = (Date.parse(String(back.effectiveAt)) - Date.parse(String(out.effectiveAt))) / 86_400_000;
    stints.push(
      `  ${(teamNames.get(String(teamId)) ?? String(teamId)).padEnd(26)} ${out.role}  ${String(out.effectiveAt).slice(0, 10)} -> ${String(back.effectiveAt).slice(0, 10)}  (${days.toFixed(0)} days)`,
    );
  }
}
console.log(`${totalEvents} roster-change events; ${stintEvents} of them are the two halves of ${stints.length} substitute stints:\n`);
console.log(stints.sort().join('\n'));
