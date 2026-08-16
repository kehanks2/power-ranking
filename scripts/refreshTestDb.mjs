/**
 * Rebuilds the test database as a copy of the live one.
 *
 * Neon does not allow CREATE DATABASE ... TEMPLATE: its compute holds a session
 * on the source that pg_stat_activity does not show to a non-superuser, so the
 * copy always reports "being accessed by other users". Dump and restore instead.
 *
 *   node scripts/refreshTestDb.mjs
 *
 * Needs pg_dump and psql on PATH. Run it after an ingest, so the suites that
 * assert against real rows are testing against current data.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function env(name) {
  if (process.env[name]) return process.env[name];
  const line = readFileSync(join(REPO_ROOT, '.env'), 'utf8')
    .split(/\r?\n/)
    .find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} is not set, in the environment or .env`);
  return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
}

const source = new URL(env('NEON_DATABASE_URL'));
const target = new URL(env('TEST_DATABASE_URL'));
const targetName = target.pathname.replace(/^\//, '');
const sourceName = source.pathname.replace(/^\//, '');

if (!targetName.endsWith('_test')) {
  throw new Error(`Refusing to rebuild "${targetName}": the target must be a database ending in _test.`);
}
if (targetName === sourceName || target.host !== source.host) {
  throw new Error(`Refusing to rebuild "${targetName}" from "${sourceName}" on a different host.`);
}

const admin = new URL(source.toString());
admin.pathname = '/postgres';

const work = mkdtempSync(join(tmpdir(), 'prtest-'));
const dumpPath = join(work, 'source.sql');

console.log(`dumping ${sourceName}...`);
execFileSync('pg_dump', [source.toString(), '--no-owner', '--no-privileges', '-f', dumpPath], { stdio: 'inherit' });

// pg_dump 17+ emits a GUC that a 16 server rejects, and Neon runs 16.
const dump = readFileSync(dumpPath, 'utf8');
const cleaned = dump.replace(/^SET transaction_timeout = 0;\r?\n/m, '');
writeFileSync(dumpPath, cleaned);

console.log(`recreating ${targetName}...`);
const psql = (url, args) => execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', ...args], { stdio: 'inherit' });
psql(admin.toString(), ['-c', `DROP DATABASE IF EXISTS ${targetName}`]);
psql(admin.toString(), ['-c', `CREATE DATABASE ${targetName}`]);

console.log(`restoring into ${targetName}...`);
psql(target.toString(), ['-q', '-f', dumpPath]);

const rowCounts = execFileSync(
  'psql',
  [
    target.toString(),
    '-At',
    '-c',
    `SELECT count(*) FROM (SELECT 1 FROM games UNION ALL SELECT 1 FROM player_ratings_history) x`,
  ],
  { encoding: 'utf8' },
).trim();

console.log(`done. ${targetName} holds ${rowCounts} games + player rating rows.`);
