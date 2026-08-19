/**
 * Manual runner: fill series.bracket_id for series ingested before the column
 * existed (migration 0016). Touches only that column -- no games, no scores,
 * no ratings.
 *
 *   npx tsx --env-file=../../.env src/__tests__/manualBackfillBracketIds.ts [start] [end]
 *
 * Defaults to 2026, which is what the stage-cadence work needs and keeps the
 * pull inside the hourly API budget; widen it only if older stages are wanted.
 */
import { createPool } from '../db.js';
import { fetchMatches } from '../liquipediaApi.js';
import {
  REGIONAL_SERIES_TO_LEAGUE_SLUG,
  INTERNATIONAL_SERIES,
  AMERICAS_SERIES,
} from '../liquipediaMatchIngest.js';

const START = process.argv[2] ?? '2026-01-01';
const END = process.argv[3] ?? new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const ALL_SERIES = [...Object.keys(REGIONAL_SERIES_TO_LEAGUE_SLUG), AMERICAS_SERIES, ...INTERNATIONAL_SERIES];
const CHUNK = 500;

const pool = createPool();

const byMatchId = new Map<string, { bracketId: string; section: string }>();
for (const series of ALL_SERIES) {
  try {
    const matches = await fetchMatches(`[[series::${series}]] AND [[date::>${START}]] AND [[date::<${END}]]`);
    let withStage = 0;
    for (const match of matches) {
      if (!match.match2bracketid && !match.section) continue;
      byMatchId.set(`liquipedia:${match.match2id}`, {
        bracketId: match.match2bracketid,
        section: match.section,
      });
      withStage += 1;
    }
    console.log(`  ${series}: ${matches.length} series, ${withStage} carrying a stage`);
  } catch (err) {
    console.error(`  ${series} FAILED: ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`\n${byMatchId.size} stage markers fetched`);

// One statement per chunk rather than per row: against a hosted database a
// statement per row pays a network round trip each time.
const entries = [...byMatchId.entries()];
let updated = 0;
for (let start = 0; start < entries.length; start += CHUNK) {
  const chunk = entries.slice(start, start + CHUNK);
  const values: string[] = [];
  const params: string[] = [];
  chunk.forEach(([matchId, stage], i) => {
    values.push(`($${i * 3 + 1}, $${i * 3 + 2}, $${i * 3 + 3})`);
    params.push(matchId, stage.bracketId, stage.section);
  });
  // NULLIF so an empty string never overwrites a known value with a blank.
  const res = await pool.query(
    `UPDATE series SET
       bracket_id = COALESCE(NULLIF(v.bracket_id, ''), series.bracket_id),
       stage_name = COALESCE(NULLIF(v.stage_name, ''), series.stage_name)
       FROM (VALUES ${values.join(', ')}) AS v(match_id, bracket_id, stage_name)
      WHERE series.leaguepedia_match_id = v.match_id
        AND (series.bracket_id IS DISTINCT FROM NULLIF(v.bracket_id, '')
             OR series.stage_name IS DISTINCT FROM NULLIF(v.stage_name, ''))`,
    params,
  );
  updated += res.rowCount ?? 0;
}

const coverage = await pool.query<{ total: string; with_stage: string; earliest: string | null }>(
  `SELECT count(*) AS total,
          count(bracket_id) AS with_stage,
          min(g.day)::text AS earliest
     FROM series s
     LEFT JOIN LATERAL (SELECT min(datetime_utc)::date AS day FROM games WHERE series_id = s.id) g ON true`,
);
const row = coverage.rows[0];
console.log(`${updated} series updated. Coverage: ${row.with_stage} of ${row.total} series carry a stage.`);

await pool.end();
