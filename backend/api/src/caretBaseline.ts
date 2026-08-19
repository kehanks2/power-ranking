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
 * - Measure from a STAGE BOUNDARY, not from the newest generation that happens
 *   to predate the last match day. The job runs daily, so "the previous
 *   generation" is yesterday: an LCK board showing the end of week 12 compared
 *   against data stopping mid-week-12, which is the half-round comparison the
 *   whole stage mechanism exists to prevent. Team carets already measure from
 *   `previousAsOfDate`; this is the same interval.
 * - Only compare like with like. Across a `method_version` change the two
 *   boards are different models, so the difference is the retune rather than
 *   anything a player did: cutting the win weight once "moved" 42 of 57 LCK
 *   players. Dash until the new model has two generations of its own.
 * - Order generations by DATA, never by run order, including when deciding what
 *   counts as "past the board". A reconstructed baseline (see
 *   backfillPlayerGenerations) holds old games but is computed today, so an
 *   ordering keyed on `computed_at` filed every one of them as newer than the
 *   board and dashed four regional boards that had a perfectly good baseline.
 */
export function selectCaretGenerations(
  generations: Generation[],
  /**
   * End of the stage before the one on screen. A generation qualifies as the
   * baseline only if its data stops at or before it. Internationally there are
   * no stages, so callers pass the board's own last match day and the rule
   * degrades to "any earlier generation".
   */
  baselineOnOrBefore: string,
  shownAt: number | undefined,
): CaretGenerations | null {
  if (generations.length === 0) return null;

  // Order on DATA, breaking ties on the run: two generations at one frontier
  // are reruns of the same games, and the later run is the current one.
  const byData = [...generations].sort((a, b) => {
    if (a.dataFrontier !== b.dataFrontier) {
      if (a.dataFrontier === null) return -1;
      if (b.dataFrontier === null) return 1;
      return a.dataFrontier < b.dataFrontier ? -1 : 1;
    }
    return a.computedAt - b.computedAt;
  });

  const shown = (shownAt !== undefined && generations.find((g) => g.computedAt === shownAt)) || byData[byData.length - 1];

  const baseline = byData
    .filter(
      (g) =>
        g.computedAt !== shown.computedAt &&
        g.methodVersion === shown.methodVersion &&
        g.dataFrontier !== null &&
        g.dataFrontier <= baselineOnOrBefore &&
        // Strictly older DATA than what is shown, not merely an earlier run. A
        // rerun over the same games is computed later but contains no less, and
        // comparing the board against itself yields a board of zeros.
        (shown.dataFrontier === null || g.dataFrontier < shown.dataFrontier),
    )
    .pop();

  return { shown: shown.computedAt, baseline: baseline?.computedAt ?? null };
}
