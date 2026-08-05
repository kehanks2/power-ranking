/**
 * Manual diagnostic (read-only): is the model over- or under-rating a region?
 *
 * Walk-forward over international cross-league games only. For each, use the
 * rating both teams held strictly BEFORE the game (no leakage), and compare
 * the predicted win probability against what actually happened, grouped by
 * league. A league whose actual win rate is well below its predicted one is
 * being over-rated by the model.
 */
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import {
  runReplay,
  combineContextualAndMeta,
  internationalParticipationFactor,
  GLICKO2_SCALE,
  DEFAULT_VOLATILITY,
  type ReplayInput,
} from '@power-ranking/rating-engine';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
const META_WEIGHT = 0.8;

const pool = createPool(DATABASE_URL);
const { teamIds, leagueIds, games, decayEvents } = await loadReplayData(pool);

// Cross-league games only ever happen at international events in this dataset
// (regional splits are single-league), so team1LeagueId !== team2LeagueId is
// the international filter -- no game-id join needed.
const leagueRows = await pool.query<{ id: string; slug: string }>('SELECT id::text, slug FROM leagues');
const slugByLeagueId = new Map(leagueRows.rows.map((r) => [r.id, r.slug]));

const result = runReplay({
  teamIds,
  leagueIds,
  games,
  decayEvents,
  config: {
    phiInitMax: PHI_INIT_MAX,
    sigmaDefault: DEFAULT_VOLATILITY,
    marginScale: 1e9,
    movWeightCap: 1.5,
    metaWeight: META_WEIGHT,
    seriesCorrelation: 0.8,
    ratingPeriodDays: 1,
  },
} as ReplayInput);

// Rating state as of each date, replayed forward.
const teamState = new Map<string, { mu: number; phi: number }>();
for (const id of teamIds) teamState.set(id, { mu: 0, phi: PHI_INIT_MAX });
const leagueState = new Map<string, { mu: number; phi: number }>();
for (const id of leagueIds) leagueState.set(id, { mu: 0, phi: PHI_INIT_MAX });

const teamSnapsByDate = new Map<string, typeof result.teamHistory>();
for (const s of result.teamHistory) {
  if (!teamSnapsByDate.has(s.asOfDate)) teamSnapsByDate.set(s.asOfDate, []);
  teamSnapsByDate.get(s.asOfDate)!.push(s);
}
const leagueSnapsByDate = new Map<string, typeof result.leagueHistory>();
for (const s of result.leagueHistory) {
  if (!leagueSnapsByDate.has(s.asOfDate)) leagueSnapsByDate.set(s.asOfDate, []);
  leagueSnapsByDate.get(s.asOfDate)!.push(s);
}
const allDates = [...new Set([...teamSnapsByDate.keys(), ...leagueSnapsByDate.keys()])].sort();

const stats = new Map<string, { predicted: number; actual: number; n: number }>();
const sortedGames = [...games].sort((a, b) => (a.datetimeUtc < b.datetimeUtc ? -1 : 1));
let dateCursor = 0;

for (const game of sortedGames) {
  const day = game.datetimeUtc.slice(0, 10);
  while (dateCursor < allDates.length && allDates[dateCursor] < day) {
    for (const s of teamSnapsByDate.get(allDates[dateCursor]) ?? []) teamState.set(s.teamId, { mu: s.mu, phi: s.phi });
    for (const s of leagueSnapsByDate.get(allDates[dateCursor]) ?? []) leagueState.set(s.leagueId, { mu: s.mu, phi: s.phi });
    dateCursor += 1;
  }

  if (game.team1LeagueId === game.team2LeagueId) continue;
  const lg1 = slugByLeagueId.get(game.team1LeagueId);
  const lg2 = slugByLeagueId.get(game.team2LeagueId);
  if (!lg1 || !lg2) continue;

  const combined = (teamId: string, leagueId: string) => {
    const t = teamState.get(teamId)!;
    const m = leagueState.get(leagueId)!;
    return combineContextualAndMeta(
      { ...t, sigma: DEFAULT_VOLATILITY },
      { ...m, sigma: DEFAULT_VOLATILITY },
      META_WEIGHT,
      PHI_INIT_MAX,
      internationalParticipationFactor(0),
    );
  };
  const c1 = combined(game.team1Id, game.team1LeagueId);
  const c2 = combined(game.team2Id, game.team2LeagueId);
  const p1 = 1 / (1 + Math.exp(-(c1.mu - c2.mu)));

  for (const [lg, p, won] of [
    [lg1, p1, game.winnerTeamId === game.team1Id ? 1 : 0],
    [lg2, 1 - p1, game.winnerTeamId === game.team2Id ? 1 : 0],
  ] as [string, number, number][]) {
    if (!stats.has(lg)) stats.set(lg, { predicted: 0, actual: 0, n: 0 });
    const s = stats.get(lg)!;
    s.predicted += p;
    s.actual += won;
    s.n += 1;
  }
}

console.log('Cross-league INTERNATIONAL games, walk-forward (no leakage)\n');
console.log('league  games   predicted%   actual%    gap');
const rows = [...stats].sort((a, b) => b[1].actual / b[1].n - a[1].actual / a[1].n);
for (const [lg, s] of rows) {
  const pred = (s.predicted / s.n) * 100;
  const act = (s.actual / s.n) * 100;
  const gap = act - pred;
  console.log(
    `${lg.padEnd(6)} ${String(s.n).padStart(5)}   ${pred.toFixed(1).padStart(8)}%  ${act.toFixed(1).padStart(7)}%  ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pp ${gap < -4 ? ' <- OVER-rated' : gap > 4 ? ' <- UNDER-rated' : ''}`,
  );
}

await pool.end();
