import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(REPO_ROOT, 'db', 'migrations');
const REFERENCE_FIXTURE = join(REPO_ROOT, 'db', 'fixtures', 'reference.sql');
const SAMPLE_FIXTURE = join(REPO_ROOT, 'db', 'fixtures', 'sample.sql');
const RATINGS_FIXTURE = join(REPO_ROOT, 'db', 'fixtures', 'ratings.sql');

/**
 * Fixed so vitest.config.ts can name the URL statically -- config `env` is
 * resolved synchronously at load, before globalSetup has started anything.
 */
export const PGLITE_PORT = 55432;

/**
 * The database name is what the client asks for, not something PGlite serves;
 * it exists to satisfy the *_test guard in testDatabaseUrl.mjs. No sslmode:
 * the socket server speaks plain postgres and rejects an SSLRequest.
 */
export const PGLITE_URL = `postgresql://postgres@127.0.0.1:${PGLITE_PORT}/powerranking_test`;

/** Numbered SQL applied by hand in production; from scratch, all of it in order. */
function migrationFiles() {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * `withRatings: false` is for buildRatingsFixture.ts, which GENERATES the board
 * data -- loading the previous generation first would both dump it back out and
 * fail its foreign keys whenever the sample slice changed underneath it.
 */
export async function startPgliteServer({ debug = false, withRatings = true } = {}) {
  const db = await PGlite.create();

  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (cause) {
      throw new Error(`migration ${file} failed against PGlite: ${cause.message}`, { cause });
    }
  }

  await db.exec(readFileSync(REFERENCE_FIXTURE, 'utf8'));
  // Real rows, because the suites assert on the shape of live data -- that no
  // rating window is empty, that the international pool is a strict subset.
  await db.exec(readFileSync(SAMPLE_FIXTURE, 'utf8'));
  // Boards are derived, so they are generated from the sample by the real
  // pipeline (buildRatingsFixture.ts) rather than carved out of a dump.
  if (withRatings) await db.exec(readFileSync(RATINGS_FIXTURE, 'utf8'));

  // PGlite runs one query at a time regardless; this only caps how many client
  // connections may sit open, and the pools across both workspaces want more
  // than the default of 1.
  const server = new PGLiteSocketServer({ db, port: PGLITE_PORT, host: '127.0.0.1', maxConnections: 20, debug });
  await server.start();

  return {
    url: PGLITE_URL,
    db,
    async stop() {
      await server.stop();
      await db.close();
    },
  };
}
