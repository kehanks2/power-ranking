/** One generation of player ratings, as the caret logic needs to see it. */
export interface Generation {
  computedAt: number;
  /** Newest day of play the generation's data includes; null predates migration 0015. */
  dataFrontier: string | null;
  methodVersion: number;
}

export interface CaretGenerations {
  /** The generation on screen. */
  shown: number;
  /** The generation its arrows measure from, or null to dash the board. */
  baseline: number | null;
}

/**
 * Picks which two generations a player board's rank-change arrows compare.
 *
 * Pure, because getting it wrong is not visible in the output -- a wrong
 * baseline still produces plausible arrows. Three rules, each of which has been
 * broken in production at least once:
 *
 * - Never read past the generation being shown. A stage-held board would
 *   otherwise describe results the ratings beside it do not include.
 * - Key the baseline on the DATA FRONTIER, not on when it was computed.
 *   Recomputing old games today looks newer than a match day it does not
 *   contain, and every rerun on the same data shares a frontier, so the
 *   baseline does not move with how often the job runs.
 * - Only compare like with like. Across a `method_version` change the two
 *   boards are different models, so the difference is the retune rather than
 *   anything a player did: cutting the win weight once "moved" 42 of 57 LCK
 *   players. Dash until the new model has two generations of its own.
 */
export function selectCaretGenerations(
  generations: Generation[],
  lastPlayed: string,
  shownAt: number | undefined,
): CaretGenerations | null {
  const visible = generations
    .filter((g) => shownAt === undefined || g.computedAt <= shownAt)
    .sort((a, b) => a.computedAt - b.computedAt);
  if (visible.length === 0) return null;

  const shown = visible[visible.length - 1];
  const baseline = visible
    .filter(
      (g) =>
        g.computedAt !== shown.computedAt &&
        g.methodVersion === shown.methodVersion &&
        g.dataFrontier !== null &&
        g.dataFrontier < lastPlayed,
    )
    .pop();

  return { shown: shown.computedAt, baseline: baseline?.computedAt ?? null };
}
