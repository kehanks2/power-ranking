import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function fromDotEnv() {
  try {
    const line = readFileSync(join(REPO_ROOT, '.env'), 'utf8')
      .split(/\r?\n/)
      .find((l) => l.startsWith('TEST_DATABASE_URL='));
    return line?.slice('TEST_DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '') || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the database the test suites run against. The ingestion suite wipes
 * and rebuilds the rating tables with no per-test scoping, so a wrong value
 * here destroys real ratings -- which is how an ingested generation of
 * player_ratings_history was lost. Hence the *_test name check, and no
 * fallback to whatever DATABASE_URL happens to be set.
 */
export function testDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL ?? fromDotEnv();
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set (checked the environment and .env). Point it at a *_test ' +
        'database; see README for how to refresh the clone.',
    );
  }

  const name = new URL(url).pathname.replace(/^\//, '');
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run tests against "${name}": the suites wipe and rebuild the rating tables, ` +
        'so TEST_DATABASE_URL must name a database ending in _test.',
    );
  }

  return url;
}
