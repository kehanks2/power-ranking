/**
 * Manual read-only sweep of internationalWeightMultiplier: how much extra
 * weight international games (the only cross-region evidence, and a minority of
 * the schedule) should carry in the contextual update. Scored on predictive
 * accuracy and the resulting order of a watched set of teams.
 */
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import { runReplay, GLICKO2_SCALE, DEFAULT_VOLATILITY, type ReplayInput } from '@power-ranking/rating-engine';

const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
const MULTIPLIERS = [1, 1.5, 2, 3, 4];
const WATCH = ['Bilibili Gaming', 'T1', 'Hanwha Life Esports', 'Gen.G', 'KT Rolster', 'BNK FEARX', 'LYON', 'G2 Esports'];

const pool = createPool();
const { teamIds, leagueIds, games, decayEvents } = await loadReplayData(pool);
const nameRows = await pool.query<{ id: string; name: string; slug: string }>(`
  SELECT t.id::text, t.name, l.slug FROM teams t
  JOIN team_league_memberships m ON m.team_id=t.id AND m.end_date IS NULL
  JOIN leagues l ON l.id=m.league_id`);
const nameById = new Map(nameRows.rows.map((r) => [r.id, r.name]));
const leagueById = new Map(nameRows.rows.map((r) => [r.id, r.slug]));

const sorted = [...games].sort((a, b) => (a.datetimeUtc < b.datetimeUtc ? -1 : 1));

for (const multiplier of MULTIPLIERS) {
  const result = runReplay({
    teamIds,
    leagueIds,
    games: sorted,
    decayEvents,
    config: {
      phiInitMax: PHI_INIT_MAX,
      sigmaDefault: DEFAULT_VOLATILITY,
      marginScale: 1e9,
      movWeightCap: 1.5,
      metaWeight: 0.8,
      seriesCorrelation: 0.8,
      ratingPeriodDays: 1,
      internationalWeightMultiplier: multiplier,
    },
  } as ReplayInput);

  // Walk forward: predict each game from ratings strictly before its day.
  const mu = new Map<string, number>();
  for (const id of teamIds) mu.set(id, 0);
  const snapsByDate = new Map<string, typeof result.teamHistory>();
  for (const s of result.teamHistory) {
    if (!snapsByDate.has(s.asOfDate)) snapsByDate.set(s.asOfDate, []);
    snapsByDate.get(s.asOfDate)!.push(s);
  }
  const dates = [...snapsByDate.keys()].sort();
  let cursor = 0;
  let correct = 0;
  let total = 0;
  for (const game of sorted) {
    const day = game.datetimeUtc.slice(0, 10);
    while (cursor < dates.length && dates[cursor] < day) {
      for (const s of snapsByDate.get(dates[cursor])!) mu.set(s.teamId, s.mu);
      cursor += 1;
    }
    const m1 = mu.get(game.team1Id) ?? 0;
    const m2 = mu.get(game.team2Id) ?? 0;
    if (m1 === m2) continue;
    const predicted = m1 > m2 ? game.team1Id : game.team2Id;
    if (predicted === game.winnerTeamId) correct += 1;
    total += 1;
  }

  // Final contextual standing (contextual only -- the part this knob moves).
  const finalMu = new Map<string, number>();
  for (const s of result.teamHistory) finalMu.set(s.teamId, s.mu);
  const ranked = [...finalMu.entries()]
    .filter(([id]) => nameById.has(id))
    .sort((a, b) => b[1] - a[1]);
  const rankOf = new Map(ranked.map(([id], i) => [nameById.get(id)!, i + 1]));

  console.log(
    `multiplier ${multiplier.toFixed(1)}  accuracy ${((correct / total) * 100).toFixed(2)}%  ` +
      WATCH.map((n) => `${n.split(' ')[0]}#${rankOf.get(n) ?? '-'}`).join(' '),
  );
}

await pool.end();
