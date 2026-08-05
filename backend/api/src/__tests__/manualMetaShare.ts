/** Manual diagnostic (read-only): how much of each team's displayed rating is league meta credit? */
import { createPool } from '../db.js';
import {
  effectiveMetaWeight,
  internationalParticipationFactor,
  GLICKO2_SCALE,
  DEFAULT_VOLATILITY,
} from '@power-ranking/rating-engine';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
const META_WEIGHT = 0.8;

const pool = createPool(DATABASE_URL);
const result = await pool.query(`
  WITH lg AS (
    SELECT team_id, MAX(datetime_utc) AS last_at FROM (
      SELECT team1_id AS team_id, datetime_utc FROM games
      UNION ALL SELECT team2_id, datetime_utc FROM games) x GROUP BY team_id),
  lls AS (
    SELECT canonical_league_id, MAX(date_start) AS s FROM tournaments
    WHERE canonical_league_id IS NOT NULL GROUP BY canonical_league_id),
  intl AS (
    SELECT team_id, MAX(datetime_utc) AS last_intl, COUNT(*) AS intl_games FROM (
      SELECT g.team1_id AS team_id, g.datetime_utc FROM games g
        JOIN series s ON s.id=g.series_id JOIN tournaments tn ON tn.id=s.tournament_id
        WHERE tn.tournament_type='international'
      UNION ALL
      SELECT g.team2_id, g.datetime_utc FROM games g
        JOIN series s ON s.id=g.series_id JOIN tournaments tn ON tn.id=s.tournament_id
        WHERE tn.tournament_type='international') y GROUP BY team_id)
  SELECT t.name, l.slug, tr.mu_ctx, tr.phi_ctx, lr.mu_meta, lr.phi_meta,
         intl.last_intl, COALESCE(intl.intl_games,0) AS intl_games
  FROM teams t
  JOIN team_league_memberships tlm ON tlm.team_id=t.id AND tlm.end_date IS NULL
  JOIN leagues l ON l.id=tlm.league_id
  JOIN lg ON lg.team_id=t.id
  JOIN lls ON lls.canonical_league_id=l.id
  LEFT JOIN intl ON intl.team_id=t.id
  LEFT JOIN LATERAL (SELECT mu_ctx, phi_ctx FROM team_ratings_history WHERE team_id=t.id ORDER BY as_of_date DESC LIMIT 1) tr ON true
  LEFT JOIN LATERAL (SELECT mu_meta, phi_meta FROM league_ratings_history WHERE league_id=l.id ORDER BY as_of_date DESC LIMIT 1) lr ON true
  WHERE lg.last_at >= lls.s
`);

const rows = result.rows.map((x) => {
  const metaState = { mu: Number(x.mu_meta), phi: Number(x.phi_meta), sigma: DEFAULT_VOLATILITY };
  const daysIntl = x.last_intl ? (Date.now() - new Date(x.last_intl).getTime()) / 86400000 : null;
  const pf = internationalParticipationFactor(daysIntl);
  const weight = effectiveMetaWeight(metaState, META_WEIGHT, PHI_INIT_MAX) * pf;
  const ownRating = Number(x.mu_ctx) * GLICKO2_SCALE + 1500;
  const metaBonus = weight * metaState.mu * GLICKO2_SCALE;
  return {
    name: x.name as string,
    lg: x.slug as string,
    own: ownRating,
    bonus: metaBonus,
    total: ownRating + metaBonus,
    pf,
    intlGames: Number(x.intl_games),
    daysIntl,
  };
});
rows.sort((a, b) => b.total - a.total);

console.log('rank team                  lg     shown =  own  + metaBonus   pf    intlG  lastIntl(d)');
rows.slice(0, 24).forEach((x, i) => {
  console.log(
    `${String(i + 1).padStart(4)} ${x.name.slice(0, 21).padEnd(22)} ${x.lg.padEnd(6)} ${x.total.toFixed(0).padStart(5)} ${x.own.toFixed(0).padStart(6)} ${x.bonus.toFixed(0).padStart(10)}  ${x.pf.toFixed(2)}  ${String(x.intlGames).padStart(5)}  ${x.daysIntl === null ? 'never' : x.daysIntl.toFixed(0)}`,
  );
});

console.log('\nRank if the league meta bonus were removed entirely (own contextual only):');
const byOwn = [...rows].sort((a, b) => b.own - a.own);
byOwn.slice(0, 15).forEach((x, i) => {
  const shownRank = rows.findIndex((r) => r.name === x.name) + 1;
  const move = shownRank - (i + 1);
  console.log(
    `${String(i + 1).padStart(4)} ${x.name.slice(0, 21).padEnd(22)} ${x.lg.padEnd(6)} own ${x.own.toFixed(0)}   (shown #${shownRank}${move > 0 ? `, meta lifts it ${move}` : move < 0 ? `, meta drops it ${-move}` : ''})`,
  );
});

console.log('\nmeta bonus by league (median):');
const byLeague = new Map<string, typeof rows>();
for (const x of rows) {
  if (!byLeague.has(x.lg)) byLeague.set(x.lg, []);
  byLeague.get(x.lg)!.push(x);
}
const median = (a: number[]) => [...a].sort((p, q) => p - q)[Math.floor(a.length / 2)];
for (const [lg, xs] of [...byLeague].sort((a, b) => median(b[1].map((x) => x.bonus)) - median(a[1].map((x) => x.bonus)))) {
  console.log(
    `  ${lg.padEnd(6)} n=${String(xs.length).padStart(2)}  medianBonus ${median(xs.map((x) => x.bonus)).toFixed(0).padStart(4)}  medianPf ${median(xs.map((x) => x.pf)).toFixed(2)}  teamsNeverIntl ${xs.filter((x) => x.intlGames === 0).length}`,
  );
}

await pool.end();
