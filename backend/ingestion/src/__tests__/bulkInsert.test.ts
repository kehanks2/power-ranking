import { describe, it, expect } from 'vitest';
import type { PoolClient } from 'pg';
import { bulkInsert, dedupeByKey } from '../bulkInsert.js';

interface Captured {
  sql: string;
  values: unknown[];
}

function recordingClient(): { client: PoolClient; calls: Captured[] } {
  const calls: Captured[] = [];
  const client = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return { client, calls };
}

const COLUMNS = ['a', 'b', 'c'];
const rows = (n: number) => Array.from({ length: n }, (_, i) => [i, `b${i}`, null]);

describe('bulkInsert', () => {
  it('issues one statement for a small batch, with every value bound', async () => {
    const { client, calls } = recordingClient();

    const inserted = await bulkInsert(client, 't', COLUMNS, rows(3));

    expect(inserted).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toBe('INSERT INTO t (a, b, c) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9)');
    expect(calls[0].values).toEqual([0, 'b0', null, 1, 'b1', null, 2, 'b2', null]);
  });

  it('issues no statement at all for an empty batch', async () => {
    const { client, calls } = recordingClient();

    expect(await bulkInsert(client, 't', COLUMNS, [])).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('chunks past the row cap, numbering placeholders from $1 in each statement', async () => {
    const { client, calls } = recordingClient();

    const inserted = await bulkInsert(client, 't', COLUMNS, rows(2500));

    expect(inserted).toBe(2500);
    expect(calls.map((c) => c.values.length)).toEqual([3000, 3000, 1500]);
    for (const call of calls) {
      expect(call.sql).toContain('VALUES ($1, $2, $3),');
      expect(call.sql).not.toContain(`$${call.values.length + 1}`);
    }
  });

  it('stays under the 65535 bound-parameter ceiling on wide rows', async () => {
    const { client, calls } = recordingClient();
    const wide = Array.from({ length: 100 }, (_, i) => `c${i}`);

    await bulkInsert(client, 't', wide, Array.from({ length: 2000 }, () => wide.map(() => 1)));

    for (const call of calls) expect(call.values.length).toBeLessThanOrEqual(65535);
  });

  it('preserves row order across chunk boundaries', async () => {
    const { client, calls } = recordingClient();

    await bulkInsert(client, 't', COLUMNS, rows(1500));

    const ids = calls.flatMap((call) => call.values.filter((_, i) => i % 3 === 0));
    expect(ids).toEqual(Array.from({ length: 1500 }, (_, i) => i));
  });

  it('rejects a row whose width disagrees with the column list', async () => {
    const { client, calls } = recordingClient();

    await expect(bulkInsert(client, 't', COLUMNS, [[1, 2, 3], [4, 5]])).rejects.toThrow(
      'bulkInsert(t): expected 3 values per row, got 2',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('bulkInsert upserts', () => {
  it('appends the conflict clause to every chunk', async () => {
    const { client, calls } = recordingClient();
    const clause = 'ON CONFLICT (a) DO UPDATE SET b = EXCLUDED.b';

    await bulkInsert(client, 't', COLUMNS, rows(1500), clause);

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.sql.endsWith(clause)).toBe(true);
  });
});

describe('dedupeByKey', () => {
  it('keeps the last row per key, in first-seen order', () => {
    // Postgres rejects a statement whose ON CONFLICT touches one key twice, and
    // two Liquipedia handles can resolve to the same player id. Last-wins
    // matches what a sequence of individual upserts would have left.
    const deduped = dedupeByKey(
      [
        { id: 1, v: 'a' },
        { id: 2, v: 'b' },
        { id: 1, v: 'c' },
      ],
      (row) => String(row.id),
    );
    expect(deduped).toEqual([
      { id: 1, v: 'c' },
      { id: 2, v: 'b' },
    ]);
  });

  it('leaves an already-unique batch untouched', () => {
    const input = [{ id: 1 }, { id: 2 }, { id: 3 }];
    expect(dedupeByKey(input, (row) => String(row.id))).toEqual(input);
  });
});
