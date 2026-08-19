import { PGLITE_URL } from './pgliteTestServer.mjs';

/**
 * True unless someone deliberately pointed the suites at a real server.
 *
 * Only the ENVIRONMENT is consulted, never `.env`. Reading `.env` is what
 * silently sent every test run at the hosted database: 26 files, three of them
 * driving full 59k-row recomputes, and the month's 5 GB transfer allowance was
 * gone in three days. Opting out is a thing you do per-run, on purpose.
 */
export function usingPglite() {
  return !process.env.TEST_DATABASE_URL;
}

/**
 * Resolves the database the test suites run against. Defaults to in-process
 * PGlite: no network, no server, nothing to keep in sync.
 *
 * The suites wipe and rebuild the rating tables with no per-test scoping, so a
 * wrong value here destroys real ratings -- which is how an ingested generation
 * of player_ratings_history was lost. Hence the *_test name check on the
 * opt-out path, and never a fallback to whatever DATABASE_URL happens to be set.
 */
export function testDatabaseUrl() {
  if (usingPglite()) return PGLITE_URL;

  const url = process.env.TEST_DATABASE_URL;
  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${name}": the suites wipe and rebuild the rating tables, ` +
        'so TEST_DATABASE_URL must name a database ending in _test.',
    );
  }

  return url;
}
