/**
 * Manual diagnostic (read-only): are the league-vs-league gaps we display the
 * gaps the results actually support?
 *
 * Fits a Bradley-Terry model directly to cross-league international games --
 * each game is one league beating another, and ratings are fitted by maximum
 * likelihood. Unlike inverting aggregate win rates, this accounts for WHO each
 * league played: LCK's record comes largely against LPL, CBLOL's against
 * everyone, and a naive inversion would misread both.
 *
 * The fitted spread is the yardstick the displayed league offsets should be
 * compared against.
 */
import { createPool } from '../db.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const ELO_SCALE = 400 / Math.LN10; // logistic scale so ratings read as Elo points

const pool = createPool(DATABASE_URL);
const rows = await pool.query<{ lg1: string; lg2: string; lg1_won: boolean }>(`
  SELECT l1.slug AS lg1, l2.slug AS lg2, (g.winner_team_id = g.team1_id) AS lg1_won
  FROM games g
  JOIN series s ON s.id = g.series_id
  JOIN tournaments tn ON tn.id = s.tournament_id
  JOIN team_league_memberships m1 ON m1.team_id = g.team1_id AND m1.end_date IS NULL
  JOIN team_league_memberships m2 ON m2.team_id = g.team2_id AND m2.end_date IS NULL
  JOIN leagues l1 ON l1.id = m1.league_id
  JOIN leagues l2 ON l2.id = m2.league_id
  WHERE tn.tournament_type = 'international' AND l1.slug <> l2.slug
`);

const leagues = [...new Set(rows.rows.flatMap((r) => [r.lg1, r.lg2]))].sort();
const rating = new Map(leagues.map((l) => [l, 0]));

// Gradient ascent on the Bradley-Terry log-likelihood.
for (let iter = 0; iter < 20000; iter += 1) {
  const grad = new Map(leagues.map((l) => [l, 0]));
  for (const r of rows.rows) {
    const diff = rating.get(r.lg1)! - rating.get(r.lg2)!;
    const p1 = 1 / (1 + Math.exp(-diff));
    const residual = (r.lg1_won ? 1 : 0) - p1;
    grad.set(r.lg1, grad.get(r.lg1)! + residual);
    grad.set(r.lg2, grad.get(r.lg2)! - residual);
  }
  for (const l of leagues) rating.set(l, rating.get(l)! + 0.002 * grad.get(l)!);
  // Identifiability: the mean is arbitrary, so pin it at zero.
  const mean = leagues.reduce((s, l) => s + rating.get(l)!, 0) / leagues.length;
  for (const l of leagues) rating.set(l, rating.get(l)! - mean);
}

const displayed = await pool.query<{ slug: string; offset: string }>(`
  SELECT l.slug, (lr.mu_meta * 173.7178) AS offset
  FROM (SELECT DISTINCT ON (league_id) * FROM league_ratings_history ORDER BY league_id, as_of_date DESC) lr
  JOIN leagues l ON l.id = lr.league_id
`);
const displayedBySlug = new Map(displayed.rows.map((r) => [r.slug, Number(r.offset)]));
const displayedMean = [...displayedBySlug.values()].reduce((a, b) => a + b, 0) / displayedBySlug.size;

const fitted = leagues
  .map((l) => ({ league: l, fitted: rating.get(l)! * ELO_SCALE, shown: (displayedBySlug.get(l) ?? 0) - displayedMean }))
  .sort((a, b) => b.fitted - a.fitted);

console.log(`Bradley-Terry fit over ${rows.rows.length} cross-league international games`);
console.log('(both columns centred on zero so only the SPREAD is compared)\n');
console.log('league   fitted    displayed    displayed/fitted');
for (const f of fitted) {
  console.log(
    `${f.league.padEnd(7)} ${f.fitted.toFixed(0).padStart(6)}    ${f.shown.toFixed(0).padStart(6)}       ${(f.shown / f.fitted).toFixed(2).padStart(6)}x`,
  );
}

const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
const fittedSpread = spread(fitted.map((f) => f.fitted));
const shownSpread = spread(fitted.map((f) => f.shown));
console.log(`\ntop-to-bottom spread:  fitted ${fittedSpread.toFixed(0)}   displayed ${shownSpread.toFixed(0)}   ratio ${(shownSpread / fittedSpread).toFixed(2)}x`);

const winProb = (elo: number) => 1 / (1 + Math.pow(10, -elo / 400));
console.log(
  `implied best-vs-worst win probability:  fitted ${(winProb(fittedSpread) * 100).toFixed(1)}%   displayed ${(winProb(shownSpread) * 100).toFixed(1)}%`,
);

await pool.end();
