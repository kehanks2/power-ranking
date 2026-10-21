/**
 * Manual read-only sweep: a global board from the overall replay (every game,
 * contextual + league meta) at several meta weights. Scores each on the games of
 * the international window, predicting from the day before, and prints the
 * board by floor entering the newest event and now.
 *
 * Usage: npx tsx --env-file=../../.env src/__tests__/manualGlobalBoardWeightSweep.ts <board.json> [extraTeamIds]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import {
  runReplay,
  effectiveMetaWeight,
  internationalEvidenceShrink,
  g,
  GLICKO2_SCALE,
  DEFAULT_VOLATILITY,
  MARGIN_SCALE,
  MOV_WEIGHT_CAP,
  SERIES_CORRELATION,
  RATING_PERIOD_DAYS,
  INTERNATIONAL_WEIGHT_MULTIPLIER,
  type RatingState,
  type TeamRatingSnapshot,
  type LeagueRatingSnapshot,
} from '@power-ranking/rating-engine';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
const WEIGHTS = (process.env.WEIGHTS ?? '0,0.1,0.2,0.3,0.5,0.8').split(',').map(Number);
// Stretches the contextual rating at prediction time only, to test whether it is compressed.
const CTX_SCALE = Number(process.env.CTXSCALE ?? 1);
const INTL_MULTIPLIER = Number(process.env.INTLMULT ?? INTERNATIONAL_WEIGHT_MULTIPLIER);
// Per-team international deviation, in display points of starting RD; unset = off.
const DEVIATION_PHI = process.env.DEVPHI === undefined ? undefined : Number(process.env.DEVPHI) / GLICKO2_SCALE;
const CONTEXTUAL_LEARNS_INTERNATIONAL = process.env.CTXINTL !== 'false';
// Fades a team's league term with its own cross-region games; unset = off.
const SHRINK_HALF_LIFE = process.env.SHRINK === undefined ? undefined : Number(process.env.SHRINK);
// Half-life (days) of the international deviation's mean, and its roster-change reset.
const DEVIATION_HALF_LIFE = process.env.DEVHL === undefined ? undefined : Number(process.env.DEVHL);
const DEVIATION_ROSTER_RESET = process.env.DEVROSTER === 'true';
const WATCH = ['Karmine Corp', 'LYON', 'G2 Esports', 'BNK FEARX', 'T1', 'Dplus Kia', 'KT Rolster'];

const pool = createPool();
const { teamIds, leagueIds, games, decayEvents, internationalWindowStart } = await loadReplayData(
  pool,
  undefined,
  process.env.SUBDAYS === undefined ? undefined : Number(process.env.SUBDAYS),
);
const teamNames = new Map(
  (await pool.query<{ id: number; name: string }>('SELECT id, name FROM teams')).rows.map((r) => [String(r.id), r.name]),
);
const leagueNames = new Map(
  (await pool.query<{ id: number; name: string }>('SELECT id, name FROM leagues')).rows.map((r) => [String(r.id), r.name]),
);
const latestEventStart = (
  await pool.query<{ day: string }>(`
    SELECT min(g.datetime_utc AT TIME ZONE 'UTC')::date::text AS day
    FROM games g JOIN series s ON s.id = g.series_id
    WHERE s.tournament_id = (
      SELECT s2.tournament_id FROM games g2
      JOIN series s2 ON s2.id = g2.series_id JOIN tournaments t ON t.id = s2.tournament_id
      WHERE t.tournament_type = 'international'
      ORDER BY t.date_start DESC LIMIT 1
    )`)
).rows[0].day;
await pool.end();

const teamLeague = new Map<string, string>();
for (const game of games) {
  if (!game.team1LeagueId.startsWith('unknown:')) teamLeague.set(game.team1Id, game.team1LeagueId);
  if (!game.team2LeagueId.startsWith('unknown:')) teamLeague.set(game.team2Id, game.team2LeagueId);
}
// 'all' ranks every team with a game in the last 180 days, as a global board would.
const newestGame = games[games.length - 1].datetimeUtc;
const activeSince = new Date(Date.parse(newestGame) - 180 * 24 * 60 * 60 * 1000).toISOString();
const boardIds =
  process.argv[2] === 'all'
    ? [...new Set(games.filter((game) => game.datetimeUtc >= activeSince).flatMap((game) => [game.team1Id, game.team2Id]))]
    : [
        ...new Set([
          ...(JSON.parse(readFileSync(process.argv[2], 'utf8')) as { id: number }[]).map((row) => String(row.id)),
          ...(process.argv[3] ?? '').split(',').filter(Boolean),
        ]),
      ];
const printedRows = Number(process.env.ROWS ?? 14);
const evaluated = games.filter(
  (game) => game.internationalEvent && (internationalWindowStart === null || game.datetimeUtc >= internationalWindowStart),
);
const crossRegion = evaluated.filter((game) => game.team1LeagueId !== game.team2LeagueId);
const regionalRecent = games.filter(
  (game) => !game.internationalEvent && internationalWindowStart !== null && game.datetimeUtc >= internationalWindowStart,
);

function stateBefore<T extends { asOfDate: string }>(history: T[], day: string, isUpdate: (s: T) => boolean): T | undefined {
  let held: T | undefined;
  for (const s of history) {
    if (s.asOfDate > day || (s.asOfDate === day && isUpdate(s))) break;
    held = s;
  }
  return held;
}

const crossRegionDays = new Map<string, string[]>();
for (const game of games) {
  if (game.team1LeagueId === game.team2LeagueId) continue;
  for (const teamId of [game.team1Id, game.team2Id]) {
    if (!crossRegionDays.has(teamId)) crossRegionDays.set(teamId, []);
    crossRegionDays.get(teamId)!.push(game.datetimeUtc.slice(0, 10));
  }
}
const crossRegionGamesBefore = (teamId: string, day: string): number =>
  (crossRegionDays.get(teamId) ?? []).filter((d) => d < day).length;

const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;

console.log(`Scored on ${evaluated.length} international-event games (${crossRegion.length} cross-region) and ${regionalRecent.length} regional games since ${internationalWindowStart}\n`);

const rows: string[] = [];
// Per-game predictions by "weight:subset", written to DUMP for paired comparison across runs.
interface Prediction {
  p: number[];
  won: number[];
}
const dumped: Record<string, Prediction> = {};
for (const weight of WEIGHTS) {
  const result = runReplay({
    teamIds,
    leagueIds,
    games,
    decayEvents,
    config: {
      phiInitMax: PHI_INIT_MAX,
      sigmaDefault: DEFAULT_VOLATILITY,
      marginScale: MARGIN_SCALE,
      movWeightCap: MOV_WEIGHT_CAP,
      metaWeight: weight,
      seriesCorrelation: SERIES_CORRELATION,
      ratingPeriodDays: RATING_PERIOD_DAYS,
      internationalWeightMultiplier: INTL_MULTIPLIER,
      teamInternationalPhiInit: DEVIATION_PHI,
      contextualLearnsInternational: CONTEXTUAL_LEARNS_INTERNATIONAL,
      teamInternationalHalfLifeDays: DEVIATION_HALF_LIFE,
      playInWeight: process.env.PLAYIN === undefined ? undefined : Number(process.env.PLAYIN),
      teamInternationalRosterReset: DEVIATION_ROSTER_RESET,
      metaShrinkHalfLifeGames: SHRINK_HALF_LIFE,
    },
  });
  const deviationHistory = new Map<string, TeamRatingSnapshot[]>();
  for (const s of result.teamInternationalHistory ?? []) {
    if (!deviationHistory.has(s.teamId)) deviationHistory.set(s.teamId, []);
    deviationHistory.get(s.teamId)!.push(s);
  }
  const deviation = (teamId: string, day: string): RatingState => {
    if (DEVIATION_PHI === undefined) return { mu: 0, phi: 0, sigma: 0 };
    const held = stateBefore(deviationHistory.get(teamId) ?? [], day, () => true);
    if (!held) return { mu: 0, phi: DEVIATION_PHI, sigma: 0 };
    if (DEVIATION_HALF_LIFE === undefined) return held;
    const until = day > newestGame.slice(0, 10) ? newestGame.slice(0, 10) : day;
    const days = (Date.parse(until) - Date.parse(held.asOfDate)) / (24 * 60 * 60 * 1000);
    const retained = Math.pow(0.5, Math.max(0, days) / DEVIATION_HALF_LIFE);
    const phi = Math.sqrt(held.phi ** 2 * retained ** 2 + DEVIATION_PHI ** 2 * (1 - retained ** 2));
    return { ...held, mu: held.mu * retained, phi };
  };
  const teamHistory = new Map<string, TeamRatingSnapshot[]>();
  for (const s of result.teamHistory) {
    if (!teamHistory.has(s.teamId)) teamHistory.set(s.teamId, []);
    teamHistory.get(s.teamId)!.push(s);
  }
  const leagueHistory = new Map<string, LeagueRatingSnapshot[]>();
  for (const s of result.leagueHistory) {
    if (!leagueHistory.has(s.leagueId)) leagueHistory.set(s.leagueId, []);
    leagueHistory.get(s.leagueId)!.push(s);
  }
  const leagueOffset = (leagueId: string, day: string): RatingState & { w: number } => {
    const meta = stateBefore(leagueHistory.get(leagueId) ?? [], day, () => true);
    if (!meta) return { mu: 0, phi: 0, sigma: 0, w: 0 };
    return { ...meta, w: effectiveMetaWeight(meta, weight, PHI_INIT_MAX) };
  };
  const combined = (teamId: string, day: string, leagueId = teamLeague.get(teamId)!): RatingState => {
    const ctx = stateBefore(teamHistory.get(teamId)!, day, (s) => s.reason === 'game_update')!;
    const meta = leagueOffset(leagueId, day);
    const dev = deviation(teamId, day);
    const w = meta.w * (SHRINK_HALF_LIFE === undefined ? 1 : internationalEvidenceShrink(crossRegionGamesBefore(teamId, day), SHRINK_HALF_LIFE));
    return {
      mu: CTX_SCALE * ctx.mu + w * meta.mu + dev.mu,
      phi: Math.hypot(ctx.phi, w * meta.phi, dev.phi),
      sigma: ctx.sigma,
    };
  };
  // A same-league game is graded on contextual alone, as the engine grades it.
  const contextualBefore = (teamId: string, day: string) =>
    stateBefore(teamHistory.get(teamId)!, day, (s) => s.reason === 'game_update')!;
  const score = (label: string, set: typeof games) => {
    const brier: number[] = [];
    const correct: number[] = [];
    const predictions: Prediction = { p: [], won: [] };
    for (const game of set) {
      const day = game.datetimeUtc.slice(0, 10);
      const sameLeague = game.team1LeagueId === game.team2LeagueId;
      const a = sameLeague ? contextualBefore(game.team1Id, day) : combined(game.team1Id, day, game.team1LeagueId);
      const b = sameLeague ? contextualBefore(game.team2Id, day) : combined(game.team2Id, day, game.team2LeagueId);
      const p = 1 / (1 + Math.exp(-g(Math.hypot(a.phi, b.phi)) * (a.mu - b.mu)));
      const won = game.winnerTeamId === game.team1Id ? 1 : 0;
      brier.push((p - won) ** 2);
      correct.push(p === 0.5 ? 0.5 : (p > 0.5) === (won === 1) ? 1 : 0);
      predictions.p.push(p);
      predictions.won.push(won);
    }
    dumped[`${weight}:${label}`] = predictions;
    return `${mean(brier).toFixed(4)} ${(100 * mean(correct)).toFixed(1).padStart(5)}%`;
  };

  // The engine's own combinedHistory must agree with the combined() above on every team's final state.
  if (result.combinedHistory) {
    const engineFinal = new Map<string, TeamRatingSnapshot>();
    for (const s of result.combinedHistory) engineFinal.set(s.teamId, s);
    let worstMu = 0;
    let worstPhi = 0;
    for (const id of boardIds) {
      const engine = engineFinal.get(id);
      if (!engine) continue;
      const ours = combined(id, '9999-12-31');
      worstMu = Math.max(worstMu, Math.abs(engine.mu - ours.mu) * GLICKO2_SCALE);
      worstPhi = Math.max(worstPhi, Math.abs(engine.phi - ours.phi) * GLICKO2_SCALE);
    }
    rows.push(`  engine vs sweep combined, worst gap in display points: rating ${worstMu.toFixed(4)}, RD ${worstPhi.toFixed(4)}`);
  }

  // EXPLAINGAMES=Name prints that team's newest-event games: both sides' ratings going in and the win chance.
  for (const name of (process.env.EXPLAINGAMES ?? '').split(',').filter(Boolean)) {
    const id = boardIds.find((candidate) => teamNames.get(candidate) === name);
    if (!id) continue;
    for (const game of games) {
      if (!game.internationalEvent || game.datetimeUtc.slice(0, 10) < latestEventStart) continue;
      if (game.team1Id !== id && game.team2Id !== id) continue;
      const day = game.datetimeUtc.slice(0, 10);
      const ownIs1 = game.team1Id === id;
      const opponentId = ownIs1 ? game.team2Id : game.team1Id;
      const own = combined(id, day, ownIs1 ? game.team1LeagueId : game.team2LeagueId);
      const opp = combined(opponentId, day, ownIs1 ? game.team2LeagueId : game.team1LeagueId);
      const p = 1 / (1 + Math.exp(-g(Math.hypot(own.phi, opp.phi)) * (own.mu - opp.mu)));
      const won = game.winnerTeamId === id;
      rows.push(
        `  ${day} ${name} ${(1500 + own.mu * GLICKO2_SCALE).toFixed(0)} +-${(own.phi * GLICKO2_SCALE).toFixed(0)} vs ` +
          `${(teamNames.get(opponentId) ?? opponentId).padEnd(12)} ${(1500 + opp.mu * GLICKO2_SCALE).toFixed(0)} +-${(opp.phi * GLICKO2_SCALE).toFixed(0)}` +
          `  P(win) ${(100 * p).toFixed(0)}%  ${won ? 'W' : 'L'}`,
      );
    }
  }

  // EXPLAIN=Name,Name prints each part of those teams' current rating, in display points.
  for (const name of (process.env.EXPLAIN ?? '').split(',').filter(Boolean)) {
    const id = boardIds.find((candidate) => teamNames.get(candidate) === name);
    if (!id) continue;
    const day = '9999-12-31';
    const ctx = contextualBefore(id, day);
    const meta = leagueOffset(teamLeague.get(id)!, day);
    const fade = SHRINK_HALF_LIFE === undefined ? 1 : internationalEvidenceShrink(crossRegionGamesBefore(id, day), SHRINK_HALF_LIFE);
    const dev = deviation(id, day);
    const total = combined(id, day);
    const pts = (x: number) => (x * GLICKO2_SCALE).toFixed(0).padStart(5);
    rows.push(
      `  ${name.padEnd(14)} regional ${pts(ctx.mu)} +-${pts(ctx.phi)} | league ${pts(meta.w * meta.mu)} x fade ${fade.toFixed(2)} = ${pts(meta.w * fade * meta.mu)}` +
        ` | own intl ${pts(dev.mu)} +-${pts(dev.phi)} | rating ${(1500 + total.mu * GLICKO2_SCALE).toFixed(0)} +-${pts(total.phi)} floor ${(1500 + (total.mu - total.phi) * GLICKO2_SCALE).toFixed(0)}` +
        ` | ${crossRegionGamesBefore(id, day)} cross-region games`,
    );
    const steps = (deviationHistory.get(id) ?? []).map((s) => `${s.asOfDate} ${pts(s.mu).trim()}`);
    if (steps.length > 0) rows.push(`    own intl over time: ${steps.join(', ')}`);
  }

  const board = (day: string) =>
    boardIds
      .map((id) => {
        const s = combined(id, day);
        return { id, rating: 1500 + s.mu * GLICKO2_SCALE, rd: s.phi * GLICKO2_SCALE };
      })
      .sort((a, b) => b.rating - b.rd - (a.rating - a.rd));
  const before = board(latestEventStart);
  const now = board('9999-12-31');

  const offsets = leagueIds
    .map((id) => ({ name: leagueNames.get(id) ?? id, o: leagueOffset(id, '9999-12-31') }))
    .filter(({ o }) => o.mu !== 0)
    .map(({ name, o }) => `${name} ${(o.w * o.mu * GLICKO2_SCALE).toFixed(0)}`)
    .join('  ');

  rows.push(`metaWeight ${weight}`);
  rows.push(
    `  intl Brier/acc ${score('intl', evaluated)}   cross-region ${score('cross', crossRegion)}   regional ${score('regional', regionalRecent)}`,
  );
  rows.push(`  league offsets now: ${offsets}`);

  // Cross-region calibration: predicted vs actual win share, per league and per team.
  const tally = new Map<string, { n: number; predicted: number; won: number }>();
  const add = (key: string, p: number, won: number) => {
    const t = tally.get(key) ?? { n: 0, predicted: 0, won: 0 };
    tally.set(key, { n: t.n + 1, predicted: t.predicted + p, won: t.won + won });
  };
  for (const game of crossRegion) {
    const day = game.datetimeUtc.slice(0, 10);
    const a = combined(game.team1Id, day, game.team1LeagueId);
    const b = combined(game.team2Id, day, game.team2LeagueId);
    const p = 1 / (1 + Math.exp(-g(Math.hypot(a.phi, b.phi)) * (a.mu - b.mu)));
    const won = game.winnerTeamId === game.team1Id ? 1 : 0;
    add(`L:${leagueNames.get(game.team1LeagueId)}`, p, won);
    add(`L:${leagueNames.get(game.team2LeagueId)}`, 1 - p, 1 - won);
    add(`T:${teamNames.get(game.team1Id)}`, p, won);
    add(`T:${teamNames.get(game.team2Id)}`, 1 - p, 1 - won);
  }
  const fmt = (key: string) => {
    const t = tally.get(key)!;
    return `${key.slice(2)} ${t.n}g pred ${((100 * t.predicted) / t.n).toFixed(0)}% won ${((100 * t.won) / t.n).toFixed(0)}%`;
  };
  rows.push(`  leagues: ${[...tally.keys()].filter((k) => k.startsWith('L:')).map(fmt).join(' | ')}`);
  rows.push(
    `  teams (10+ cross-region games): ${[...tally.entries()]
      .filter(([k, t]) => k.startsWith('T:') && t.n >= 10)
      .sort((x, y) => y[1].predicted / y[1].n - y[1].won / y[1].n - (x[1].predicted / x[1].n - x[1].won / x[1].n))
      .map(([k]) => fmt(k))
      .join(' | ')}`,
  );
  for (const [label, rowsOf] of [
    ['board before', before],
    ['board now', now],
  ] as const) {
    rows.push(
      `  ${label}: ${rowsOf
        .slice(0, printedRows)
        .map((r, i) => `${i + 1}.${(teamNames.get(r.id) ?? r.id).replace(/ /g, '')}(${leagueNames.get(teamLeague.get(r.id)!)}) ${(r.rating - r.rd).toFixed(0)}`)
        .join(' ')}`,
    );
  }
  rows.push(
    `  watched (rank, rating before -> now): ${WATCH.map((name) => {
      const id = boardIds.find((candidate) => teamNames.get(candidate) === name);
      if (!id) return null;
      const b = before.findIndex((r) => r.id === id);
      const n = now.findIndex((r) => r.id === id);
      return `${name} ${b + 1}->${n + 1} (${before[b].rating.toFixed(0)}->${now[n].rating.toFixed(0)})`;
    })
      .filter(Boolean)
      .join(', ')}`,
  );
  rows.push('');
}
console.log(rows.join('\n'));
if (process.env.DUMP) writeFileSync(process.env.DUMP, JSON.stringify(dumped));
