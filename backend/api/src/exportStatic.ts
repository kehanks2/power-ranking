import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Pool } from 'pg';
import { RATING_WINDOWS, type RatingWindow } from '@power-ranking/shared';
import { createPool } from './db.js';
import {
  getBoardsLastUpdated,
  getLeagues,
  getPlayerById,
  getPlayers,
  getTeamById,
  getTeamLogo,
  getTeams,
} from './repositories.js';

/**
 * Where each document lives under the data root. The frontend mirrors this the
 * way `models.ts` mirrors the DTOs -- it cannot import from a backend workspace
 * -- so a change here is a change there, and `exportStatic.test.ts` fails if the
 * two drift.
 */
export const dataPath = {
  leagues: () => 'leagues.json',
  boardsUpdated: () => 'boards-updated.json',
  teamBoard: (scope: string) => `teams/${scope}.json`,
  teamDetail: (id: number) => `teams/${id}/detail.json`,
  playerBoard: (scope: string, window: RatingWindow) => `players/${scope}/${window}.json`,
  playerDetail: (id: number, scope: string, window: RatingWindow) =>
    `players/${id}/${scope}/${window}.json`,
};

/**
 * The international board is one pool, not one per window, so its documents are
 * filed under a single window rather than written three times.
 */
const INTERNATIONAL_WINDOW: RatingWindow = 'all';

/**
 * Do NOT raise this to use more of Aiven's 20 connections. The usual rule here
 * is that round trips are the cost, but these are analytic queries against a
 * free-plan instance with very little CPU, and widening the export made it
 * dramatically slower: 12 deep wrote 64 documents in the time 4 deep wrote 984.
 * pg's pool is capped at 4 anyway, so this only decides how deep the queue runs.
 */
const CONCURRENCY = 8;

async function eachLimited<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (next < items.length) {
      await run(items[next++]);
    }
  });
  await Promise.all(workers);
}

export interface ExportSummary {
  files: number;
  bytes: number;
}

export async function exportStatic(pool: Pool, outDir: string): Promise<ExportSummary> {
  const summary: ExportSummary = { files: 0, bytes: 0 };

  const write = async (relPath: string, body: Buffer | string) => {
    const target = join(outDir, relPath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
    summary.files += 1;
    summary.bytes += Buffer.byteLength(body);
  };
  const writeJson = (relPath: string, value: unknown) => write(relPath, JSON.stringify(value));

  const leagues = await getLeagues(pool);
  await writeJson(dataPath.leagues(), leagues);
  await writeJson(dataPath.boardsUpdated(), await getBoardsLastUpdated(pool));

  const teamIds = new Set<number>();
  const teamScopes = ['international', ...leagues.map((l) => l.slug)];
  for (const scope of teamScopes) {
    const board = await getTeams(pool, scope);
    for (const team of board) teamIds.add(team.id);
    await writeJson(dataPath.teamBoard(scope), board);
  }

  // Every (scope, window) the boards actually publish. A player detail is
  // written per combination the player appears in, because the stat line is
  // measured over the same games the rating was -- an international row is not
  // a regional row with a different heading.
  const playerBoards: Array<{ scope: string; window: RatingWindow }> = [
    { scope: 'international', window: INTERNATIONAL_WINDOW },
    ...leagues.flatMap((l) => RATING_WINDOWS.map((window) => ({ scope: l.slug, window }))),
  ];

  const playerDocs: Array<{ id: number; scope: string; window: RatingWindow }> = [];
  for (const { scope, window } of playerBoards) {
    const board = await getPlayers(
      pool,
      scope === 'international' ? undefined : scope,
      scope === 'international' ? 'international' : 'regional',
      window,
    );
    for (const player of board) {
      playerDocs.push({ id: player.id, scope, window });
      if (player.teamId !== null) teamIds.add(player.teamId);
    }
    await writeJson(dataPath.playerBoard(scope, window), board);
  }

  await eachLimited(playerDocs, async ({ id, scope, window }) => {
    const detail = await getPlayerById(
      pool,
      id,
      scope === 'international' ? 'international' : 'regional',
      window,
    );
    if (detail) await writeJson(dataPath.playerDetail(id, scope, window), detail);
  });

  // After the player boards, which are what turn a rostered team into a linked
  // one: a team page is reachable from either board.
  await eachLimited([...teamIds], async (id) => {
    const detail = await getTeamById(pool, id);
    if (!detail) return;
    await writeJson(dataPath.teamDetail(id), detail);
    if (!detail.logoUrl) return;
    const logo = await getTeamLogo(pool, id);
    // The DTO already names the file, extension and all; the `?v=` digest is
    // cache-busting on the URL and not part of the path.
    if (logo) await write(detail.logoUrl.split('?')[0].replace(/^\//, ''), logo.data);
  });

  return summary;
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('usage: exportStatic <out-dir>');
    process.exit(1);
  }
  const pool = createPool();
  try {
    const { files, bytes } = await exportStatic(pool, outDir);
    console.log(`wrote ${files} files, ${(bytes / 1024 / 1024).toFixed(1)} MB to ${outDir}`);
  } finally {
    await pool.end();
  }
}
