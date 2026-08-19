/**
 * Does a player's rating travel with the player? Read-only; writes nothing.
 *
 * Held-out accuracy cannot pick the win weight -- it rises monotonically to 1.0,
 * "rank every player by their team's record" (MODEL.md). A transfer is the
 * natural experiment that can: split the record at a cutoff, rate each player
 * before and after, and see how much of the rating survives changing teams.
 *
 * A metric that is really team strength restated should carry well for a player
 * who STAYED (same team either side) and badly for one who MOVED. A metric that
 * is really individual should carry about equally for both. So the diagnostic is
 * not the movers' correlation on its own -- a noisy metric scores badly for
 * everyone -- but the GAP between stayers and movers. Small gap, portable signal.
 *
 * Run with: tsx --env-file=../../.env src/__tests__/manualTransferCarryover.ts
 */
import { createPool } from '../db.js';
import { buildPlayerGroupStats, selectGroupRatings, type PlayerGameRow } from '../computePlayerRatings.js';
import { componentWeightsForRole, componentWeightsForRoleAtWinWeight } from '@power-ranking/rating-engine';

const CUTOFFS = ['2025-07-01', '2025-10-01', '2026-01-01', '2026-04-01', '2026-07-01'];
/** Games each side of a cutoff before a player's two ratings are worth comparing. */
const MIN_GAMES_EACH_SIDE = 10;
const DAY_MS = 86_400_000;

type Weights = ReturnType<typeof componentWeightsForRole>;

function without(base: Weights, drop: (keyof Weights)[]): Weights {
  const kept = Object.entries(base).filter(([component]) => !drop.includes(component as keyof Weights));
  const total = kept.reduce((sum, [, weight]) => sum + (weight ?? 0), 0);
  const out: Weights = {};
  for (const [component, weight] of kept) out[component as keyof Weights] = total === 0 ? 0 : (weight ?? 0) / total;
  return out;
}

function rescaleTo(weights: Weights, total: number, extra: Weights): Weights {
  const sum = Object.values(weights).reduce<number>((acc, w) => acc + (w ?? 0), 0);
  const out: Weights = {};
  for (const [component, weight] of Object.entries(weights)) {
    out[component as keyof Weights] = sum === 0 ? 0 : ((weight ?? 0) / sum) * total;
  }
  return { ...out, ...extra };
}

function withDpm(base: Weights, share: number): Weights {
  const win = base.winRate ?? 0;
  const boxTotal = 1 - win;
  if (boxTotal <= 0 || share >= boxTotal) return base;
  const box = without(base, ['winRate']);
  return { ...rescaleTo(box, boxTotal - share, { dpm: share }), winRate: win };
}

const CONFIGS: { label: string; weightsFor: (role: string) => Weights }[] = [
  { label: 'shipped (win 0.40)', weightsFor: (r) => componentWeightsForRole(r) },
  { label: 'win 0.60', weightsFor: (r) => componentWeightsForRoleAtWinWeight(r, 0.6) },
  { label: 'win 0.30', weightsFor: (r) => componentWeightsForRoleAtWinWeight(r, 0.3) },
  { label: 'no winRate', weightsFor: (r) => without(componentWeightsForRole(r), ['winRate']) },
  { label: 'dpm 0.20', weightsFor: (r) => withDpm(componentWeightsForRole(r), 0.2) },
  // The degenerate end: rating IS the team's record. Must show the widest gap of
  // all, or the diagnostic is not measuring what it claims to.
  { label: 'winRate only', weightsFor: () => ({ winRate: 1 }) },
];

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  if (n < 3) return NaN;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx === 0 || syy === 0 ? NaN : sxy / Math.sqrt(sxx * syy);
}

interface StatRow extends PlayerGameRow {
  datetime_utc: string;
  team_id: number;
}

const pool = createPool();

const stats = await pool.query<StatRow>(`
  WITH team_league AS (SELECT team_id, league_id FROM team_league_memberships)
  SELECT pgp.player_id, pgp.role, COALESCE(t.canonical_league_id, cl.league_id) AS league_id,
    pgp.team_id,
    (pgp.kills + pgp.assists)::numeric / GREATEST(pgp.deaths, 1) AS kda,
    pgp.gold_share, pgp.damage_share, pgp.kill_participation,
    pgp.creep_score * 60.0 / NULLIF(g.gamelength_seconds, 0) AS cs_min,
    pgp.gold_diff::numeric AS gold_diff,
    (CASE WHEN pgp.team_id = g.team1_id THEN g.team1_neutral_objectives ELSE g.team2_neutral_objectives END)::numeric
      / NULLIF(g.team1_neutral_objectives + g.team2_neutral_objectives, 0) AS obj_control,
    pgp.damage_to_champions * 60.0 / NULLIF(g.gamelength_seconds, 0) AS dpm,
    (g.winner_team_id = pgp.team_id) AS won,
    '0' AS age_days,
    g.datetime_utc::text AS datetime_utc
  FROM player_game_performance pgp
  JOIN games g ON g.id = pgp.game_id
  JOIN series sr ON sr.id = g.series_id
  JOIN tournaments t ON t.id = sr.tournament_id
  JOIN team_league cl ON cl.team_id = pgp.team_id
  ORDER BY g.datetime_utc
`);

const latestMs = Math.max(...stats.rows.map((r) => Date.parse(r.datetime_utc)));

/** Rows on one side of a cutoff, aged against the end of that side's window. */
function slice(from: number, to: number, ageAgainst: number): StatRow[] {
  return stats.rows
    .filter((row) => {
      const played = Date.parse(row.datetime_utc);
      return played >= from && played < to;
    })
    .map((row) => ({ ...row, age_days: String((ageAgainst - Date.parse(row.datetime_utc)) / DAY_MS) }));
}

/** The team a player played most for in a window, and how many games that was. */
function dominantTeam(rows: StatRow[]): Map<number, { teamId: number; games: number; total: number }> {
  const counts = new Map<number, Map<number, number>>();
  for (const row of rows) {
    if (!counts.has(row.player_id)) counts.set(row.player_id, new Map());
    const byTeam = counts.get(row.player_id)!;
    byTeam.set(row.team_id, (byTeam.get(row.team_id) ?? 0) + 1);
  }
  const out = new Map<number, { teamId: number; games: number; total: number }>();
  for (const [playerId, byTeam] of counts) {
    let best = { teamId: -1, games: 0 };
    let total = 0;
    for (const [teamId, games] of byTeam) {
      total += games;
      if (games > best.games) best = { teamId, games };
    }
    out.set(playerId, { ...best, total });
  }
  return out;
}

interface Pair {
  playerId: number;
  moved: boolean;
}

// Which players qualify, and whether they moved -- config-independent, so it is
// computed once and every config scores the same population.
const foldPairs: { cutoff: string; before: StatRow[]; after: StatRow[]; pairs: Pair[] }[] = [];
for (const cutoff of CUTOFFS) {
  const cutoffMs = Date.parse(`${cutoff}T00:00:00Z`);
  const before = slice(-Infinity, cutoffMs, cutoffMs);
  const after = slice(cutoffMs, Infinity, latestMs);
  const beforeTeams = dominantTeam(before);
  const afterTeams = dominantTeam(after);

  const pairs: Pair[] = [];
  for (const [playerId, b] of beforeTeams) {
    const a = afterTeams.get(playerId);
    if (!a) continue;
    if (b.total < MIN_GAMES_EACH_SIDE || a.total < MIN_GAMES_EACH_SIDE) continue;
    pairs.push({ playerId, moved: b.teamId !== a.teamId });
  }
  foldPairs.push({ cutoff, before, after, pairs });
}

const movers = foldPairs.reduce((n, f) => n + f.pairs.filter((p) => p.moved).length, 0);
const stayers = foldPairs.reduce((n, f) => n + f.pairs.filter((p) => !p.moved).length, 0);
console.log(`${stats.rows.length} player-game rows, ${CUTOFFS.length} cutoffs`);
console.log(`${movers} mover observations, ${stayers} stayer observations (min ${MIN_GAMES_EACH_SIDE} games each side)\n`);

console.log('config                 stayers  movers    gap      n');
for (const config of CONFIGS) {
  const moverBefore: number[] = [];
  const moverAfter: number[] = [];
  const stayerBefore: number[] = [];
  const stayerAfter: number[] = [];

  for (const fold of foldPairs) {
    const rate = (rows: StatRow[]) => {
      const ratings = selectGroupRatings(buildPlayerGroupStats(rows), undefined, config.weightsFor);
      const byPlayer = new Map<number, number>();
      for (const r of ratings) if (r.isPrimary) byPlayer.set(r.playerId, r.rating);
      return byPlayer;
    };
    const before = rate(fold.before);
    const after = rate(fold.after);

    for (const pair of fold.pairs) {
      const b = before.get(pair.playerId);
      const a = after.get(pair.playerId);
      if (b === undefined || a === undefined) continue;
      if (pair.moved) {
        moverBefore.push(b);
        moverAfter.push(a);
      } else {
        stayerBefore.push(b);
        stayerAfter.push(a);
      }
    }
  }

  const cs = pearson(stayerBefore, stayerAfter);
  const cm = pearson(moverBefore, moverAfter);
  console.log(
    `${config.label.padEnd(22)} ${cs.toFixed(3).padStart(6)} ${cm.toFixed(3).padStart(7)} ${(cs - cm).toFixed(3).padStart(6)} ${String(moverBefore.length).padStart(6)}`,
  );
}

console.log('\nstayers/movers = correlation between a player\'s rating before and after a cutoff.');
console.log('gap = how much of the rating fails to survive a change of team. Lower is more individual.');

await pool.end();
