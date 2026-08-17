import { Injectable, signal } from '@angular/core';

interface RankedRow {
  rankChange: number | null;
  comparedTo: string | null;
}

/** `comparedTo` null means the board has rows but no prior board to rank them against. */
export interface BoardAnchor {
  comparedTo: string | null;
}

/**
 * What the board on screen measures its rank arrows against, published by
 * whichever board is showing.
 *
 * Read off the rows themselves rather than fetched alongside them: the two
 * boards pick their baseline by different rules — teams from the previous
 * stage, players from the previous generation — and a separately derived date
 * could name a baseline the arrows did not use.
 */
@Injectable({ providedIn: 'root' })
export class BoardAnchorService {
  // Null is "nothing published": no board on screen, or one still loading. It
  // is NOT the same as a board with nothing to compare against, which is a
  // fact the header states rather than omits.
  private readonly state = signal<BoardAnchor | null>(null);
  readonly anchor = this.state.asReadonly();

  publish(rows: readonly RankedRow[]): void {
    if (rows.length === 0) {
      this.state.set(null);
      return;
    }
    this.state.set({ comparedTo: rows.find((row) => row.rankChange !== null)?.comparedTo ?? null });
  }

  clear(): void {
    this.state.set(null);
  }
}
