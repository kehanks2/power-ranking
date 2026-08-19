/**
 * Carves a small, referentially complete slice out of a pg_dump into
 * db/fixtures/sample.sql, which the PGlite test harness loads.
 *
 *   node scripts/buildTestFixture.mjs <path-to-dump.sql>
 *
 * Real rows rather than synthetic ones: the suites this feeds assert on the
 * SHAPE of live data -- that every rating window holds players, that the
 * international pool is a strict subset of the regional one -- and invented
 * data proves those hold for invented data.
 *
 * Regenerate when the schema changes. It is deliberately not wired into the
 * test run: the fixture is committed so a test run needs no dump and no network.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(REPO_ROOT, 'db', 'fixtures', 'sample.sql');

/**
 * Series kept per regional tournament, newest first -- EXCEPT the newest
 * tournament of each league, which is kept whole. A regional board carries only
 * teams playing the current split, so truncating that split drops teams off the
 * board entirely: at 15 series the LPL board came back with two teams out of
 * twelve, and every roster row it could show belonged to a team that had played.
 */
const SERIES_PER_REGIONAL = 15;

/**
 * Regional tournaments kept per league, newest first. Five, because the three
 * rating windows have to come out strictly narrowing -- all > year > split --
 * and each step needs its own evidence:
 *   split  the newest tournament only
 *   year   the rest of the current year's tournaments (three per league)
 *   all    at least one from a PRIOR year, or all and year are the same set
 * With only the current split in the slice every window holds the same players
 * and the assertions that distinguish them hold trivially or fail outright.
 */
const TOURNAMENTS_PER_LEAGUE = 5;

const dumpPath = process.argv[2];
if (!dumpPath) throw new Error('usage: node scripts/buildTestFixture.mjs <path-to-dump.sql>');

// --- parse the dump's COPY blocks ---------------------------------------------

/** @type {Map<string, {columns: string[], rows: string[][]}>} */
const tables = new Map();
{
  const lines = readFileSync(dumpPath, 'utf8').split(/\r?\n/);
  let current = null;
  for (const line of lines) {
    if (current) {
      if (line === '\\.') {
        current = null;
      } else {
        current.rows.push(line.split('\t'));
      }
      continue;
    }
    const m = /^COPY public\.(\w+) \(([^)]+)\) FROM stdin;$/.exec(line);
    if (m) {
      current = { columns: m[2].split(', '), rows: [] };
      tables.set(m[1], current);
    }
  }
}

const col = (table, name) => {
  const i = tables.get(table).columns.indexOf(name);
  if (i < 0) throw new Error(`${table} has no column ${name}`);
  return i;
};
const rowsOf = (table) => tables.get(table).rows;

// --- choose the slice ---------------------------------------------------------

const tType = col('tournaments', 'tournament_type');
const tId = col('tournaments', 'id');
const tStart = col('tournaments', 'date_start');

const byNewest = (a, b) => (a[tStart] < b[tStart] ? 1 : -1);

// Every international event, so the Global tab's pool is populated and the
// 36-month window has something inside it.
const international = rowsOf('tournaments').filter((r) => r[tType] === 'international');

// The newest regional tournament per league, which is what makes the `split`
// window non-empty -- it reads the newest tournament that has actually started.
const regionalByLeague = new Map();
for (const r of rowsOf('tournaments').filter((x) => x[tType] !== 'international').sort(byNewest)) {
  const league = r[col('tournaments', 'canonical_league_id')];
  if (league === '\\N') continue;
  if (!regionalByLeague.has(league)) regionalByLeague.set(league, []);
  const kept = regionalByLeague.get(league);
  if (kept.length < TOURNAMENTS_PER_LEAGUE) kept.push(r);
}

const keptTournaments = [...international, ...[...regionalByLeague.values()].flat()];
const keptTournamentIds = new Set(keptTournaments.map((r) => r[tId]));

/** Kept whole: the current split of each league, plus every international event. */
const uncappedTournamentIds = new Set([
  ...international.map((r) => r[tId]),
  ...[...regionalByLeague.values()].map((kept) => kept[0][tId]),
]);

const sTournament = col('series', 'tournament_id');
const sId = col('series', 'id');
const sWhen = col('series', 'date_utc');

// Capped by SERIES, keeping every game of the ones kept. Capping games instead
// leaves a team holding more series than games, which is not a state the data
// can reach -- a played series is at least one game long -- and the API suite
// asserts exactly that. International events are kept whole because
// MIN_INTERNATIONAL_GAMES already filters that pool hard.
const perTournament = new Map();
const keptSeries = [];
for (const r of rowsOf('series')
  .filter((x) => keptTournamentIds.has(x[sTournament]))
  .sort((a, b) => (a[sWhen] < b[sWhen] ? 1 : -1))) {
  const tournamentId = r[sTournament];
  const n = perTournament.get(tournamentId) ?? 0;
  if (!uncappedTournamentIds.has(tournamentId) && n >= SERIES_PER_REGIONAL) continue;
  perTournament.set(tournamentId, n + 1);
  keptSeries.push(r);
}
const keptSeriesIds = new Set(keptSeries.map((r) => r[sId]));

const gSeries = col('games', 'series_id');
const gId = col('games', 'id');
const keptGames = rowsOf('games').filter((r) => keptSeriesIds.has(r[gSeries]));
const keptGameIds = new Set(keptGames.map((r) => r[gId]));

const childRows = (table, fk) => rowsOf(table).filter((r) => keptGameIds.has(r[col(table, fk)]));
const keptPerf = childRows('player_game_performance', 'game_id');
const keptLineups = childRows('game_lineups', 'game_id');

// Teams come from the kept SERIES as well as the kept games: a series whose
// games all fell outside the cap still names both teams, and an undecided
// fixture legitimately has a series and no games at all.
const keptTeamIds = new Set();
for (const g of keptGames) {
  keptTeamIds.add(g[col('games', 'team1_id')]);
  keptTeamIds.add(g[col('games', 'team2_id')]);
}
for (const r of keptSeries) {
  for (const c of ['team1_id', 'team2_id']) {
    const v = r[col('series', c)];
    if (v !== '\N') keptTeamIds.add(v);
  }
}
// Every roster row of a kept team, INCLUDING players with no game in the slice.
// Filtering these down to players who appeared would delete the one state the
// "no games here" marker exists for -- a rostered player with nothing to show --
// and the API suite asserts that state is reachable.
const keptRosters = rowsOf('roster_memberships').filter((r) =>
  keptTeamIds.has(r[col('roster_memberships', 'team_id')]),
);

const keptPlayerIds = new Set([
  ...keptPerf.map((r) => r[col('player_game_performance', 'player_id')]),
  ...keptLineups.map((r) => r[col('game_lineups', 'player_id')]),
  ...keptRosters.map((r) => r[col('roster_memberships', 'player_id')]),
]);

const filterByIdSet = (table, column, set) => rowsOf(table).filter((r) => set.has(r[col(table, column)]));

// --- emit ---------------------------------------------------------------------

const literal = (v) => {
  if (v === '\\N') return 'NULL';
  return `'${v.replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\\\/g, '\\').replace(/'/g, "''")}'`;
};

const insert = (table, rows) => {
  if (rows.length === 0) return '';
  const { columns } = tables.get(table);
  const values = rows.map((r) => `  (${r.map(literal).join(', ')})`).join(',\n');
  return `INSERT INTO ${table} (${columns.join(', ')}) VALUES\n${values};\n\n`;
};

// Insertion order is FK order; leagues/aliases come from reference.sql.
const emitted = [
  ['teams', filterByIdSet('teams', 'id', keptTeamIds)],
  ['team_league_memberships', filterByIdSet('team_league_memberships', 'team_id', keptTeamIds)],
  ['players', filterByIdSet('players', 'id', keptPlayerIds)],
  ['roster_memberships', keptRosters],
  ['tournaments', keptTournaments],
  ['series', keptSeries],
  ['games', keptGames],
  ['game_lineups', keptLineups],
  ['player_game_performance', keptPerf],
];

let sql = `-- Generated by scripts/buildTestFixture.mjs -- do not edit by hand.
-- A referentially complete slice of real data: every international event, plus
-- the ${TOURNAMENTS_PER_LEAGUE} newest tournaments per league, ${SERIES_PER_REGIONAL} series each.

`;
for (const [table, rows] of emitted) sql += insert(table, rows);

sql += '-- Explicit ids leave every sequence at 1.\n';
for (const [table] of emitted) {
  sql += `SELECT setval('${table}_id_seq', (SELECT COALESCE(max(id), 1) FROM ${table}));\n`;
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, sql);

const kb = (Buffer.byteLength(sql) / 1024).toFixed(0);
console.log(`wrote ${OUT} (${kb} KB)`);
for (const [table, rows] of emitted) console.log(`  ${String(rows.length).padStart(6)}  ${table}`);
