/**
 * The export is what visitors actually read -- the API server is not deployed --
 * so it is the surface that must not drift. Rather than restate the board
 * assertions in `app.integration.test.ts`, this asserts the exported file for
 * every document equals the response the API would have given, which makes
 * those 43 tests cover the export too.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import pg from 'pg';
import { RATING_WINDOWS } from '@power-ranking/shared';
import { createApp } from '../app.js';
import { createPool } from '../db.js';
import { dataPath, exportStatic, type ExportSummary } from '../exportStatic.js';

describe('static export', () => {
  let pool: pg.Pool;
  let app: ReturnType<typeof createApp>;
  let outDir: string;
  let summary: ExportSummary;
  let crestTeamId: number;

  // The fixture stores no crest bytes, so the export has none to file unless we
  // make one. Deliberately NOT the lowest id: `app.integration.test.ts` claims
  // that team for its own crest and nulls it again afterwards, and the two files
  // run at once.
  const PIXEL = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  beforeAll(async () => {
    pool = createPool();
    app = createApp(pool);

    const board = await request(app).get('/teams').query({ scope: 'international' });
    const lowest = await pool.query<{ id: number }>(`SELECT MIN(id) AS id FROM teams`);
    crestTeamId = board.body.find((t: { id: number }) => t.id !== lowest.rows[0].id).id;
    await pool.query(
      `UPDATE teams
          SET logo_url = 'https://example.test/export.png', logo_data = $2,
              logo_content_type = 'image/webp', logo_source_url = 'https://example.test/export.png'
        WHERE id = $1`,
      [crestTeamId, PIXEL],
    );

    outDir = await mkdtemp(join(tmpdir(), 'pr-export-'));
    summary = await exportStatic(pool, outDir);
  }, 300_000);

  afterAll(async () => {
    await pool.query(
      `UPDATE teams SET logo_url = NULL, logo_data = NULL, logo_content_type = NULL, logo_source_url = NULL
        WHERE id = $1`,
      [crestTeamId],
    );
    await pool.end();
    await rm(outDir, { recursive: true, force: true });
  });

  const readJson = async (relPath: string) => JSON.parse(await readFile(join(outDir, relPath), 'utf8'));

  const expectMatchesApi = async (relPath: string, url: string, query?: Record<string, string>) => {
    const res = query ? await request(app).get(url).query(query) : await request(app).get(url);
    expect(res.status).toBe(200);
    expect(await readJson(relPath)).toEqual(res.body);
  };

  it('exports the league list and the board freshness the API serves', async () => {
    await expectMatchesApi(dataPath.leagues(), '/leagues');
    await expectMatchesApi(dataPath.boardsUpdated(), '/boards/updated');
  });

  it('exports every team board byte-for-byte as the API gives it', async () => {
    const leagues = await readJson(dataPath.leagues());
    for (const scope of ['international', ...leagues.map((l: { slug: string }) => l.slug)]) {
      await expectMatchesApi(dataPath.teamBoard(scope), '/teams', { scope });
    }
  });

  it('exports every player board, one file per scope and window', async () => {
    const leagues = await readJson(dataPath.leagues());
    await expectMatchesApi(dataPath.playerBoard('international', 'all'), '/players', {
      scope: 'international',
    });
    for (const league of leagues) {
      for (const window of RATING_WINDOWS) {
        await expectMatchesApi(dataPath.playerBoard(league.slug, window), '/players', {
          league: league.slug,
          window,
        });
      }
    }
  });

  // Sampled rather than exhaustive: ~1,400 details each cost a request through
  // supertest as well as the file read, and the shapes are produced by one
  // function. What matters is that the scope and window reach it.
  it('exports a player detail scoped the same way the board that names it is', async () => {
    const leagues = await readJson(dataPath.leagues());
    const boards = [
      { scope: 'international', window: 'all' as const },
      ...RATING_WINDOWS.map((window) => ({ scope: leagues[0].slug, window })),
    ];
    for (const { scope, window } of boards) {
      const board = await readJson(dataPath.playerBoard(scope, window));
      expect(board.length).toBeGreaterThan(0);
      for (const player of board.slice(0, 3)) {
        const query =
          scope === 'international' ? { scope: 'international' } : { window };
        await expectMatchesApi(dataPath.playerDetail(player.id, scope, window), `/players/${player.id}`, query);
      }
    }
  });

  it('exports a detail for every team either board can link to', async () => {
    const leagues = await readJson(dataPath.leagues());
    const linked = new Set<number>();
    for (const scope of ['international', ...leagues.map((l: { slug: string }) => l.slug)]) {
      for (const team of await readJson(dataPath.teamBoard(scope))) linked.add(team.id);
    }
    for (const league of leagues) {
      for (const window of RATING_WINDOWS) {
        for (const player of await readJson(dataPath.playerBoard(league.slug, window))) {
          if (player.teamId !== null) linked.add(player.teamId);
        }
      }
    }
    expect(linked.size).toBeGreaterThan(0);
    for (const id of linked) {
      await expectMatchesApi(dataPath.teamDetail(id), `/teams/${id}`);
    }
  });

  // A crest is the one document whose name the DTO carries rather than this
  // module, so an export that files it elsewhere leaves a broken image.
  it('writes each crest at the path its own DTO advertises', async () => {
    const board = await readJson(dataPath.teamBoard('international'));
    const team = board.find((t: { id: number }) => t.id === crestTeamId);
    expect(team.logoUrl).not.toBeNull();

    const [path, query] = team.logoUrl.replace(/^\//, '').split('?');
    expect(path).toBe(`teams/${crestTeamId}/logo.webp`);
    expect(query).toMatch(/^v=[0-9a-f]{8}$/);
    expect(await readFile(join(outDir, path))).toEqual(PIXEL);

    // The team page names the same crest as the board does, or one of the two
    // spends a request on a file that was never written.
    const detail = await readJson(dataPath.teamDetail(crestTeamId));
    expect(detail.logoUrl).toBe(team.logoUrl);
  });

  // A stray file is a deploy that publishes something nobody reviewed, and the
  // count is what the workflow logs, so both are worth pinning.
  it('writes nothing outside the documents it declares', async () => {
    const shapes = [
      /^leagues\.json$/,
      /^boards-updated\.json$/,
      /^teams\/[A-Za-z]\w*\.json$/,
      /^teams\/\d+\/detail\.json$/,
      /^teams\/\d+\/logo\.(webp|png|jpg|gif|svg)$/,
      /^players\/[A-Za-z]\w*\/(all|year|split)\.json$/,
      /^players\/\d+\/[A-Za-z]\w*\/(all|year|split)\.json$/,
    ];
    const walk = async (dir: string, prefix = ''): Promise<string[]> => {
      const entries = await readdir(join(outDir, dir), { withFileTypes: true });
      const found = await Promise.all(
        entries.map((e) =>
          e.isDirectory()
            ? walk(join(dir, e.name), `${prefix}${e.name}/`)
            : Promise.resolve([`${prefix}${e.name}`]),
        ),
      );
      return found.flat();
    };
    const written = await walk('.');
    expect(written.length).toBe(summary.files);
    expect(written.filter((f) => !shapes.some((s) => s.test(f)))).toEqual([]);
  });
});
