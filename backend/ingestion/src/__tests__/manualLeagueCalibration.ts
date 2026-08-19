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
  internationalEvidenceShrink,
  GLICKO2_SCALE,
  DEFAULT_VOLATILITY,
  type ReplayInput,
} from '@power-ranking/rating-engine';

// Compare how the league prior is applied. Each mode is a function of the
// team's own international history at that moment, walked forward.
const MODES: { label: string; metaWeight: number; factor: (d: number | null, g: number) => number }[] = [
  { label: 'metaWeight 0.50', metaWeight: 0.5, factor: (d) => internationalParticipationFactor(d) },
  { label: 'metaWeight 0.65', metaWeight: 0.65, factor: (d) => internationalParticipationFactor(d) },
  { label: 'metaWeight 0.80 (current)', metaWeight: 0.8, factor: (d) => internationalParticipationFactor(d) },
  { label: 'metaWeight 1.00', metaWeight: 1.0, factor: (d) => internationalParticipationFactor(d) },
  { label: 'metaWeight 1.20', metaWeight: 1.2, factor: (d) => internationalParticipationFactor(d) },
  {
    label: 'metaWeight 0.80 + evidence shrink (REJECTED)',
    metaWeight: 0.8,
    factor: (d, g) => internationalParticipationFactor(d) * internationalEvidenceShrink(g),
  },
];
const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
const META_WEIGHT = 0.8;

const pool = createPool();
const { teamIds, leagueIds, games, decayEvents } = await loadReplayData(pool);

// Cross-league games only happen at internationals here, so
// team1LeagueId !== team2LeagueId is the international filter.
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
    internationalWeightMultiplier: Number(process.env.INTL_MULT ?? 1),
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

console.log('Cross-league INTERNATIONAL games, walk-forward (no leakage)');

for (const mode of MODES) {
  const stats = new Map<string, { predicted: number; actual: number; n: number }>();
  const sortedGames = [...games].sort((a, b) => (a.datetimeUtc < b.datetimeUtc ? -1 : 1));
  let dateCursor = 0;

  // Reset replayed state for each mode.
  for (const id of teamIds) teamState.set(id, { mu: 0, phi: PHI_INIT_MAX });
  for (const id of leagueIds) leagueState.set(id, { mu: 0, phi: PHI_INIT_MAX });
  const intlGamesSoFar = new Map<string, number>();
  const lastIntlAt = new Map<string, string>();

  for (const game of sortedGames) {
    const day = game.datetimeUtc.slice(0, 10);
    while (dateCursor < allDates.length && allDates[dateCursor] < day) {
      for (const s2 of teamSnapsByDate.get(allDates[dateCursor]) ?? []) teamState.set(s2.teamId, { mu: s2.mu, phi: s2.phi });
      for (const s2 of leagueSnapsByDate.get(allDates[dateCursor]) ?? []) leagueState.set(s2.leagueId, { mu: s2.mu, phi: s2.phi });
      dateCursor += 1;
    }

    const isCrossLeague = game.team1LeagueId !== game.team2LeagueId;
    if (!isCrossLeague) continue;
    const lg1 = slugByLeagueId.get(game.team1LeagueId);
    const lg2 = slugByLeagueId.get(game.team2LeagueId);
    if (!lg1 || !lg2) continue;

    const combined = (teamId: string, leagueId: string) => {
      const t = teamState.get(teamId)!;
      const m = leagueState.get(leagueId)!;
      const last = lastIntlAt.get(teamId);
      const daysSince = last ? (Date.parse(day) - Date.parse(last)) / 86400000 : null;
      return combineContextualAndMeta(
        { ...t, sigma: DEFAULT_VOLATILITY },
        { ...m, sigma: DEFAULT_VOLATILITY },
        mode.metaWeight,
        PHI_INIT_MAX,
        mode.factor(daysSince, intlGamesSoFar.get(teamId) ?? 0),
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
      const st = stats.get(lg)!;
      st.predicted += p;
      st.actual += won;
      st.n += 1;
    }

    // Evidence accrues only AFTER the game is scored -- no leakage.
    for (const teamId of [game.team1Id, game.team2Id]) {
      intlGamesSoFar.set(teamId, (intlGamesSoFar.get(teamId) ?? 0) + 1);
      lastIntlAt.set(teamId, day);
    }
  }

  let absGap = 0;
  let brier = 0;
  let totalN = 0;
  const lines: string[] = [];
  for (const [lg, st] of [...stats].sort((a, b) => b[1].actual / b[1].n - a[1].actual / a[1].n)) {
    const pred = (st.predicted / st.n) * 100;
    const act = (st.actual / st.n) * 100;
    const gap = act - pred;
    absGap += Math.abs(gap) * st.n;
    totalN += st.n;
    lines.push(`    ${lg.padEnd(6)} ${String(st.n).padStart(4)}  pred ${pred.toFixed(1).padStart(5)}%  act ${act.toFixed(1).padStart(5)}%  ${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pp`);
  }
  console.log(`${mode.label}   [weighted mean |gap| ${(absGap / totalN).toFixed(2)}pp]`);
  for (const line of lines) console.log(line);
  console.log();
}

await pool.end();
