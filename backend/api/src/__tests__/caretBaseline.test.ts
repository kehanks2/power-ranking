import { describe, it, expect } from 'vitest';
import { selectCaretGenerations, type Generation } from '../caretBaseline.js';

const gen = (computedAt: number, dataFrontier: string | null, methodVersion = 4): Generation => ({
  computedAt,
  dataFrontier,
  methodVersion,
});

const LAST_PLAYED = '2026-08-16';

describe('selectCaretGenerations', () => {
  it('measures from the newest generation whose data predates the last match day', () => {
    const chosen = selectCaretGenerations(
      [gen(1, '2026-08-09'), gen(2, '2026-08-15'), gen(3, '2026-08-16')],
      LAST_PLAYED,
      undefined,
    );
    expect(chosen).toEqual({ shown: 3, baseline: 2 });
  });

  it('refuses a baseline computed by a different model', () => {
    // Across a retune the two boards are different models, so the arrows would
    // report the parameter change as player movement -- cutting the win weight
    // once "moved" 42 of 57 LCK players.
    const chosen = selectCaretGenerations(
      [gen(1, '2026-08-09', 3), gen(2, '2026-08-15', 3), gen(3, '2026-08-16', 4)],
      LAST_PLAYED,
      undefined,
    );
    expect(chosen).toEqual({ shown: 3, baseline: null });
  });

  it('reads the same generations once the model matches', () => {
    const chosen = selectCaretGenerations(
      [gen(1, '2026-08-09', 4), gen(2, '2026-08-15', 4), gen(3, '2026-08-16', 4)],
      LAST_PLAYED,
      undefined,
    );
    expect(chosen?.baseline).toBe(2);
  });

  it('never reads past the generation being shown', () => {
    // A stage-held board would otherwise describe results its own ratings
    // exclude.
    const generations = [gen(1, '2026-08-09'), gen(2, '2026-08-15'), gen(3, '2026-08-16')];
    expect(selectCaretGenerations(generations, LAST_PLAYED, 2)).toEqual({ shown: 2, baseline: 1 });
  });

  it('dashes when the shown generation is the only one visible', () => {
    const generations = [gen(1, '2026-08-09'), gen(2, '2026-08-15')];
    expect(selectCaretGenerations(generations, LAST_PLAYED, 1)).toEqual({ shown: 1, baseline: null });
  });

  it('keys the baseline on the data frontier, not on when it was computed', () => {
    // A rerun over old games is computed latest but contains least; picking it
    // would compare the board against a subset of itself.
    const chosen = selectCaretGenerations(
      [gen(1, '2026-08-15'), gen(2, '2026-08-16'), gen(3, '2026-08-16')],
      LAST_PLAYED,
      undefined,
    );
    expect(chosen).toEqual({ shown: 3, baseline: 1 });
  });

  it('ignores a generation with no recorded frontier', () => {
    const chosen = selectCaretGenerations([gen(1, null), gen(2, '2026-08-16')], LAST_PLAYED, undefined);
    expect(chosen).toEqual({ shown: 2, baseline: null });
  });

  it('returns null when there is nothing to show', () => {
    expect(selectCaretGenerations([], LAST_PLAYED, undefined)).toBeNull();
  });
});
