/**
 * Integration test against the real local Postgres (docker-compose.yml at repo root).
 * Runs against whatever data is currently ingested -- this project has moved past the
 * "empty DB" bootstrap state, so these assert on shape/invariants rather than emptiness
 * or cold-start values, which no longer hold once real games have been ingested.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { createApp } from '../app.js';
import { createPool } from '../db.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://powerranking:powerranking@localhost:5433/powerranking';

describe('read API (live Postgres)', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    pool = createPool(DATABASE_URL);
    app = createApp(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('GET /leagues returns all 6 seeded leagues, ranked with plausible values', async () => {
    const res = await request(app).get('/leagues');
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(6);
    const slugs = res.body.map((l: { slug: string }) => l.slug).sort();
    expect(slugs).toEqual(['CBLOL', 'LCK', 'LCP', 'LCS', 'LEC', 'LPL']);
    for (const league of res.body) {
      expect(Number.isFinite(league.rating)).toBe(true);
      expect(league.rd).toBeGreaterThan(0);
      expect(league.rank).toBeGreaterThanOrEqual(1);
    }
    // ranks are a contiguous 1..6 permutation, sorted by rating descending
    const ranks = res.body.map((l: { rank: number }) => l.rank).sort((a: number, b: number) => a - b);
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('GET /teams requires a scope rather than defaulting to a global board', async () => {
    // There is no global team board by design -- ranking teams that never
    // played each other is the guess this structure removes.
    const res = await request(app).get('/teams');
    expect(res.status).toBe(400);
  });

  it('GET /teams?scope=LCK returns only that region, ranked by floor', async () => {
    const res = await request(app).get('/teams').query({ scope: 'LCK' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const team of res.body) {
      expect(team.leagueSlug).toBe('LCK');
      expect(Number.isFinite(team.rating)).toBe(true);
      expect(team.rd).toBeGreaterThan(0);
      expect(team.floor).toBeCloseTo(team.rating - team.rd, 6);
      expect(team.games).toBeGreaterThan(0);
    }
    const floors = res.body.map((t: { floor: number }) => t.floor);
    expect([...floors].sort((a: number, b: number) => b - a)).toEqual(floors);
    const ranks = res.body.map((t: { rank: number }) => t.rank);
    expect(ranks).toEqual([...Array(res.body.length).keys()].map((i) => i + 1));
  });

  it('GET /teams?scope=international spans regions and only rates teams with a record', async () => {
    const res = await request(app).get('/teams').query({ scope: 'international' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);

    const leagues = new Set(res.body.map((t: { leagueSlug: string }) => t.leagueSlug));
    expect(leagues.size).toBeGreaterThan(1);

    for (const team of res.body) {
      // The floor exists because nothing is rated internationally on a token
      // appearance -- see MIN_INTERNATIONAL_GAMES.
      expect(team.games).toBeGreaterThanOrEqual(10);
    }

    // Strictly a subset of the regions it draws from.
    const lck = await request(app).get('/teams').query({ scope: 'LCK' });
    const lckIntl = res.body.filter((t: { leagueSlug: string }) => t.leagueSlug === 'LCK');
    expect(lckIntl.length).toBeLessThanOrEqual(lck.body.length);
  });

  it('regional and international scopes disagree, because they measure different things', async () => {
    // Same team, two boards, two numbers. If these ever matched it would mean
    // one of the scopes had stopped being independent.
    const lck = await request(app).get('/teams').query({ scope: 'LCK' });
    const intl = await request(app).get('/teams').query({ scope: 'international' });
    const t1Regional = lck.body.find((t: { name: string }) => t.name === 'T1');
    const t1Intl = intl.body.find((t: { name: string }) => t.name === 'T1');
    expect(t1Regional).toBeDefined();
    expect(t1Intl).toBeDefined();
    expect(t1Regional.rating).not.toBeCloseTo(t1Intl.rating, 0);
  });

  it('GET /teams/:id returns 404 for a non-existent team', async () => {
    const res = await request(app).get('/teams/999999');
    expect(res.status).toBe(404);
  });

  it('GET /teams/:id returns 400 for a non-numeric id', async () => {
    const res = await request(app).get('/teams/not-a-number');
    expect(res.status).toBe(400);
  });

  it('GET /players returns ranked players with roles', async () => {
    const res = await request(app).get('/players');
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const player of res.body) {
      expect(['TOP', 'JNG', 'MID', 'BOT', 'SUP']).toContain(player.role);
      expect(Number.isFinite(player.rating)).toBe(true);
    }
  });

  it('GET /players?league=X scopes to that league and reports the regional scope', async () => {
    const res = await request(app).get('/players').query({ league: 'CBLOL' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const player of res.body) {
      expect(player.leagueSlug).toBe('CBLOL');
      expect(player.scope).toBe('regional');
    }
  });

  it('GET /players?scope=international returns a cross-league board of rated players only', async () => {
    const res = await request(app).get('/players').query({ scope: 'international' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);

    for (const player of res.body) {
      expect(player.scope).toBe('international');
      // The whole point of this scope: no international games, no claim. A
      // player only appears here if there is real evidence behind the number.
      expect(player.gamesPlayed).toBeGreaterThan(0);
      expect(Number.isFinite(player.rating)).toBe(true);
    }

    // It must genuinely mix regions -- if it collapsed to one league we would
    // be back to ranking by league prior rather than by head-to-head results.
    const leagues = new Set(res.body.map((p: { leagueSlug: string | null }) => p.leagueSlug));
    expect(leagues.size).toBeGreaterThan(1);

    // Strictly a subset of the regional board: everyone here plays somewhere.
    const regional = await request(app).get('/players');
    expect(res.body.length).toBeLessThan(regional.body.length);

    const ranks = res.body.map((p: { rank: number }) => p.rank);
    expect(ranks).toEqual([...Array(res.body.length).keys()].map((i) => i + 1));
  });

  it('GET /players ignores an unrecognised scope rather than serving a mis-scaled rating', async () => {
    const res = await request(app).get('/players').query({ scope: 'nonsense' });
    expect(res.status).toBe(200);
    for (const player of res.body) {
      expect(player.scope).toBe('regional');
    }
  });

  const STAT_KEYS = ['kills', 'deaths', 'assists', 'kda', 'csPerMin', 'goldDiff', 'killParticipation', 'damageShare', 'goldShare'];

  it('GET /players/:id returns a stat line placed against same-role peers', async () => {
    const board = await request(app).get('/players').query({ scope: 'international' });
    const top = board.body[0];

    const res = await request(app).get(`/players/${top.id}`).query({ scope: 'international' });
    expect(res.status).toBe(200);
    expect(res.body.handle).toBe(top.handle);

    const { stats } = res.body;
    expect(stats.wins + stats.losses).toBe(stats.games);
    expect(stats.winRate).toBeCloseTo(stats.wins / stats.games, 6);

    for (const key of STAT_KEYS) {
      const stat = stats[key];
      // A place without a value would be rank() placing a NULLS LAST row,
      // which reads as a genuine last and is not one.
      if (stat.value === null) {
        expect(stat.place).toBeNull();
      } else {
        expect(stat.place).toBeGreaterThanOrEqual(1);
        expect(stat.place).toBeLessThanOrEqual(res.body.peerCount);
      }
    }

    // The board's top player should place in the upper half of their own role
    // on the rating's own headline component.
    expect(stats.kda.place).toBeLessThan(res.body.peerCount / 2);
  });

  it('GET /teams/:id lists the individual series behind each record', async () => {
    const teams = await request(app).get('/teams').query({ scope: 'international' });
    const res = await request(app).get(`/teams/${teams.body[0].id}`);
    const row = res.body.international.find((r: { series: unknown[] }) => r.series.length > 0);
    expect(row).toBeDefined();

    // The listed series must reconcile with the aggregate above them, or the
    // expanded row is describing a different event than its own header.
    const won = row.series.filter((s: { won: boolean }) => s.won).length;
    expect(won).toBe(row.seriesWins);
    expect(row.series.length).toBe(row.seriesWins + row.seriesLosses);

    for (const s of row.series) {
      expect(s.won).toBe(s.ownScore > s.opponentScore);
      expect(s.opponent).toBeTruthy();
      expect(s.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      if (s.format !== null) expect(row.formats).toContain(s.format);
    }

    // Most recent first, matching the events above them.
    const dates = row.series.map((s: { date: string }) => s.date);
    expect(dates).toEqual([...dates].sort().reverse());
  });

  it('GET /players/:id reports a series record drawn from the same games', async () => {
    const board = await request(app).get('/players').query({ scope: 'international' });
    const top = board.body[0];

    const res = await request(app).get(`/players/${top.id}`).query({ scope: 'international' });
    const { stats } = res.body;
    const series = stats.seriesWins + stats.seriesLosses;

    // Every series holds at least one game, so it cannot outnumber the games
    // it was derived from -- and a player with games has played series.
    expect(series).toBeGreaterThan(0);
    expect(series).toBeLessThanOrEqual(stats.games);
    expect(stats.seriesWinRate).toBeCloseTo(stats.seriesWins / series, 6);

    // The two records disagree by design; what must hold is that they agree on
    // who won more often than not.
    expect(stats.seriesWinRate > 0.5).toBe(stats.winRate > 0.5);
  });

  it('GET /players/:id counts the same games the board Games column does', async () => {
    // These disagreed until ratings recorded their (league, role) group: the
    // column came from the one group the rating chose, the panel aggregated
    // every game the player had anywhere.
    const board = await request(app).get('/players').query({ league: 'LCS' });
    for (const row of board.body.slice(0, 12)) {
      const res = await request(app).get(`/players/${row.id}`);
      expect(res.status).toBe(200);
      expect(res.body.stats.games).toBe(row.gamesPlayed);
    }
  });

  it('GET /players/:id places against exactly the same-role rows on that board', async () => {
    // The denominator has to be countable on screen, so it is the board's own
    // same-role row count -- not "players with enough games", which silently
    // dropped fresh signings out of the total.
    const board = await request(app).get('/players').query({ league: 'LCS' });
    const top = board.body[0];
    const sameRole = board.body.filter((p: { role: string }) => p.role === top.role).length;

    const res = await request(app).get(`/players/${top.id}`);
    expect(res.body.peerCount).toBe(sameRole);
  });

  it('GET /players/:id measures a regional rank inside the player own league, not across all of them', async () => {
    const board = await request(app).get('/players').query({ league: 'LCK' });
    const top = board.body[0];

    const res = await request(app).get(`/players/${top.id}`);
    expect(res.status).toBe(200);
    expect(res.body.scope).toBe('regional');
    // Pooling every league would push an LCK player's rank far past 1, since
    // regional ratings are within-league percentiles and not comparable.
    expect(res.body.rank).toBe(top.rank);
  });

  it('GET /teams/:id breaks the record down by split and by international event', async () => {
    const board = await request(app).get('/teams').query({ scope: 'LCK' });
    const res = await request(app).get(`/teams/${board.body[0].id}`);
    expect(res.status).toBe(200);

    for (const row of [...res.body.regional, ...res.body.international]) {
      expect(row.wins + row.losses).toBeGreaterThan(0);
      // ::text in the query, so this stays an ISO date rather than becoming a
      // Date that stringifies as "Wed Apr 01".
      expect(row.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }

    // Newest first, both lists.
    for (const rows of [res.body.regional, res.body.international]) {
      const dates = rows.map((r: { startDate: string }) => r.startDate);
      expect(dates).toEqual([...dates].sort().reverse());
    }

    // The breakdown must reconcile with the board's own count for this scope,
    // or the page is telling two different stories about the same team.
    const regionalGames = res.body.regional.reduce((n: number, r: { wins: number; losses: number }) => n + r.wins + r.losses, 0);
    const intlGames = res.body.international.reduce((n: number, r: { wins: number; losses: number }) => n + r.wins + r.losses, 0);
    expect(regionalGames + intlGames).toBe(board.body[0].games);

    // Placements belong to internationals; we hold no regional standings.
    expect(res.body.regional.every((r: { placement: string | null }) => r.placement === null)).toBe(true);
  });

  it('GET /players?window= narrows the board to that stretch of play', async () => {
    const all = await request(app).get('/players').query({ league: 'LCK' });
    const year = await request(app).get('/players').query({ league: 'LCK', window: 'year' });
    const split = await request(app).get('/players').query({ league: 'LCK', window: 'split' });

    for (const [res, window] of [
      [all, 'all'],
      [year, 'year'],
      [split, 'split'],
    ] as const) {
      expect(res.status).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
      for (const player of res.body) expect(player.window).toBe(window);
    }

    // A window is a subset of the one containing it, player by player. The
    // board itself never shrinks -- an unrated player still holds their roster
    // spot at the neutral 50 -- so the games are what has to narrow.
    const gamesById = (body: { id: number; gamesPlayed: number }[]) =>
      new Map(body.map((p) => [p.id, p.gamesPlayed]));
    const allGames = gamesById(all.body);
    const yearGames = gamesById(year.body);
    for (const [id, games] of gamesById(split.body)) {
      expect(games).toBeLessThanOrEqual(yearGames.get(id) ?? 0);
    }
    for (const [id, games] of yearGames) {
      expect(games).toBeLessThanOrEqual(allGames.get(id) ?? 0);
    }
    // And it has to actually bite, or the filter is decoration.
    const totals = (m: Map<number, number>) => [...m.values()].reduce((a, b) => a + b, 0);
    expect(totals(gamesById(split.body))).toBeLessThan(totals(allGames));
  });

  it('GET /players?scope=international ignores the window, having only one', async () => {
    // International events are sparse enough that a split window would leave
    // nothing rated; asking for one must not return an empty board.
    const res = await request(app).get('/players').query({ scope: 'international', window: 'split' });
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    for (const player of res.body) expect(player.window).toBe('all');
  });

  it('GET /players/:id?window= counts the same games that window Games column does', async () => {
    // The panel has to describe the number above it: a split rating with a
    // career stat line under it is two different claims on one row.
    const board = await request(app).get('/players').query({ league: 'LCK', window: 'split' });
    for (const row of board.body.slice(0, 10)) {
      const res = await request(app).get(`/players/${row.id}`).query({ window: 'split' });
      expect(res.status).toBe(200);
      expect(res.body.window).toBe('split');
      expect(res.body.stats.games).toBe(row.gamesPlayed);
    }
  });

  it('GET /teams/:id reports the series record and the formats behind it', async () => {
    const board = await request(app).get('/teams').query({ scope: 'LCK' });
    const res = await request(app).get(`/teams/${board.body[0].id}`);

    for (const row of [...res.body.regional, ...res.body.international]) {
      expect(row.seriesWins + row.seriesLosses).toBeGreaterThan(0);
      // A series is at least one game long, and a series win needs a game win.
      expect(row.seriesWins + row.seriesLosses).toBeLessThanOrEqual(row.wins + row.losses);
      expect(row.seriesWins).toBeLessThanOrEqual(row.wins);

      // Lengths a series can actually have run to. "Bo4" is what reading
      // series.best_of gave us, and a 3-1 is a Bo5 that ended early.
      expect(row.formats.length).toBeGreaterThan(0);
      for (const format of row.formats) expect([1, 2, 3, 5, 7]).toContain(format);
      expect(row.formats).toEqual([...row.formats].sort((a: number, b: number) => a - b));
    }
  });

  it('never records a winner for a series that was never played', async () => {
    // Liquipedia reports a scheduled match as -1 to -1, and the ingest handed
    // that to whichever team was listed first. Invisible while everything
    // counted games; a free win the moment the team page counted series.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM series s
       WHERE s.winner_team_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM games g WHERE g.series_id = s.id)`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('GET /players/:id rejects a non-numeric id and 404s an unknown one', async () => {
    expect((await request(app).get('/players/not-a-number')).status).toBe(400);
    expect((await request(app).get('/players/99999999')).status).toBe(404);
  });
});
