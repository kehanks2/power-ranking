/**
 * Manual runner: reconstruct caret baselines for recent days of play that have
 * none. Additive -- a day already holding a generation is skipped, never
 * rewritten, so this cannot replace a real generation with a reconstruction.
 *
 * Verify the premise first with checkAsOfReproduces.ts, which is read-only.
 *
 * Run with: tsx --env-file=../../.env src/__tests__/manualBackfillPlayerGenerations.ts
 */
import { createPool } from '../db.js';
import { backfillPlayerGenerations } from '../backfillPlayerGenerations.js';

async function main() {
  const pool = createPool();
  const started = Date.now();

  const result = await backfillPlayerGenerations(pool);
  console.log(`${result.candidates.length} recent days of play considered`);
  console.log(`skipped (already hold a generation): ${result.skipped.join(', ') || 'none'}`);
  for (const written of result.written) {
    console.log(`  wrote ${written.frontier}: ${written.rows} rows`);
  }
  console.log(`\n${result.written.length} generations written in ${Math.round((Date.now() - started) / 1000)}s`);

  await pool.end();
}

main().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
