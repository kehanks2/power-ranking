import { describe, expect, it } from 'vitest';
import { batchMatchIds, matchIdConditions, MATCH_IDS_PER_REQUEST } from '../refreshStatlessGames.js';

describe('batchMatchIds', () => {
  it('returns nothing for no ids, so a clean run makes no request', () => {
    expect(batchMatchIds([])).toEqual([]);
  });

  it('keeps a partial final batch', () => {
    const ids = Array.from({ length: 27 }, (_, i) => `m${i}`);
    const batches = batchMatchIds(ids);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(MATCH_IDS_PER_REQUEST);
    expect(batches[1]).toHaveLength(2);
    expect(batches.flat()).toEqual(ids);
  });

  it('does not split a batch that fits exactly', () => {
    const ids = Array.from({ length: MATCH_IDS_PER_REQUEST }, (_, i) => `m${i}`);
    expect(batchMatchIds(ids)).toHaveLength(1);
  });
});

describe('matchIdConditions', () => {
  it('ORs the ids into one LPDB condition', () => {
    // Verified live against v3/match: two ids OR'd return both matches in one
    // request, which is what makes re-asking by id cheaper than a date window.
    expect(matchIdConditions(['26LPLS3RS4_0014', '26LPLS3RS4_0012'])).toBe(
      '[[match2id::26LPLS3RS4_0014]] OR [[match2id::26LPLS3RS4_0012]]',
    );
  });

  it('emits a single condition unwrapped', () => {
    expect(matchIdConditions(['LEC26SumW4_0003'])).toBe('[[match2id::LEC26SumW4_0003]]');
  });
});
