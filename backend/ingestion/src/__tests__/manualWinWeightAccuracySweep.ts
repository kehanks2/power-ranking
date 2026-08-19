/**
 * Manual read-only sweep: which player-rating win weight produces ratings that
 * best predict games the ratings have not seen? Writes nothing.
 *
 * Walk-forward, so there is no leakage: at each cutoff the ratings are built
 * from games strictly before it, with recency measured from the cutoff rather
 * than from NOW(), and scored on the month that follows.
 *
 * Only intra-league games count. A player rating is a percentile inside its
 * (league, role) pool, so two leagues' numbers are not comparable and averaging
 * across them would compare nothing.
 *
 * AUC is the headline because it needs no calibration: it asks only whether the
 * roster gap ranks winners above losers, so the weights compete on ordering
 * rather than on how well a fixed slope happens to suit each. Brier is reported
 * alongside with its slope fitted on the training games.
 */
import { createPool } from '../db.js';
import { buildPlayerGroupStats, selectGroupRatings, type PlayerGameRow } from '../computePlayerRatings.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const WIN_WEIGHTS = [0, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1];
const CUTOFFS = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'];
const MIN_RATED_PER_TEAM = 4;

interface StatRow extends PlayerGameRow {
  datetime_utc: string;
}

interface Game {
  id: number;
  day: string;
  leagueId: number;
  team1Id: number;
  team2Id: number;
  won1: number;
}

const pool = createPool(DATABASE_URL);

const stats = await pool.query<StatRow>(`
  -- The league a game was PLAYED in, from its tournament, never from the team's
  -- membership row: membership is current-state, so reading it inside a
  -- walk-forward fold is future information. International events have no
  -- regional league of their own, so those fall back to the team's -- the one
  -- place no per-game answer exists.
  WITH team_league AS (
    SELECT team_id, league_id FROM team_league_memberships
  )
  SELECT
    pgp.player_id,
    pgp.role,
    COALESCE(t.canonical_league_id, cl.league_id) AS league_id,
    (pgp.kills + pgp.assists)::numeric / GREATEST(pgp.deaths, 1) AS kda,
    pgp.gold_share,
    pgp.damage_share,
    pgp.kill_participation,
    pgp.creep_score * 60.0 / NULLIF(g.gamelength_seconds, 0) AS cs_min,
    pgp.gold_diff::numeric AS gold_diff,
    (CASE WHEN pgp.team_id = g.team1_id THEN g.team1_neutral_objectives ELSE g.team2_neutral_objectives END)::numeric
      / NULLIF(g.team1_neutral_objectives + g.team2_neutral_objectives, 0) AS obj_control,
    (g.winner_team_id = pgp.team_id) AS won,
    '0' AS age_days,
    g.datetime_utc::text AS datetime_utc
  FROM player_game_performance pgp
  JOIN games g ON g.id = pgp.game_id
  JOIN series sr ON sr.id = g.series_id
  JOIN tournaments t ON t.id = sr.tournament_id
  JOIN team_league cl ON cl.team_id = pgp.team_id
`);

const games = await pool.query<{
  id: number; day: string; league_id: number; team1_id: number; team2_id: number; winner_team_id: number;
}>(`
  SELECT g.id, g.datetime_utc::date::text AS day, t.canonical_league_id AS league_id,
         g.team1_id, g.team2_id, g.winner_team_id
    FROM games g
    JOIN series s ON s.id = g.series_id
    JOIN tournaments t ON t.id = s.tournament_id
   WHERE t.tournament_type <> 'international'
     AND t.canonical_league_id IS NOT NULL
   ORDER BY g.datetime_utc
`);

const lineups = await pool.query<{ game_id: number; team_id: number; player_id: number }>(
  `SELECT game_id, team_id, player_id FROM game_lineups`,
);

const rosterByGameTeam = new Map<string, number[]>();
for (const row of lineups.rows) {
  const key = `${row.game_id}::${row.team_id}`;
  if (!rosterByGameTeam.has(key)) rosterByGameTeam.set(key, []);
  rosterByGameTeam.get(key)!.push(row.player_id);
}

const allGames: Game[] = games.rows.map((g) => ({
  id: g.id,
  day: g.day,
  leagueId: g.league_id,
  team1Id: g.team1_id,
  team2Id: g.team2_id,
  won1: g.winner_team_id === g.team1_id ? 1 : 0,
}));

console.log(`${stats.rows.length} player-game rows, ${allGames.length} intra-league games\n`);

const DAY_MS = 86_400_000;

/** Rating per (player, league) as of a cutoff, from games strictly before it. */
function ratingsAsOf(cutoff: string, winWeight: number): Map<string, number> {
  const cutoffMs = Date.parse(`${cutoff}T00:00:00Z`);
  const rows: PlayerGameRow[] = [];
  for (const row of stats.rows) {
    const playedMs = Date.parse(row.datetime_utc);
    if (playedMs >= cutoffMs) continue;
    rows.push({ ...row, age_days: String((cutoffMs - playedMs) / DAY_MS) });
  }
  const rated = selectGroupRatings(buildPlayerGroupStats(rows), winWeight);
  return new Map(rated.map((r) => [`${r.playerId}::${r.leagueId}`, r.rating]));
}

/** Mean rating of the five that played, or null if too few are rated. */
function rosterRating(game: Game, teamId: number, ratings: Map<string, number>): number | null {
  const roster = rosterByGameTeam.get(`${game.id}::${teamId}`) ?? [];
  const values = roster
    .map((playerId) => ratings.get(`${playerId}::${game.leagueId}`))
    .filter((v): v is number => v !== undefined);
  if (values.length < MIN_RATED_PER_TEAM) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function scoreGames(games: Game[], ratings: Map<string, number>): { key: string; gap: number; won1: number }[] {
  const scored: { key: string; gap: number; won1: number }[] = [];
  for (const game of games) {
    const r1 = rosterRating(game, game.team1Id, ratings);
    const r2 = rosterRating(game, game.team2Id, ratings);
    if (r1 === null || r2 === null) continue;
    scored.push({ key: String(game.id), gap: r1 - r2, won1: game.won1 });
  }
  return scored;
}

/**
 * Probability that the higher-rated roster wins. Mann-Whitney form (mean rank
 * of winners), with ties taking the average rank, so it is O(n log n) and cheap
 * enough to bootstrap.
 */
function auc(scored: { gap: number; won1: number }[]): number {
  const n1 = scored.reduce((sum, s) => sum + s.won1, 0);
  const n2 = scored.length - n1;
  if (n1 === 0 || n2 === 0) return NaN;

  const sorted = [...scored].sort((a, b) => a.gap - b.gap);
  let rankSumWins = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].gap === sorted[i].gap) j += 1;
    const averageRank = (i + j + 2) / 2; // ranks are 1-based
    for (let k = i; k <= j; k += 1) if (sorted[k].won1 === 1) rankSumWins += averageRank;
    i = j + 1;
  }
  return (rankSumWins - (n1 * (n1 + 1)) / 2) / (n1 * n2);
}

const logistic = (gap: number, slope: number) => 1 / (1 + Math.exp(-slope * gap));

/** Slope minimising training log loss, so Brier is not judging a fixed scale. */
function fitSlope(train: { gap: number; won1: number }[]): number {
  let best = 0.05;
  let bestLoss = Infinity;
  for (let slope = 0.005; slope <= 0.4; slope += 0.005) {
    let loss = 0;
    for (const { gap, won1 } of train) {
      const p = logistic(gap, slope);
      loss -= won1 * Math.log(Math.max(p, 1e-9)) + (1 - won1) * Math.log(Math.max(1 - p, 1e-9));
    }
    if (loss < bestLoss) {
      bestLoss = loss;
      best = slope;
    }
  }
  return best;
}

console.log('winWeight    AUC   accuracy    Brier   testGames');
const summary: { winWeight: number; auc: number; accuracy: number; brier: number; n: number }[] = [];
// Same test games for every weight, kept aligned so the bootstrap can resample
// games once and score all weights on the identical resample (paired).
const scoredByWeight = new Map<number, Map<string, { gap: number; won1: number }>>();

for (const winWeight of WIN_WEIGHTS) {
  let concordantSum = 0;
  let aucFolds = 0;
  let correct = 0;
  let brier = 0;
  let n = 0;
  const scoredHere = new Map<string, { gap: number; won1: number }>();
  scoredByWeight.set(winWeight, scoredHere);

  for (let i = 0; i < CUTOFFS.length; i += 1) {
    const cutoff = CUTOFFS[i];
    const nextCutoff = CUTOFFS[i + 1] ?? '9999-12-31';
    const ratings = ratingsAsOf(cutoff, winWeight);

    const train = scoreGames(allGames.filter((g) => g.day < cutoff), ratings);
    const test = scoreGames(allGames.filter((g) => g.day >= cutoff && g.day < nextCutoff), ratings);
    if (test.length === 0 || train.length === 0) continue;

    const slope = fitSlope(train);
    const foldAuc = auc(test);
    if (!Number.isNaN(foldAuc)) {
      concordantSum += foldAuc * test.length;
      aucFolds += test.length;
    }
    for (const { key, gap, won1 } of test) {
      const p = logistic(gap, slope);
      brier += (p - won1) ** 2;
      if (gap !== 0 && (gap > 0 ? 1 : 0) === won1) correct += 1;
      n += 1;
      scoredHere.set(key, { gap, won1 });
    }
  }

  const row = {
    winWeight,
    auc: concordantSum / aucFolds,
    accuracy: (100 * correct) / n,
    brier: brier / n,
    n,
  };
  summary.push(row);
  console.log(
    `  ${winWeight.toFixed(2)}      ${row.auc.toFixed(4)}  ${row.accuracy.toFixed(2)}%   ${row.brier.toFixed(4)}   ${row.n}`,
  );
}

const bestAuc = [...summary].sort((a, b) => b.auc - a.auc)[0];
const bestBrier = [...summary].sort((a, b) => a.brier - b.brier)[0];
console.log(`\nbest AUC   ${bestAuc.winWeight.toFixed(2)} (${bestAuc.auc.toFixed(4)})`);
console.log(`best Brier ${bestBrier.winWeight.toFixed(2)} (${bestBrier.brier.toFixed(4)})`);

// A ranking of weights means nothing if the gaps sit inside sampling noise.
// Paired bootstrap: resample the test games once per draw and rescore every
// weight on that same draw, so the comparison is not swamped by which games
// were drawn.
const BOOTSTRAP_DRAWS = 2000;
const keys = [...scoredByWeight.get(WIN_WEIGHTS[0])!.keys()];
const winsByWeight = new Map(WIN_WEIGHTS.map((w) => [w, 0]));
const diffVsHalf = new Map(WIN_WEIGHTS.map((w) => [w, [] as number[]]));

for (let draw = 0; draw < BOOTSTRAP_DRAWS; draw += 1) {
  const sample: string[] = [];
  for (let i = 0; i < keys.length; i += 1) sample.push(keys[(Math.random() * keys.length) | 0]);

  let bestWeight = WIN_WEIGHTS[0];
  let bestValue = -Infinity;
  const aucThisDraw = new Map<number, number>();
  for (const weight of WIN_WEIGHTS) {
    const scored = scoredByWeight.get(weight)!;
    const drawn = sample.map((key) => scored.get(key)!).filter(Boolean);
    const value = auc(drawn);
    aucThisDraw.set(weight, value);
    if (value > bestValue) {
      bestValue = value;
      bestWeight = weight;
    }
  }
  winsByWeight.set(bestWeight, winsByWeight.get(bestWeight)! + 1);
  const half = aucThisDraw.get(0.5)!;
  for (const weight of WIN_WEIGHTS) diffVsHalf.get(weight)!.push(aucThisDraw.get(weight)! - half);
}

const pct = (values: number[], q: number) => [...values].sort((a, b) => a - b)[Math.floor(q * values.length)];

console.log(`\nPaired bootstrap, ${BOOTSTRAP_DRAWS} draws over ${keys.length} test games`);
console.log('winWeight   bestInDraw   AUC vs 0.50 (95% CI)');
for (const weight of WIN_WEIGHTS) {
  const diffs = diffVsHalf.get(weight)!;
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const share = (100 * winsByWeight.get(weight)!) / BOOTSTRAP_DRAWS;
  console.log(
    `  ${weight.toFixed(2)}        ${share.toFixed(1).padStart(5)}%      ` +
      `${mean >= 0 ? '+' : ''}${mean.toFixed(4)}  [${pct(diffs, 0.025).toFixed(4)}, ${pct(diffs, 0.975).toFixed(4)}]`,
  );
}

await pool.end();
