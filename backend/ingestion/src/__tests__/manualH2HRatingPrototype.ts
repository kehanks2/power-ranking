/**
 * Manual read-only prototype: what would a head-to-head team rating look like?
 * Built only from international games with the league meta off (metaWeight 0),
 * so the ordering is pure head-to-head evidence -- the team-level mirror of the
 * player Global tab.
 */
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import { runReplay, GLICKO2_SCALE, DEFAULT_VOLATILITY, type ReplayInput } from '@power-ranking/rating-engine';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
const MIN_INTL_GAMES = Number(process.env.MIN_G ?? 5);
const ORDER_CONSERVATIVE = process.env.CONSERVATIVE !== '0';
const HALF_LIVES = [Infinity, 730, 550, 365, 180];

const pool = createPool();
const { teamIds, leagueIds, games, decayEvents } = await loadReplayData(pool);

const meta = await pool.query<{ id: string; name: string; slug: string; in_split: boolean }>(`
  WITH lls AS (SELECT canonical_league_id, MAX(date_start) AS s FROM tournaments WHERE canonical_league_id IS NOT NULL GROUP BY canonical_league_id),
  lastg AS (SELECT team_id, MAX(datetime_utc) AS last_at FROM (
     SELECT team1_id AS team_id, datetime_utc FROM games UNION ALL SELECT team2_id, datetime_utc FROM games) x GROUP BY team_id)
  SELECT t.id::text, t.name, l.slug, (lastg.last_at >= lls.s) AS in_split
  FROM teams t
  JOIN team_league_memberships tlm ON tlm.team_id=t.id AND tlm.end_date IS NULL
  JOIN leagues l ON l.id=tlm.league_id
  JOIN lastg ON lastg.team_id=t.id JOIN lls ON lls.canonical_league_id=l.id
`);
const info = new Map(meta.rows.map((r) => [r.id, r]));

// International games only: cross-league play is exactly the international set.
const intlGames = games.filter((g) => g.team1LeagueId !== g.team2LeagueId);
const intlCount = new Map<string, number>();
for (const g of intlGames) {
  for (const id of [g.team1Id, g.team2Id]) intlCount.set(id, (intlCount.get(id) ?? 0) + 1);
}
console.log(`${intlGames.length} international games, ${intlCount.size} teams involved\n`);

for (const halfLife of HALF_LIVES) {
  const h2h = runReplay({
    teamIds,
    leagueIds,
    games: intlGames,
    decayEvents,
    config: {
      phiInitMax: PHI_INIT_MAX,
      sigmaDefault: DEFAULT_VOLATILITY,
      marginScale: 1e9,
      movWeightCap: 1.5,
      metaWeight: 0, // no regional prior at all -- the whole point
      seriesCorrelation: 0.6,
      ratingPeriodDays: 1,
      internationalWeightMultiplier: 1,
      recencyHalfLifeDays: halfLife,
    },
  } as ReplayInput);

  const h2hFinal = new Map<string, { mu: number; phi: number }>();
  for (const s2 of h2h.teamHistory) h2hFinal.set(s2.teamId, { mu: s2.mu, phi: s2.phi });

  const rows = [...intlCount.entries()]
    .filter(([id, n]) => n >= MIN_INTL_GAMES && info.get(id)?.in_split)
    .map(([id, n]) => {
      const st = h2hFinal.get(id)!;
      return {
        name: info.get(id)!.name,
        slug: info.get(id)!.slug,
        games: n,
        rating: st.mu * GLICKO2_SCALE + 1500,
        rd: st.phi * GLICKO2_SCALE,
      };
    })
    .sort((a, b) => (ORDER_CONSERVATIVE ? b.rating - b.rd - (a.rating - a.rd) : b.rating - a.rating));

  const medRd = [...rows.map((r) => r.rd)].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
  console.log(`=== recency half-life: ${halfLife === Infinity ? 'none (all games equal)' : halfLife + 'd'}  | ${rows.length} teams | median +/- ${medRd.toFixed(0)}`);
  rows.slice(0, 10).forEach((r, i) =>
    console.log(
      `  ${String(i + 1).padStart(2)} ${r.name.slice(0, 20).padEnd(21)} ${r.slug.padEnd(6)} ${r.rating.toFixed(0).padStart(5)} +/-${r.rd.toFixed(0).padStart(3)}  floor ${(r.rating - r.rd).toFixed(0)}  (${r.games}g)`,
    ),
  );
  console.log();
}

await pool.end();
