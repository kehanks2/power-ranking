/**
 * Manual read-only runner: score whole model configurations jointly (parameters
 * tuned one at a time is how SERIES_CORRELATION went stale). Six metrics:
 *
 *   accuracy   did we pick the winner
 *   brier      squared error of the probability (lower is better)
 *   logloss    penalises confident mistakes hardest
 *   hiGap      >80%-confidence band: predicted minus actual (overconfidence)
 *   lgGap      per-league calibration on cross-league games, weighted mean |gap|
 *   spread     displayed / Bradley-Terry fitted league spread (1.00 = honest)
 *   medRD      median displayed team RD
 *
 * `metaCredit` is under test: the league meta is a prior, k / (k +
 * effectiveIntlGames), that fades as a team's own international record grows.
 */
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import {
  runReplay,
  effectiveMetaWeight,
  GLICKO2_SCALE,
  DEFAULT_VOLATILITY,
  type ReplayInput,
} from '@power-ranking/rating-engine';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
/** Bradley-Terry fitted league spread, from manualLeagueSpreadCheck. The yardstick. */
const FITTED_LEAGUE_SPREAD = 332;

export interface SweepConfig {
  label: string;
  metaWeight: number;
  seriesCorrelation: number;
  intlMultiplier: number;
  /** Games of a team's own international record at which the league prior is halved. Infinity = never shrink. */
  priorHalfLifeGames: number;
  /** Half-life in days for ageing that international record. Infinity = no ageing. */
  evidenceHalfLifeDays: number;
  ratingPeriodDays: number;
}

function metaCredit(effectiveIntlGames: number, priorHalfLifeGames: number): number {
  if (!Number.isFinite(priorHalfLifeGames)) return 1;
  if (priorHalfLifeGames <= 0) return 0;
  return priorHalfLifeGames / (priorHalfLifeGames + Math.max(0, effectiveIntlGames));
}

const pool = createPool(DATABASE_URL);
const { teamIds, leagueIds, games, decayEvents } = await loadReplayData(pool);
const leagueRows = await pool.query<{ id: string; slug: string }>('SELECT id::text, slug FROM leagues');
const slugByLeagueId = new Map(leagueRows.rows.map((r) => [r.id, r.slug]));
const sortedGames = [...games].sort((a, b) => (a.datetimeUtc < b.datetimeUtc ? -1 : 1));

function score(config: SweepConfig) {
  const result = runReplay({
    teamIds,
    leagueIds,
    games: sortedGames,
    decayEvents,
    config: {
      phiInitMax: PHI_INIT_MAX,
      sigmaDefault: DEFAULT_VOLATILITY,
      marginScale: 1e9,
      movWeightCap: 1.5,
      metaWeight: config.metaWeight,
      seriesCorrelation: config.seriesCorrelation,
      ratingPeriodDays: config.ratingPeriodDays,
      internationalWeightMultiplier: config.intlMultiplier,
    },
  } as ReplayInput);

  const teamState = new Map<string, { mu: number; phi: number }>();
  for (const id of teamIds) teamState.set(id, { mu: 0, phi: PHI_INIT_MAX });
  const leagueState = new Map<string, { mu: number; phi: number }>();
  for (const id of leagueIds) leagueState.set(id, { mu: 0, phi: PHI_INIT_MAX });

  const teamSnaps = new Map<string, typeof result.teamHistory>();
  for (const s of result.teamHistory) {
    if (!teamSnaps.has(s.asOfDate)) teamSnaps.set(s.asOfDate, []);
    teamSnaps.get(s.asOfDate)!.push(s);
  }
  const leagueSnaps = new Map<string, typeof result.leagueHistory>();
  for (const s of result.leagueHistory) {
    if (!leagueSnaps.has(s.asOfDate)) leagueSnaps.set(s.asOfDate, []);
    leagueSnaps.get(s.asOfDate)!.push(s);
  }
  const allDates = [...new Set([...teamSnaps.keys(), ...leagueSnaps.keys()])].sort();

  // Recency-weighted count of each team's own international games, walked forward.
  const intlEvidence = new Map<string, number>();
  const lastIntlDay = new Map<string, string>();
  const ageEvidence = (teamId: string, day: string) => {
    const last = lastIntlDay.get(teamId);
    if (!last) return intlEvidence.get(teamId) ?? 0;
    if (!Number.isFinite(config.evidenceHalfLifeDays)) return intlEvidence.get(teamId) ?? 0;
    const days = (Date.parse(day) - Date.parse(last)) / 86400000;
    return (intlEvidence.get(teamId) ?? 0) * Math.pow(0.5, days / config.evidenceHalfLifeDays);
  };

  const combined = (teamId: string, leagueId: string, day: string) => {
    const t = teamState.get(teamId)!;
    const m = leagueState.get(leagueId)!;
    const credit =
      effectiveMetaWeight({ ...m, sigma: DEFAULT_VOLATILITY }, config.metaWeight, PHI_INIT_MAX) *
      metaCredit(ageEvidence(teamId, day), config.priorHalfLifeGames);
    return { mu: t.mu + credit * m.mu, phi: Math.hypot(t.phi, credit * m.phi) };
  };

  let correct = 0;
  let n = 0;
  let brier = 0;
  let logloss = 0;
  let hiPred = 0;
  let hiAct = 0;
  let hiN = 0;
  const lgStats = new Map<string, { p: number; a: number; n: number }>();
  let cursor = 0;

  for (const game of sortedGames) {
    const day = game.datetimeUtc.slice(0, 10);
    while (cursor < allDates.length && allDates[cursor] < day) {
      for (const s of teamSnaps.get(allDates[cursor]) ?? []) teamState.set(s.teamId, { mu: s.mu, phi: s.phi });
      for (const s of leagueSnaps.get(allDates[cursor]) ?? []) leagueState.set(s.leagueId, { mu: s.mu, phi: s.phi });
      cursor += 1;
    }

    const c1 = combined(game.team1Id, game.team1LeagueId, day);
    const c2 = combined(game.team2Id, game.team2LeagueId, day);
    const gPhi = 1 / Math.sqrt(1 + (3 * (c1.phi * c1.phi + c2.phi * c2.phi)) / (Math.PI * Math.PI));
    const p1 = 1 / (1 + Math.exp(-gPhi * (c1.mu - c2.mu)));
    const won1 = game.winnerTeamId === game.team1Id ? 1 : 0;

    if (p1 !== 0.5) {
      if ((p1 > 0.5 ? 1 : 0) === won1) correct += 1;
      n += 1;
    }
    brier += (p1 - won1) ** 2;
    logloss += -(won1 * Math.log(Math.max(p1, 1e-9)) + (1 - won1) * Math.log(Math.max(1 - p1, 1e-9)));

    const conf = Math.max(p1, 1 - p1);
    if (conf > 0.8) {
      hiPred += conf;
      hiAct += (p1 > 0.5 ? 1 : 0) === won1 ? 1 : 0;
      hiN += 1;
    }

    if (game.team1LeagueId !== game.team2LeagueId) {
      for (const [lgId, p, w] of [
        [game.team1LeagueId, p1, won1],
        [game.team2LeagueId, 1 - p1, 1 - won1],
      ] as [string, number, number][]) {
        const slug = slugByLeagueId.get(lgId);
        if (!slug) continue;
        if (!lgStats.has(slug)) lgStats.set(slug, { p: 0, a: 0, n: 0 });
        const st = lgStats.get(slug)!;
        st.p += p;
        st.a += w;
        st.n += 1;
      }
    }

    // Evidence accrues only after the game is scored.
    if (game.team1LeagueId !== game.team2LeagueId) {
      for (const teamId of [game.team1Id, game.team2Id]) {
        intlEvidence.set(teamId, ageEvidence(teamId, day) + 1);
        lastIntlDay.set(teamId, day);
      }
    }
  }

  let lgAbs = 0;
  let lgN = 0;
  for (const st of lgStats.values()) {
    lgAbs += Math.abs((st.a / st.n - st.p / st.n) * 100) * st.n;
    lgN += st.n;
  }

  // Final displayed league offsets and team RDs.
  const finalLeague = new Map<string, { mu: number; phi: number }>();
  for (const s of result.leagueHistory) finalLeague.set(s.leagueId, { mu: s.mu, phi: s.phi });
  const offsets = [...finalLeague.values()].map(
    (m) => effectiveMetaWeight({ ...m, sigma: DEFAULT_VOLATILITY }, config.metaWeight, PHI_INIT_MAX) * m.mu * GLICKO2_SCALE,
  );
  const leagueSpread = Math.max(...offsets) - Math.min(...offsets);

  const finalPhi = new Map<string, number>();
  for (const s of result.teamHistory) finalPhi.set(s.teamId, s.phi * GLICKO2_SCALE);
  const rds = [...finalPhi.values()].sort((a, b) => a - b);

  return {
    accuracy: (correct / n) * 100,
    brier: brier / sortedGames.length,
    logloss: logloss / sortedGames.length,
    hiGap: hiN > 0 ? ((hiPred - hiAct) / hiN) * 100 : 0,
    lgGap: lgAbs / lgN,
    spreadRatio: leagueSpread / FITTED_LEAGUE_SPREAD,
    medRD: rds[Math.floor(rds.length / 2)],
  };
}

// Joint grid over the three knobs.
const CONFIGS: SweepConfig[] = [];
for (const metaWeight of [0.5, 0.65, 0.8, 1.0]) {
  for (const seriesCorrelation of [0, 0.2, 0.4, 0.6]) {
    for (const intlMultiplier of [1, 2, 3]) {
      CONFIGS.push({
        label: `mw=${metaWeight} rho=${seriesCorrelation} intl=${intlMultiplier}`,
        metaWeight,
        seriesCorrelation,
        intlMultiplier,
        priorHalfLifeGames: Infinity,
        evidenceHalfLifeDays: Infinity,
        ratingPeriodDays: 1,
      });
    }
  }
}

interface Scored extends SweepConfig { s: ReturnType<typeof score> }
const scored: Scored[] = CONFIGS.map((c) => ({ ...c, s: score(c) }));

// Brier is the primary criterion: a strictly proper scoring rule, unlike
// accuracy which only counts which side of 50% we landed on.
scored.sort((a, b) => a.s.brier - b.s.brier);

console.log('ALL CONFIGS BY BRIER (strictly proper scoring rule)');
console.log('config                    acc     brier   logloss  hiGap  lgGap  spread  medRD');
for (const r of scored) {
  console.log(
    `${r.label.padEnd(24)} ${r.s.accuracy.toFixed(2)}%  ${r.s.brier.toFixed(4)}  ${r.s.logloss.toFixed(4)}  ${r.s.hiGap.toFixed(1).padStart(5)}  ${r.s.lgGap.toFixed(2).padStart(5)}  ${r.s.spreadRatio.toFixed(2).padStart(5)}x  ${r.s.medRD.toFixed(0).padStart(4)}`,
  );
}
console.log();
console.log('WORST 3 BY BRIER');
for (const r of scored.slice(-3)) {
  console.log(
    `${r.label.padEnd(24)} ${r.s.accuracy.toFixed(2)}%  ${r.s.brier.toFixed(4)}  ${r.s.logloss.toFixed(4)}  ${r.s.hiGap.toFixed(1).padStart(5)}  ${r.s.lgGap.toFixed(2).padStart(5)}  ${r.s.spreadRatio.toFixed(2).padStart(5)}x  ${r.s.medRD.toFixed(0).padStart(4)}`,
  );
}

// Marginal effect of each knob, averaged over the others.
console.log();
console.log('MARGINAL EFFECT (mean Brier holding one knob, averaging the rest)');
for (const [name, get] of [
  ['metaWeight', (c: Scored) => c.metaWeight],
  ['seriesCorrelation', (c: Scored) => c.seriesCorrelation],
  ['intlMultiplier', (c: Scored) => c.intlMultiplier],
] as [string, (c: Scored) => number][]) {
  const groups = new Map<number, number[]>();
  for (const r of scored) {
    const k = get(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r.s.brier);
  }
  const parts = [...groups]
    .sort((a, b) => a[0] - b[0])
    .map(([k, v]) => `${k}: ${(v.reduce((x, y) => x + y, 0) / v.length).toFixed(4)}`);
  console.log(`  ${name.padEnd(18)} ${parts.join('   ')}`);
}

await pool.end();
