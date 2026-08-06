/**
 * Manual one-off runner: sweep the player-rating win weight and show how the
 * board moves. Read-only -- computes every variant in memory and writes
 * nothing, so it is safe to run against the live DB. Run with tsx.
 */
import { createPool } from '../db.js';
import { fetchPlayerGameRows, buildPlayerGroupStats, selectGroupRatings } from '../computePlayerRatings.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const WIN_WEIGHTS = [0, 0.3, 0.4, 0.5, 0.6, 0.7];
const NOTABLE = ['Faker', 'Chovy', 'Zeus', 'Keria', 'Oner', 'Ruler', 'Caps', 'Knight', 'Tarzan', 'Peyz'];

async function main() {
  const pool = createPool(DATABASE_URL);

  const rows = await fetchPlayerGameRows(pool);
  const groupStats = buildPlayerGroupStats(rows);
  console.log(`Loaded ${rows.length} player-game rows -> ${groupStats.length} (player, role, league) profiles.\n`);

  const meta = await pool.query<{ id: number; handle: string; role: string | null; league: string | null }>(`
    SELECT p.id, p.handle, rm.role, l.slug AS league
    FROM players p
    LEFT JOIN roster_memberships rm ON rm.player_id = p.id AND rm.end_date IS NULL
    LEFT JOIN team_league_memberships tlm ON tlm.team_id = rm.team_id AND tlm.end_date IS NULL
    LEFT JOIN leagues l ON l.id = tlm.league_id
  `);
  const metaById = new Map(meta.rows.map((r) => [r.id, r]));

  for (const winWeight of WIN_WEIGHTS) {
    // One rating per player, so the sweep compares win weights rather than
    // player-with-two-leagues counting twice.
    const ranked = selectGroupRatings(groupStats, winWeight)
      .filter((r) => r.isPrimary)
      .map((r) => ({
        handle: metaById.get(r.playerId)?.handle ?? `#${r.playerId}`,
        role: metaById.get(r.playerId)?.role ?? '--',
        league: metaById.get(r.playerId)?.league ?? '--',
        rating: r.rating,
        gamesPlayed: r.gamesPlayed,
      }))
      .sort((a, b) => b.rating - a.rating);

    const rankByHandle = new Map(ranked.map((p, i) => [p.handle, i + 1]));
    const roleCounts = new Map<string, number>();
    for (const p of ranked.slice(0, 20)) roleCounts.set(p.role, (roleCounts.get(p.role) ?? 0) + 1);

    console.log(`=== winWeight ${winWeight.toFixed(2)} ===`);
    console.log(
      '  top 10: ' +
        ranked
          .slice(0, 10)
          .map((p, i) => `${i + 1}.${p.handle}(${p.role}) ${p.rating.toFixed(1)}`)
          .join('  '),
    );
    console.log(
      '  top-20 roles: ' +
        [...roleCounts.entries()].sort((a, b) => b[1] - a[1]).map(([role, n]) => `${role}:${n}`).join(' '),
    );
    console.log(
      '  notables: ' +
        NOTABLE.map((h) => {
          const rank = rankByHandle.get(h);
          const player = ranked.find((p) => p.handle === h);
          return rank && player ? `${h} #${rank} (${player.rating.toFixed(1)})` : `${h} --`;
        }).join('  '),
    );
    console.log();
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Win weight sweep failed:', err);
  process.exit(1);
});
