/**
 * Tests the "loser picks" mechanism: in games 2+ the previous game's loser
 * chooses side (from 2026, side or pick order), so if the choice is worth
 * anything the trailing team wins game N more than a side-blind model expects.
 * Framed as "did the previous loser win?" rather than "did blue win?" because
 * side in games 2+ is endogenous, and 2026 decoupled side from pick order.
 */
import { createPool } from '../db.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

interface GameRow {
  series_id: number;
  game_number: number;
  team1_id: number;
  team2_id: number;
  winner_team_id: number;
  yr: number;
}

function report(label: string, wins: number, n: number): void {
  if (n === 0) {
    console.log(`${label}: no data`);
    return;
  }
  const pct = (100 * wins) / n;
  const se = 100 * Math.sqrt((pct / 100) * (1 - pct / 100) / n);
  console.log(`${label}: ${wins}/${n} = ${pct.toFixed(2)}%  (+/- ${(1.96 * se).toFixed(2)}pp 95% CI)`);
}

async function main() {
  const pool = createPool(DATABASE_URL);
  const rows = await pool.query<GameRow>(`
    SELECT g.series_id, g.game_number, g.team1_id, g.team2_id, g.winner_team_id,
           EXTRACT(YEAR FROM g.datetime_utc)::int AS yr
    FROM games g
    ORDER BY g.series_id, g.game_number
  `);

  const bySeries = new Map<number, GameRow[]>();
  for (const r of rows.rows) {
    if (!bySeries.has(r.series_id)) bySeries.set(r.series_id, []);
    bySeries.get(r.series_id)!.push(r);
  }

  let prevLoserWins = 0;
  let prevLoserGames = 0;
  const byYear = new Map<number, { wins: number; n: number }>();
  const byGameNumber = new Map<number, { wins: number; n: number }>();

  for (const games of bySeries.values()) {
    if (games.length < 2) continue;
    for (let i = 1; i < games.length; i++) {
      const prev = games[i - 1];
      const cur = games[i];
      const prevLoser = prev.winner_team_id === prev.team1_id ? prev.team2_id : prev.team1_id;
      // only count if the previous loser is actually one of this game's teams
      if (prevLoser !== cur.team1_id && prevLoser !== cur.team2_id) continue;

      const won = cur.winner_team_id === prevLoser ? 1 : 0;
      prevLoserWins += won;
      prevLoserGames += 1;

      if (!byYear.has(cur.yr)) byYear.set(cur.yr, { wins: 0, n: 0 });
      const y = byYear.get(cur.yr)!;
      y.wins += won;
      y.n += 1;

      if (!byGameNumber.has(cur.game_number)) byGameNumber.set(cur.game_number, { wins: 0, n: 0 });
      const gn = byGameNumber.get(cur.game_number)!;
      gn.wins += won;
      gn.n += 1;
    }
  }

  console.log('=== Does the PREVIOUS GAME\'S LOSER win the next game? (they get the choice) ===');
  console.log('50% = the choice is worth nothing. >50% = there is a real rubber-band effect.\n');
  report('ALL games 2+', prevLoserWins, prevLoserGames);

  console.log('\n--- by year (2026 decoupled side from pick order) ---');
  for (const yr of [...byYear.keys()].sort()) {
    const { wins, n } = byYear.get(yr)!;
    report(`${yr}`, wins, n);
  }

  console.log('\n--- by game number within series ---');
  for (const gn of [...byGameNumber.keys()].sort((a, b) => a - b)) {
    const { wins, n } = byGameNumber.get(gn)!;
    report(`game ${gn}`, wins, n);
  }

  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
