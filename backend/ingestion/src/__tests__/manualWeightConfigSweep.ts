/**
 * Manual read-only sweep of whole weight configurations, not just the win
 * weight. Writes nothing.
 *
 * Answers the question the win-weight sweep cannot: how much of a board is
 * just team strength restated? Reported as `teamCorr` -- the correlation
 * between the rating a config produces and the player's own team win rate.
 * A board at 0.95 is a standings table with extra steps, whatever its
 * components are named.
 *
 * Held-out AUC comes from the same walk-forward design as
 * manualWinWeightAccuracySweep.ts, so the accuracy cost of decontaminating is
 * priced rather than assumed.
 */
import { createPool } from '../db.js';
import { buildPlayerGroupStats, selectGroupRatings, type PlayerGameRow } from '../computePlayerRatings.js';
import {
  componentWeights,
  componentWeightsForRole,
  componentWeightsForRoleAtWinWeight,
} from '@power-ranking/rating-engine';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const CUTOFFS = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01'];
const MIN_RATED_PER_TEAM = 4;
const NOTABLE = ['Faker', 'Chovy', 'Zeus', 'Keria', 'Oner', 'Ruler', 'Caps', 'Knight', 'Peyz'];

type Weights = ReturnType<typeof componentWeightsForRole>;

/** Drops the named components and rescales what is left back to 1. */
function without(base: Weights, drop: (keyof Weights)[]): Weights {
  const kept = Object.entries(base).filter(([component]) => !drop.includes(component as keyof Weights));
  const total = kept.reduce((sum, [, weight]) => sum + (weight ?? 0), 0);
  const out: Weights = {};
  for (const [component, weight] of kept) {
    out[component as keyof Weights] = total === 0 ? 0 : (weight ?? 0) / total;
  }
  return out;
}

const CONFIGS: { label: string; weightsFor: (role: string) => Weights }[] = [
  { label: 'shipped (default)', weightsFor: (r) => componentWeightsForRole(r) },
  // The model as it stood when 0.5 was chosen: uniform box score, no goldDiff,
  // csMin or objControl. The comparison kward asked for.
  { label: 'v2 uniform (win 0.50)', weightsFor: () => componentWeights(0.5) },
  { label: 'v3 per-role (win 0.50)', weightsFor: (r) => componentWeightsForRoleAtWinWeight(r, 0.5) },
  { label: 'win 0.40', weightsFor: (r) => componentWeightsForRoleAtWinWeight(r, 0.4) },
  { label: 'win 0.30', weightsFor: (r) => componentWeightsForRoleAtWinWeight(r, 0.3) },
  { label: 'no winRate', weightsFor: (r) => without(componentWeightsForRole(r), ['winRate']) },
  { label: 'no winRate/goldDiff', weightsFor: (r) => without(componentWeightsForRole(r), ['winRate', 'goldDiff']) },
  {
    label: 'no winRate/goldDiff/kda',
    weightsFor: (r) => without(componentWeightsForRole(r), ['winRate', 'goldDiff', 'kda']),
  },
];

const pool = createPool(DATABASE_URL);

interface StatRow extends PlayerGameRow {
  datetime_utc: string;
}

const stats = await pool.query<StatRow>(`
  WITH current_league AS (
    SELECT team_id, league_id FROM team_league_memberships WHERE end_date IS NULL
  )
  SELECT pgp.player_id, pgp.role, cl.league_id,
    (pgp.kills + pgp.assists)::numeric / GREATEST(pgp.deaths, 1) AS kda,
    pgp.gold_share, pgp.damage_share, pgp.kill_participation,
    pgp.creep_score * 60.0 / NULLIF(g.gamelength_seconds, 0) AS cs_min,
    pgp.gold_diff::numeric AS gold_diff,
    (CASE WHEN pgp.team_id = g.team1_id THEN g.team1_neutral_objectives ELSE g.team2_neutral_objectives END)::numeric
      / NULLIF(g.team1_neutral_objectives + g.team2_neutral_objectives, 0) AS obj_control,
    (g.winner_team_id = pgp.team_id) AS won,
    '0' AS age_days,
    g.datetime_utc::text AS datetime_utc
  FROM player_game_performance pgp
  JOIN games g ON g.id = pgp.game_id
  JOIN current_league cl ON cl.team_id = pgp.team_id
`);

const games = await pool.query<{
  id: number; day: string; league_id: number; team1_id: number; team2_id: number; winner_team_id: number;
}>(`
  SELECT g.id, g.datetime_utc::date::text AS day, t.canonical_league_id AS league_id,
         g.team1_id, g.team2_id, g.winner_team_id
    FROM games g
    JOIN series s ON s.id = g.series_id
    JOIN tournaments t ON t.id = s.tournament_id
   WHERE t.tournament_type <> 'international' AND t.canonical_league_id IS NOT NULL
   ORDER BY g.datetime_utc
`);

const lineups = await pool.query<{ game_id: number; team_id: number; player_id: number }>(
  `SELECT game_id, team_id, player_id FROM game_lineups`,
);
const handles = await pool.query<{ id: number; handle: string }>(`SELECT id, handle FROM players`);
const handleById = new Map(handles.rows.map((r) => [r.id, r.handle]));

const rosterByGameTeam = new Map<string, number[]>();
for (const row of lineups.rows) {
  const key = `${row.game_id}::${row.team_id}`;
  if (!rosterByGameTeam.has(key)) rosterByGameTeam.set(key, []);
  rosterByGameTeam.get(key)!.push(row.player_id);
}

const allGames = games.rows.map((g) => ({
  id: g.id,
  day: g.day,
  leagueId: g.league_id,
  team1Id: g.team1_id,
  team2Id: g.team2_id,
  won1: g.winner_team_id === g.team1_id ? 1 : 0,
}));
type Game = (typeof allGames)[number];

const DAY_MS = 86_400_000;

function rowsBefore(cutoff: string): PlayerGameRow[] {
  const cutoffMs = Date.parse(`${cutoff}T00:00:00Z`);
  const rows: PlayerGameRow[] = [];
  for (const row of stats.rows) {
    const playedMs = Date.parse(row.datetime_utc);
    if (playedMs < cutoffMs) rows.push({ ...row, age_days: String((cutoffMs - playedMs) / DAY_MS) });
  }
  return rows;
}

function rosterRating(game: Game, teamId: number, ratings: Map<string, number>): number | null {
  const roster = rosterByGameTeam.get(`${game.id}::${teamId}`) ?? [];
  const values = roster
    .map((playerId) => ratings.get(`${playerId}::${game.leagueId}`))
    .filter((v): v is number => v !== undefined);
  if (values.length < MIN_RATED_PER_TEAM) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function auc(scored: { gap: number; won1: number }[]): number {
  const n1 = scored.reduce((sum, s) => sum + s.won1, 0);
  const n2 = scored.length - n1;
  if (n1 === 0 || n2 === 0) return NaN;
  const sorted = [...scored].sort((a, b) => a.gap - b.gap);
  let rankSumWins = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].gap === sorted[i].gap) j += 1;
    const averageRank = (i + j + 2) / 2;
    for (let k = i; k <= j; k += 1) if (sorted[k].won1 === 1) rankSumWins += averageRank;
    i = j + 1;
  }
  return (rankSumWins - (n1 * (n1 + 1)) / 2) / (n1 * n2);
}

function corr(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

// Current-day profiles, for the contamination measure and the visible board.
// The cutoff must come from the data: a far-future one makes every game
// millions of days old, the recency weights underflow to zero, and every stat
// becomes NaN.
const newestGameDay = stats.rows.reduce((max, r) => (r.datetime_utc > max ? r.datetime_utc : max), '').slice(0, 10);
const CURRENT_CUTOFF = new Date(Date.parse(`${newestGameDay}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const currentRows = rowsBefore(CURRENT_CUTOFF);
const currentStats = buildPlayerGroupStats(currentRows);
const winRateByGroup = new Map(currentStats.map((s) => [`${s.playerId}::${s.leagueId}`, s.winRate]));

console.log(`${stats.rows.length} player-game rows, ${allGames.length} intra-league games\n`);
console.log('config                     teamCorr   heldOutAUC   Faker  Chovy  Knight  Peyz');

for (const { label, weightsFor } of CONFIGS) {
  const rated = selectGroupRatings(currentStats, 0.5, weightsFor);
  const xs: number[] = [];
  const ys: number[] = [];
  for (const r of rated) {
    const wr = winRateByGroup.get(`${r.playerId}::${r.leagueId}`);
    if (wr !== undefined) {
      xs.push(r.rating);
      ys.push(wr);
    }
  }
  const teamCorr = corr(xs, ys);

  const board = rated
    .filter((r) => r.isPrimary)
    .sort((a, b) => b.rating - a.rating)
    .map((r) => handleById.get(r.playerId) ?? `#${r.playerId}`);
  const rankOf = (handle: string) => {
    const i = board.indexOf(handle);
    return i === -1 ? '--' : String(i + 1);
  };

  let scoredAll: { gap: number; won1: number }[] = [];
  for (let i = 0; i < CUTOFFS.length; i += 1) {
    const cutoff = CUTOFFS[i];
    const next = CUTOFFS[i + 1] ?? CURRENT_CUTOFF;
    const ratings = new Map(
      selectGroupRatings(buildPlayerGroupStats(rowsBefore(cutoff)), 0.5, weightsFor).map((r) => [
        `${r.playerId}::${r.leagueId}`,
        r.rating,
      ]),
    );
    for (const game of allGames.filter((g) => g.day >= cutoff && g.day < next)) {
      const r1 = rosterRating(game, game.team1Id, ratings);
      const r2 = rosterRating(game, game.team2Id, ratings);
      if (r1 === null || r2 === null) continue;
      scoredAll.push({ gap: r1 - r2, won1: game.won1 });
    }
  }

  console.log(
    `${label.padEnd(26)} ${teamCorr.toFixed(3).padStart(6)}      ${auc(scoredAll).toFixed(4)}   ` +
      NOTABLE.filter((h) => ['Faker', 'Chovy', 'Knight', 'Peyz'].includes(h))
        .map((h) => rankOf(h).padStart(5))
        .join('  '),
  );
}

console.log(`\nteamCorr = correlation between the rating and the player's own team win rate.`);
await pool.end();
