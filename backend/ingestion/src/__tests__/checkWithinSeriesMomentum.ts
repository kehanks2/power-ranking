/**
 * Controlled version of checkSeriesRubberBand.ts.
 *
 * Raw finding there: the previous game's loser wins only ~44% of the next
 * game. But that is confounded -- the previous loser is usually just the
 * weaker team, so strength, not the side/pick choice, could explain all of it.
 *
 * This asks the properly controlled question: AFTER accounting for the rating
 * gap the model already knows about, does the previous game's result still
 * carry information? Structurally the model cannot see it either way -- every
 * game in a series shares the series date, so it lands in one rating period
 * and receives one identical prediction for all of games 1..5.
 *
 * If prev-game winners systematically beat their predicted probability and
 * prev-game losers fall short of it, there is real within-series state
 * (momentum / draft adaptation / tilt) that is exploitable and currently
 * invisible to the engine.
 */
import { createPool } from '../db.js';
import { loadReplayData } from '../replayData.js';
import { runReplay, combineContextualAndMeta, E, type ReplayGame } from '@power-ranking/rating-engine';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';
const GLICKO2_SCALE = 173.7178;
const PHI_INIT_MAX = 350 / GLICKO2_SCALE;
const META_WEIGHT = 0.65;

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
function weekBucket(dateIso: string): string {
  const epochWeek = Math.floor(new Date(dateIso).getTime() / MS_PER_WEEK);
  return new Date(epochWeek * MS_PER_WEEK).toISOString().slice(0, 10);
}
function buildSnapshotLookup<T extends { asOfDate: string; mu: number; phi: number }>(rows: T[], keyOf: (r: T) => string) {
  const byKey = new Map<string, { asOfDate: string; mu: number; phi: number }[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push({ asOfDate: row.asOfDate, mu: row.mu, phi: row.phi });
  }
  return byKey;
}
function snapshotBefore(snaps: { asOfDate: string; mu: number; phi: number }[] | undefined, period: string) {
  if (!snaps) return { mu: 0, phi: PHI_INIT_MAX };
  let result = { mu: 0, phi: PHI_INIT_MAX };
  for (const s of snaps) {
    if (s.asOfDate < period) result = s;
    else break;
  }
  return result;
}

async function main() {
  const pool = createPool(DATABASE_URL);
  const { teamIds, leagueIds, games, decayEvents } = await loadReplayData(pool);

  // Same ORDER BY as loadReplayData so index i lines up with games[i].
  const meta = await pool.query<{ series_id: number; game_number: number }>(`
    SELECT g.series_id, g.game_number
    FROM games g
    JOIN team_league_memberships tlm1 ON tlm1.team_id = g.team1_id AND tlm1.end_date IS NULL
    JOIN team_league_memberships tlm2 ON tlm2.team_id = g.team2_id AND tlm2.end_date IS NULL
    ORDER BY g.datetime_utc
  `);
  if (meta.rows.length !== games.length) {
    console.warn(`WARN: meta rows ${meta.rows.length} != games ${games.length}`);
  }

  const result = runReplay({
    teamIds,
    leagueIds,
    games,
    decayEvents,
    config: { phiInitMax: PHI_INIT_MAX, sigmaDefault: 0.06, marginScale: 15, movWeightCap: 1.5, metaWeight: META_WEIGHT },
  });
  const teamSnaps = buildSnapshotLookup(result.teamHistory, (r) => r.teamId);
  const leagueSnaps = buildSnapshotLookup(result.leagueHistory, (r) => r.leagueId);

  interface Entry { game: ReplayGame; seriesId: number; gameNumber: number; p1: number }
  const entries: Entry[] = [];
  for (const [i, game] of (games as ReplayGame[]).entries()) {
    const m = meta.rows[i];
    if (!m) continue;
    const period = weekBucket(game.datetimeUtc);
    const t1 = snapshotBefore(teamSnaps.get(game.team1Id), period);
    const t2 = snapshotBefore(teamSnaps.get(game.team2Id), period);
    const l1 = snapshotBefore(leagueSnaps.get(game.team1LeagueId), period);
    const l2 = snapshotBefore(leagueSnaps.get(game.team2LeagueId), period);
    const c1 = combineContextualAndMeta({ mu: t1.mu, phi: t1.phi, sigma: 0.06 }, { mu: l1.mu, phi: l1.phi, sigma: 0.06 }, META_WEIGHT, PHI_INIT_MAX);
    const c2 = combineContextualAndMeta({ mu: t2.mu, phi: t2.phi, sigma: 0.06 }, { mu: l2.mu, phi: l2.phi, sigma: 0.06 }, META_WEIGHT, PHI_INIT_MAX);
    const p1 = E(c1.mu, c2.mu, Math.hypot(c1.phi, c2.phi));
    entries.push({ game, seriesId: m.series_id, gameNumber: m.game_number, p1 });
  }

  const bySeries = new Map<number, Entry[]>();
  for (const e of entries) {
    if (!bySeries.has(e.seriesId)) bySeries.set(e.seriesId, []);
    bySeries.get(e.seriesId)!.push(e);
  }

  const wonPrev = { predSum: 0, actual: 0, n: 0 };
  const lostPrev = { predSum: 0, actual: 0, n: 0 };

  for (const seriesGames of bySeries.values()) {
    if (seriesGames.length < 2) continue;
    seriesGames.sort((a, b) => a.gameNumber - b.gameNumber);
    for (let i = 1; i < seriesGames.length; i++) {
      const prev = seriesGames[i - 1];
      const cur = seriesGames[i];
      // Evaluate from team1's perspective for this game.
      const team1WonPrev = prev.game.winnerTeamId === cur.game.team1Id;
      const team1WonNow = cur.game.winnerTeamId === cur.game.team1Id ? 1 : 0;
      const bucket = team1WonPrev ? wonPrev : lostPrev;
      bucket.predSum += cur.p1;
      bucket.actual += team1WonNow;
      bucket.n += 1;
    }
  }

  console.log('=== Within-series momentum, CONTROLLING for what the model already knows ===');
  console.log('The model gives one identical prediction for every game in a series,');
  console.log('so any gap here is signal it is structurally blind to.\n');
  for (const [label, b] of [['Team WON previous game ', wonPrev], ['Team LOST previous game', lostPrev]] as const) {
    const pred = (100 * b.predSum) / b.n;
    const act = (100 * b.actual) / b.n;
    const se = 100 * Math.sqrt(((act / 100) * (1 - act / 100)) / b.n);
    console.log(
      `${label}: model predicted ${pred.toFixed(2)}%, actually won ${act.toFixed(2)}%  ` +
        `=> edge ${(act - pred >= 0 ? '+' : '') + (act - pred).toFixed(2)}pp (+/- ${(1.96 * se).toFixed(2)}pp)  n=${b.n}`,
    );
  }
  const spread = (100 * wonPrev.actual) / wonPrev.n - (100 * wonPrev.predSum) / wonPrev.n
    - ((100 * lostPrev.actual) / lostPrev.n - (100 * lostPrev.predSum) / lostPrev.n);
  console.log(`\nSpread between the two groups: ${spread.toFixed(2)}pp of unexplained signal.`);

  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
