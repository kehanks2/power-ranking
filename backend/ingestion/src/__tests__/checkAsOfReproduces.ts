/**
 * Does an as-of computation reproduce a generation that was actually stored?
 *
 * The whole backfill rests on the claim that a player rating is a pure function
 * of the games played by a date. This tests it against real data: take the
 * newest stored generation, recompute with `asOf` set to the moment it ran, and
 * compare. Nothing has been ingested since, so the game sets are identical and
 * the ratings should match to the numeric noise of a round trip.
 *
 * Read-only -- it never writes, so it cannot disturb the generation it checks.
 *
 * Run with: tsx --env-file=../../.env src/__tests__/checkAsOfReproduces.ts
 */
import { createPool } from '../db.js';
import { DEFAULT_WIN_WEIGHT } from '@power-ranking/rating-engine';
import { buildPlayerGroupStats, fetchPlayerGameRows, selectGroupRatings } from '../computePlayerRatings.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

interface StoredRow {
  playerId: number;
  leagueId: number;
  role: string;
  rating: string;
  rawRating: string | null;
}

async function main() {
  const pool = createPool(DATABASE_URL);

  const generation = await pool.query<{ computedAt: Date; frontier: string; rows: string }>(
    `SELECT computed_at AS "computedAt", data_frontier::text AS frontier, count(*)::text AS rows
       FROM player_ratings_history
      WHERE scope = 'regional' AND rating_window = 'all'
      GROUP BY computed_at, data_frontier
      ORDER BY computed_at DESC LIMIT 1`,
  );
  const { computedAt, frontier, rows: storedCount } = generation.rows[0];
  console.log(`newest regional/all generation: frontier ${frontier}, ${storedCount} rows, computed ${computedAt.toISOString()}`);

  const stored = await pool.query<StoredRow>(
    `SELECT player_id AS "playerId", league_id AS "leagueId", role,
            rating::text AS rating, raw_rating::text AS "rawRating"
       FROM player_ratings_history
      WHERE scope = 'regional' AND rating_window = 'all' AND computed_at = $1`,
    [computedAt],
  );

  const recomputed = selectGroupRatings(
    buildPlayerGroupStats(await fetchPlayerGameRows(pool, 'all', computedAt)),
    DEFAULT_WIN_WEIGHT,
  );

  const key = (r: { playerId: number; leagueId: number; role: string }) => `${r.playerId}|${r.leagueId}|${r.role}`;
  const storedByKey = new Map(stored.rows.map((r) => [key(r), r]));
  const freshByKey = new Map(recomputed.map((r) => [key(r), r]));

  const missing = [...storedByKey.keys()].filter((k) => !freshByKey.has(k));
  const extra = [...freshByKey.keys()].filter((k) => !storedByKey.has(k));

  let worst = 0;
  let worstKey = '';
  let over1e6 = 0;
  for (const [k, s] of storedByKey) {
    const f = freshByKey.get(k);
    if (!f) continue;
    const delta = Math.abs(Number(s.rating) - f.rating);
    if (delta > 1e-6) over1e6 += 1;
    if (delta > worst) {
      worst = delta;
      worstKey = k;
    }
  }

  console.log(`\nstored rows      ${storedByKey.size}`);
  console.log(`recomputed rows  ${freshByKey.size}`);
  console.log(`missing (stored but not recomputed): ${missing.length}${missing.length ? ' -> ' + missing.slice(0, 5).join(', ') : ''}`);
  console.log(`extra   (recomputed but not stored): ${extra.length}${extra.length ? ' -> ' + extra.slice(0, 5).join(', ') : ''}`);
  console.log(`rows differing by more than 1e-6:    ${over1e6}`);
  console.log(`worst rating delta:                  ${worst.toExponential(3)}${worstKey ? '  at ' + worstKey : ''}`);

  // Rank order is what the carets actually read, so check it separately: a
  // uniform numeric drift that preserved order would still be usable.
  const rankOf = (rows: { playerId: number; leagueId: number; role: string; rating: number }[]) => {
    const byGroup = new Map<string, typeof rows>();
    for (const r of rows) {
      const g = `${r.leagueId}|${r.role}`;
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g)!.push(r);
    }
    const ranks = new Map<string, number>();
    for (const [, group] of byGroup) {
      group.sort((a, b) => b.rating - a.rating);
      group.forEach((r, i) => ranks.set(key(r), i + 1));
    }
    return ranks;
  };

  const storedRanks = rankOf(
    stored.rows.map((r) => ({ playerId: r.playerId, leagueId: r.leagueId, role: r.role, rating: Number(r.rating) })),
  );
  const freshRanks = rankOf(recomputed);
  let rankMismatches = 0;
  for (const [k, r] of storedRanks) {
    const f = freshRanks.get(k);
    if (f !== undefined && f !== r) rankMismatches += 1;
  }
  console.log(`rank mismatches:                     ${rankMismatches} of ${storedRanks.size}`);

  const ok = missing.length === 0 && extra.length === 0 && rankMismatches === 0 && worst < 1e-6;
  console.log(`\n${ok ? 'REPRODUCES EXACTLY' : 'DOES NOT REPRODUCE'}`);

  await pool.end();
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error('as-of reproduction check failed:', err);
  process.exit(1);
});
