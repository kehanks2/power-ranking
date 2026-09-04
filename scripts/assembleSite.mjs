/**
 * Lays the built app and the exported boards out as the directory Pages serves.
 *
 *   node scripts/assembleSite.mjs <app-dist> <data-dir> <out-dir>
 *
 * Pages has no rewrite rules, so a deep link only works if a file is actually
 * there. `404.html` catches everything and renders correctly, but it answers
 * 404 -- which is what a crawler and a link preview read. Every route the app
 * has is therefore also written as its own `index.html`, so a shared team page
 * answers 200. Both exist: the copies cover the routes we know, the 404 covers
 * a stale link to a team that has since left the boards.
 */
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const [appDist, dataDir, outDir] = process.argv.slice(2);
if (!appDist || !dataDir || !outDir) {
  console.error('usage: assembleSite.mjs <app-dist> <data-dir> <out-dir>');
  process.exit(1);
}

/** Routes without a parameter, from `rankings.routes.ts`. */
const STATIC_ROUTES = ['', 'rankings', 'rankings/teams', 'rankings/players', 'rankings/how-it-works'];

async function teamRoutes() {
  const entries = await readdir(join(dataDir, 'teams'), { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => `rankings/teams/${e.name}`);
}

await mkdir(outDir, { recursive: true });
await cp(appDist, outDir, { recursive: true });
await cp(dataDir, join(outDir, 'data'), { recursive: true });

const shell = await readFile(join(appDist, 'index.html'));
await writeFile(join(outDir, '404.html'), shell);

const routes = [...STATIC_ROUTES, ...(await teamRoutes())];
for (const route of routes) {
  const target = join(outDir, route, 'index.html');
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, shell);
}

console.log(`assembled ${routes.length} routes + 404.html into ${outDir}`);
