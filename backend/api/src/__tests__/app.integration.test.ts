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

  it('GET /players/:id rejects a non-numeric id and 404s an unknown one', async () => {
    expect((await request(app).get('/players/not-a-number')).status).toBe(400);
    expect((await request(app).get('/players/99999999')).status).toBe(404);
  });
});
