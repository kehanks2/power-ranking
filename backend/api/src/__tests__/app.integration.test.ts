/**
 * Integration test against `TEST_DATABASE_URL`, a dump-and-restore clone of the
 * Neon database (`scripts/refreshTestDb.mjs`) -- so it asserts on shape and
 * invariants, not on emptiness or cold-start values, which stopped holding once
 * real games were ingested. Refresh the clone after an ingest or it reads stale.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { DEFAULT_TRANSFER_CARRYOVER, NEUTRAL_SCORE } from '@power-ranking/rating-engine';
import { createApp } from '../app.js';
import { createPool } from '../db.js';

describe('read API (live Postgres)', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    pool = createPool();
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

  it('rank changes reconcile: every drop on a board is matched by a rise', async () => {
    // A shared baseline makes the prior ranks a permutation of the current
    // ones, so the deltas cancel. Per-team baselines did not, and it showed.
    for (const scope of ['LCK', 'LEC', 'LPL', 'international']) {
      const res = await request(app).get('/teams').query({ scope });
      expect(res.status).toBe(200);
      const changes = res.body
        .map((t: { rankChange: number | null }) => t.rankChange)
        .filter((c: number | null): c is number => c !== null);
      expect(changes.reduce((sum: number, c: number) => sum + c, 0)).toBe(0);

      // All or nothing: a per-team dash leaves the rest unable to reconcile.
      expect(changes.length === 0 || changes.length === res.body.length).toBe(true);
    }
  });

  // The board names its baseline in the header, so a date beside a dashed row
  // would claim a comparison that row is not making, and a rated row without
  // one leaves the arrow unexplained.
  it('every rank change carries the day it measures from, and only those do', async () => {
    for (const scope of ['LCK', 'LEC', 'LPL', 'CBLOL', 'LCP', 'LCS', 'international']) {
      const teams = await request(app).get('/teams').query({ scope });
      const players = await request(app)
        .get('/players')
        .query(scope === 'international' ? { scope: 'international' } : { league: scope });
      for (const row of [...teams.body, ...players.body] as { rankChange: number | null; comparedTo: string | null }[]) {
        expect(row.comparedTo === null).toBe(row.rankChange === null);
        if (row.comparedTo !== null) expect(row.comparedTo).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
  });

  // One board, one prior board -- the date is a property of the comparison, not
  // of the row, so rows that were compared must all name the same day.
  it('a board measures every rank change from one day', async () => {
    for (const scope of ['LCK', 'CBLOL', 'LCP']) {
      for (const path of ['/teams', '/players']) {
        const res = await request(app)
          .get(path)
          .query(path === '/teams' ? { scope } : { league: scope });
        const days = new Set(
          (res.body as { comparedTo: string | null }[]).map((row) => row.comparedTo).filter((day) => day !== null),
        );
        expect(days.size).toBeLessThanOrEqual(1);
      }
    }
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

  it('GET /teams/:id gives each roster player the rating their own league board shows', async () => {
    const teams = await request(app).get('/teams').query({ scope: 'LCK' });
    const board = await request(app).get('/players').query({ league: 'LCK' });
    const byId = new Map(board.body.map((p: { id: number }) => [p.id, p]));

    let checked = 0;
    for (const team of teams.body.slice(0, 4)) {
      const res = await request(app).get(`/teams/${team.id}`);
      expect(res.status).toBe(200);

      for (const entry of res.body.roster) {
        // The roster draws the same range as the board, so a disagreement here
        // would show one player two different ratings on two pages.
        const onBoard = byId.get(entry.playerId) as { rating: number; rawRating: number; confidence: number } | undefined;
        if (!onBoard) continue;
        expect(entry.rating).toBeCloseTo(onBoard.rating, 6);
        expect(entry.rawRating).toBeCloseTo(onBoard.rawRating, 6);
        expect(entry.confidence).toBeCloseTo(onBoard.confidence, 6);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('GET /teams/:id ranks a roster player where the role-filtered board puts them', async () => {
    const board = await request(app).get('/players').query({ league: 'LCK' });
    // The board arrives rating-sorted, so filtering to a role gives the order
    // the roster's "2nd of 12" has to agree with.
    const byRole = new Map<string, number[]>();
    for (const p of board.body as { id: number; role: string }[]) {
      if (!byRole.has(p.role)) byRole.set(p.role, []);
      byRole.get(p.role)!.push(p.id);
    }

    const teams = await request(app).get('/teams').query({ scope: 'LCK' });
    let checked = 0;
    for (const team of teams.body.slice(0, 4)) {
      const res = await request(app).get(`/teams/${team.id}`);
      for (const entry of res.body.roster) {
        const peers = byRole.get(entry.role) ?? [];
        expect(entry.rolePeerCount).toBe(peers.length);
        expect(entry.roleRank).toBe(peers.indexOf(entry.playerId) + 1);
        expect(entry.roleRank).toBeGreaterThan(0);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('GET /players/:id ranks against same-role peers on whichever board is asked for', async () => {
    const board = await request(app).get('/players').query({ scope: 'international' });
    const top = board.body[0];

    for (const scope of ['international', 'regional'] as const) {
      const res = await request(app).get(`/players/${top.id}`).query({ scope });
      expect(res.status).toBe(200);
      expect(res.body.roleRank).toBeGreaterThan(0);
      // A rank past the peer group would mean the two came from different boards.
      expect(res.body.roleRank).toBeLessThanOrEqual(res.body.peerCount);
    }
  });

  it('GET /teams/:id flags exactly the roster players the international board rates', async () => {
    const teams = await request(app).get('/teams').query({ scope: 'LCK' });
    const intl = await request(app).get('/players').query({ scope: 'international' });
    const rated = new Set(intl.body.map((p: { id: number }) => p.id));

    let flagged = 0;
    let unflagged = 0;
    for (const team of teams.body) {
      const res = await request(app).get(`/teams/${team.id}`);
      for (const entry of res.body.roster) {
        expect(entry.hasInternational).toBe(rated.has(entry.playerId));
        if (entry.hasInternational) flagged += 1;
        else unflagged += 1;
      }
    }
    // Both cases must be present, or the flag is testing nothing: the panel
    // offers the international board only where one of these is true.
    expect(flagged).toBeGreaterThan(0);
    expect(unflagged).toBeGreaterThan(0);
  });

  it('names a second squad only where the roster row has no games to explain', async () => {
    // The board and the team page share one "no games here" marker, and the
    // second squad is the reason text it carries. A player who HAS played needs
    // no explanation, so naming another squad there would only mislead.
    // One league: a hosted database pays a round trip per query, and walking all
    // six teams-deep blows the 30s suite timeout.
    const teams = await request(app).get('/teams').query({ scope: 'LPL' });
    let checked = 0;
    let unplayed = 0;
    for (const team of teams.body) {
      const res = await request(app).get(`/teams/${team.id}`);
      for (const entry of res.body.roster) {
        expect(entry).toHaveProperty('alsoPlaysFor');
        if (entry.gamesPlayed > 0) expect(entry.alsoPlaysFor).toBeNull();
        else unplayed += 1;
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
    // Or the case the marker exists for is not in this league's data and the
    // test is only asserting the null branch.
    expect(unplayed).toBeGreaterThan(0);
  });

  it('serves the same rating and game count for a player on the board and on their team page', async () => {
    // The marker keys on gamesPlayed, so the two surfaces disagreeing would put
    // a mark on one and not the other for the same player.
    const board = await request(app).get('/players').query({ league: 'LPL' });
    const byId = new Map(
      board.body.map((p: { id: number; gamesPlayed: number; rating: number }) => [p.id, p]),
    );
    const teams = await request(app).get('/teams').query({ scope: 'LPL' });

    let compared = 0;
    for (const team of teams.body) {
      const res = await request(app).get(`/teams/${team.id}`);
      for (const entry of res.body.roster) {
        const onBoard = byId.get(entry.playerId) as { gamesPlayed: number; rating: number } | undefined;
        if (!onBoard) continue;
        expect(entry.gamesPlayed).toBe(onBoard.gamesPlayed);
        expect(entry.rating).toBeCloseTo(onBoard.rating, 6);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(0);
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

  it('GET /players reports the rating as a shrink of the raw score, not a bare number', async () => {
    const res = await request(app).get('/players').query({ league: 'LCK' });
    expect(res.status).toBe(200);

    // Most players are shrunk toward the neutral 50, but one with a record in
    // another league is shrunk toward a carryover anchor instead, which is why
    // the row is served these figures rather than deriving them from the rating.
    const anchorReach = 50 * DEFAULT_TRANSFER_CARRYOVER;

    let shrunk = 0;
    for (const player of res.body) {
      expect(player.confidence).toBeGreaterThanOrEqual(0);
      expect(player.confidence).toBeLessThan(1);
      expect(player.rawRating).toBeGreaterThanOrEqual(0);
      expect(player.rawRating).toBeLessThanOrEqual(100);

      // Invert rating = anchor + (raw - anchor) * confidence. The three figures
      // are mutually consistent only if that implies a legitimate anchor, and
      // every legitimate anchor is the neutral 50 or a carryover off it.
      const impliedAnchor = (player.rating - player.rawRating * player.confidence) / (1 - player.confidence);
      expect(impliedAnchor).toBeGreaterThanOrEqual(NEUTRAL_SCORE - anchorReach - 1e-6);
      expect(impliedAnchor).toBeLessThanOrEqual(NEUTRAL_SCORE + anchorReach + 1e-6);

      if (Math.abs(player.rawRating - player.rating) > 0.01) shrunk += 1;
    }
    expect(shrunk).toBeGreaterThan(0);
  });

  it('GET /players/:id names the stats that carry weight at the player role', async () => {
    const board = await request(app).get('/players').query({ league: 'LCK' });
    const byRole = new Map<string, number>();
    for (const player of board.body) if (!byRole.has(player.role)) byRole.set(player.role, player.id);

    for (const [role, id] of byRole) {
      const res = await request(app).get(`/players/${id}`);
      expect(res.status).toBe(200);
      const rated: string[] = res.body.ratedStats;

      // Every name has to be a stat the panel actually renders, or the fade
      // silently misses it.
      for (const key of rated) expect(res.body.stats[key]).toHaveProperty('place');
      // Raw K/D/A are the numbers behind KDA; none of them is rated anywhere.
      for (const key of ['kills', 'deaths', 'assists']) expect(rated).not.toContain(key);
      // Objective control is the jungle stat that motivated the fade: junglers
      // and supports rate it, the three lanes only show it.
      expect(rated.includes('objectiveControl')).toBe(role === 'JNG' || role === 'SUP');
    }
    expect(byRole.size).toBe(5);
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

  it('GET /players/:id never counts fewer games than the board Games column', async () => {
    // These disagreed until ratings recorded their (league, role) group: the
    // column came from the one group the rating chose, the panel aggregated
    // every game the player had anywhere. That part is fixed.
    //
    // They also disagreed while a board was stage-held: the column came from the
    // frozen generation and the panel was computed live, so the two differed by
    // exactly the games played since the hold -- LCS held at 2026-08-09 showed
    // CoreJJ 271 against the panel's 273, and LCK held at 2026-08-16 showed
    // Chovy 338 against 341. The panel now stops at the same held day, so
    // equality is the honest assertion again rather than a direction.
    const board = await request(app).get('/players').query({ league: 'LCS' });
    for (const row of board.body.slice(0, 12)) {
      const res = await request(app).get(`/players/${row.id}`);
      expect(res.status).toBe(200);
      expect(res.body.stats.games).toBe(row.gamesPlayed);
    }
  });

  it('narrows membership as the window narrows, so split is inside year is inside all', async () => {
    // A board is a list of who PLAYED over the window. The model writes a rating
    // row only for a group a player has games in, so a departed player drops off
    // 'split' while staying on 'year' and 'all'. Asserted as a set relation
    // rather than by naming players, which the next roster change would break.
    const ids = async (window: string) => {
      const res = await request(app).get('/players').query({ league: 'LCK', window });
      return new Set<number>(res.body.map((p: { id: number }) => p.id));
    };
    const [split, year, all] = [await ids('split'), await ids('year'), await ids('all')];

    expect(split.size).toBeGreaterThan(0);
    for (const id of split) expect(year.has(id)).toBe(true);
    for (const id of year) expect(all.has(id)).toBe(true);
    // Strictly narrowing, or the windows are not selecting anything and the
    // subset assertions above hold trivially.
    expect(all.size).toBeGreaterThan(year.size);
    expect(year.size).toBeGreaterThan(split.size);
  });

  it('carries only players currently in the league, and never labels them with another team', async () => {
    // kward's rule: a regional board answers "who is in this league NOW", so a
    // player who moved region leaves the old board entirely rather than
    // lingering on it with a note -- ranking him against the players actually
    // there was confusing and answered nothing.
    //
    // This asserted a departed player was PRESENT and merely unlabelled, which
    // was the rule before that call. A substitute is still kept for the split
    // his games are in, so the teamless rows below are current contributors and
    // every one of them must be able to say when he last played.
    const res = await request(app).get('/players').query({ league: 'LCK', window: 'all' });
    let teamless = 0;
    for (const p of res.body) {
      if (p.teamName) {
        // A rostered player has nowhere else to be and no past to report.
        expect(p.movedToTeam).toBeNull();
        expect(p.lastTeamName).toBeNull();
        continue;
      }
      teamless += 1;
      if (p.movedToTeam) expect(p.movedToLeague).not.toBeNull();
      // He is here because he played here this split, so the row can always name
      // the side he played for and the day he did it.
      expect(p.lastTeamName).not.toBeNull();
      expect(p.lastPlayedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(teamless).toBeGreaterThan(0);
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

    // The regional breakdown must reconcile with the regional board's count:
    // both are the same rolling window of the team's last six splits. The
    // international games are a separate story the regional board does not tell.
    const regionalGames = res.body.regional.reduce((n: number, r: { wins: number; losses: number }) => n + r.wins + r.losses, 0);
    expect(regionalGames).toBe(board.body[0].games);

    // Placements are populated where standings exist -- regional too, since the
    // placement import -- so each is a text finish or null, never anything else.
    expect(
      res.body.regional.every((r: { placement: string | null }) => r.placement === null || (typeof r.placement === 'string' && r.placement.length > 0)),
    ).toBe(true);
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
         AND (s.team1_score = -1 OR s.team2_score = -1)`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('a winner with no games is a real result awaiting its stat lines, not an invented one', async () => {
    // shouldWaitForStats withholds a finished series' GAMES over a publication
    // lag, so "has a winner but no games" is a legitimate transient state -- it
    // is what stops team and player ratings drifting apart. The invariant that
    // still has to hold is that the winner is the side the scoreline names.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM series s
       WHERE s.winner_team_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM games g WHERE g.series_id = s.id)
         AND s.winner_team_id IS DISTINCT FROM
             CASE WHEN s.team1_score > s.team2_score THEN s.team1_id ELSE s.team2_id END`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('GET /players/:id rejects a non-numeric id and 404s an unknown one', async () => {
    expect((await request(app).get('/players/not-a-number')).status).toBe(400);
    expect((await request(app).get('/players/99999999')).status).toBe(404);
  });
});
