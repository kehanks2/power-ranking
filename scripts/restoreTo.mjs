/**
 * Restores a pg_dump into a target database, whoever is hosting it.
 *
 *   node scripts/restoreTo.mjs "<target-url>" <dump.sql>
 *   node scripts/restoreTo.mjs "<target-url>" <dump.sql> --force
 *
 * Written for moving hosts in either direction: Neon -> Aiven while an
 * allowance is exhausted, and back again once it resets. The target is
 * OVERWRITTEN, so it refuses a target that already holds games unless --force
 * says that is the point (it is, on the way back -- the old host's copy is
 * stale, and the new host's is a strict superset).
 *
 * Losing a day or two between the dump and the restore is fine and expected:
 * the daily pull starts its window at the newest game HELD, not at today, so
 * the next run re-fetches whatever the gap contains. Do not hand-patch it.
 *
 * Afterwards: repoint DATABASE_URL in .env, and update the Actions secret
 *   gh secret set DATABASE_URL --body "<target-url>"
 * Tests do not care -- they run on PGlite and never touch a host.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [targetUrl, dumpPath, ...flags] = process.argv.slice(2);
if (!targetUrl || !dumpPath) {
  throw new Error('usage: node scripts/restoreTo.mjs "<target-url>" <dump.sql> [--force]');
}
const force = flags.includes('--force');

const psql = (args, opts = {}) =>
  execFileSync('psql', [targetUrl, '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8', ...opts });

const scalar = (sql) => psql(['-At', '-c', sql]).trim();

console.log(`target: ${targetUrl.replace(/:\/\/[^@]+@/, '://****@')}`);
console.log(psql(['-At', '-c', 'SELECT version()']).trim());

// Refuse to overwrite a populated target by accident.
const hasGames = scalar(`SELECT to_regclass('public.games') IS NOT NULL`);
if (hasGames === 't') {
  const count = Number(scalar('SELECT count(*) FROM games'));
  if (count > 0 && !force) {
    throw new Error(
      `Refusing to restore: the target already holds ${count} games. Pass --force if overwriting is the intent.`,
    );
  }
  if (count > 0) console.log(`--force: overwriting a target holding ${count} games`);
}

// pg_dump 17+ emits a GUC that a 16 server rejects, and Neon runs 16. Harmless
// to strip against a newer server, so it is unconditional rather than probed.
const work = mkdtempSync(join(tmpdir(), 'prrestore-'));
const cleanedPath = join(work, 'restore.sql');
const dump = readFileSync(dumpPath, 'utf8');
writeFileSync(cleanedPath, dump.replace(/^SET transaction_timeout = 0;\r?\n/m, ''));

// Expected counts come from the dump itself, so the check is against what was
// asked for rather than against a number written down separately.
const expected = new Map();
for (const m of dump.matchAll(/^COPY public\.(\w+) \([^)]+\) FROM stdin;\n([\s\S]*?)^\\\.$/gm)) {
  expected.set(m[1], m[2] === '' ? 0 : m[2].trimEnd().split('\n').length);
}

console.log('dropping and recreating public schema...');
psql(['-c', 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'], { stdio: 'inherit' });

console.log('restoring...');
psql(['-q', '-f', cleanedPath], { stdio: 'inherit' });

console.log('\nverifying row counts:');
let bad = 0;
for (const [table, want] of [...expected].sort()) {
  const got = Number(scalar(`SELECT count(*) FROM ${table}`));
  const ok = got === want;
  if (!ok) bad += 1;
  console.log(`  ${ok ? 'ok  ' : 'BAD '} ${String(got).padStart(7)} / ${String(want).padEnd(7)} ${table}`);
}
if (bad > 0) throw new Error(`${bad} table(s) did not match the dump`);

console.log('\nrestore verified.');
console.log('next: repoint DATABASE_URL in .env, then');
console.log('  gh secret set DATABASE_URL --body "<target-url>"');
