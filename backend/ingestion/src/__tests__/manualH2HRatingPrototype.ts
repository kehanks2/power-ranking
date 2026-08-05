/**
 * Manual PROTOTYPE (read-only, writes nothing): what would a head-to-head team
 * rating look like?
 *
 * Built ONLY from international games, with the league meta switched off
 * entirely (metaWeight 0). No regional assumption of any kind enters it: these
 * teams played each other directly, so the ordering is pure evidence. The
 * mirror of the player Global tab, at team level.
 *
 * Compared side by side with the production rating, which uses every game plus
 * the league prior.
 */
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import { runReplay, GLICKO2_SCALE, DEFAULT_VOLATILITY, type ReplayInput } from '@power-ranking/rating-engine';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
const MIN_INTL_GAMES = Number(process.env.MIN_G ?? 5);
const ORDER_CONSERVATIVE = process.env.CONSERVATIVE === '1';

const pool = createPool(DATABASE_URL);
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
  },
} as ReplayInput);

const h2hFinal = new Map<string, { mu: number; phi: number }>();
for (const s of h2h.teamHistory) h2hFinal.set(s.teamId, { mu: s.mu, phi: s.phi });

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

console.log(`HEAD-TO-HEAD RATING (international games only, no league prior, >=${MIN_INTL_GAMES} games)`);
console.log(`ordering: ${ORDER_CONSERVATIVE ? 'conservative (rating - RD)' : 'raw rating'}`);
console.log('rank team                   lg      rating  +/-   intlG');
rows.forEach((r, i) =>
  console.log(
    `${String(i + 1).padStart(4)} ${r.name.slice(0, 22).padEnd(23)} ${r.slug.padEnd(6)} ${r.rating.toFixed(0).padStart(6)}  ${r.rd.toFixed(0).padStart(3)}  ${String(r.games).padStart(5)}`,
  ),
);

const counts = new Map<string, number>();
for (const r of rows) counts.set(r.slug, (counts.get(r.slug) ?? 0) + 1);
console.log('\nleague mix:', [...counts].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' '));

await pool.end();
