import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/**
 * Marks a row whose player has no games on the board showing it. Shared because
 * the player board and the team page both carry rosters and were previously
 * inconsistent: the board marked only the few players Liquipedia named a second
 * squad for, and the team page marked nothing at all.
 */
@Component({
  selector: 'pr-unplayed-marker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (gamesPlayed() === 0) {
      <span class="dot" [title]="label()" aria-hidden="true"></span>
      <span class="visually-hidden">{{ label() }}</span>
    }
  `,
  styles: `
    .dot {
      width: 7px;
      height: 7px;
      flex: 0 0 7px;
      border-radius: 50%;
      display: inline-block;
      background: var(--color-unplayed);
      cursor: help;
    }
  `,
})
export class UnplayedMarkerComponent {
  readonly gamesPlayed = input.required<number>();
  /** The other squad Liquipedia names, when it names one. */
  readonly alsoPlaysFor = input<string | null>(null);

  protected readonly label = computed(() => {
    const other = this.alsoPlaysFor();
    return other
      ? `No games on this board — on the roster, and Liquipedia also lists them on ${other}`
      : 'No games on this board — on the roster, has not played';
  });
}
