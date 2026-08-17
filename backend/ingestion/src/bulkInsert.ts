import type { Pool, PoolClient } from 'pg';

// Postgres refuses a statement carrying more than 65535 bound parameters.
const MAX_BIND_PARAMS = 65535;
const MAX_ROWS_PER_STATEMENT = 1000;

/**
 * Inserts rows a chunk per statement rather than a statement per row. The
 * rating writes issue thousands of inserts inside one transaction, and against
 * a hosted database each one pays a network round trip -- a full recompute was
 * 60s locally and 422s on Neon for that reason alone.
 *
 * Caller supplies values in `columns` order; chunk size is whichever of the row
 * cap and the parameter ceiling binds first.
 */
export async function bulkInsert(
  client: Pool | PoolClient,
  table: string,
  columns: string[],
  rows: readonly unknown[][],
  /**
   * Optional `ON CONFLICT ...` clause, for upserts. Postgres refuses to let one
   * statement touch the same conflict key twice, so callers passing this must
   * hand over rows already deduplicated on that key -- see dedupeByKey.
   */
  onConflict = '',
): Promise<number> {
  if (rows.length === 0) return 0;

  const width = columns.length;
  const wrong = rows.find((row) => row.length !== width);
  if (wrong) {
    throw new Error(`bulkInsert(${table}): expected ${width} values per row, got ${wrong.length}`);
  }

  const chunkSize = Math.min(MAX_ROWS_PER_STATEMENT, Math.floor(MAX_BIND_PARAMS / width));
  const columnList = columns.join(', ');

  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const placeholders = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    const conflict = onConflict ? ` ${onConflict}` : '';
    await client.query(`INSERT INTO ${table} (${columnList}) VALUES ${tuples.join(', ')}${conflict}`, values);
  }

  return rows.length;
}

/**
 * Last row wins per key, preserving first-seen order.
 *
 * Batching an upsert needs this: Postgres rejects a statement whose ON CONFLICT
 * would touch one key twice ("cannot affect row a second time"), and a
 * duplicate is reachable here -- two Liquipedia handles can resolve to one
 * player id, which is the collision the ingest already counts. Last-wins
 * matches what a sequence of individual upserts would have left behind.
 */
export function dedupeByKey<T>(rows: readonly T[], key: (row: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) byKey.set(key(row), row);
  return [...byKey.values()];
}
