import type { PoolClient } from 'pg';

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
  client: PoolClient,
  table: string,
  columns: string[],
  rows: readonly unknown[][],
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
    await client.query(`INSERT INTO ${table} (${columnList}) VALUES ${tuples.join(', ')}`, values);
  }

  return rows.length;
}
