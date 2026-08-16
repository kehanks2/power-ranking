import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

/** Places gained on the board's last day of play; null and 0 both read as a dash. */
@Component({
  selector: 'pr-rank-change',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="rank-change" [class]="direction()">
      <span class="glyph" aria-hidden="true">{{ glyph() }}</span>
      <span class="visually-hidden">{{ label() }}</span>
    </span>
  `,
  styles: `
    .rank-change {
      display: inline-flex;
      align-items: center;
      gap: 0.15rem;
      font-variant-numeric: tabular-nums;
      font-size: 0.8125rem;
      line-height: 1;
      color: var(--color-text-dim);
    }
    .rank-change.up { color: var(--color-up); }
    .rank-change.down { color: var(--color-down); }
    /* The triangles sit optically high against tabular digits. */
    .up .glyph, .down .glyph { font-size: 0.6875rem; transform: translateY(0.5px); }
  `,
})
export class RankChangeComponent {
  readonly change = input.required<number | null>();

  protected readonly direction = computed(() => {
    const value = this.change();
    if (value === null || value === 0) return 'flat';
    return value > 0 ? 'up' : 'down';
  });

  protected readonly glyph = computed(() => {
    const value = this.change();
    if (value === null || value === 0) return '–';
    return value > 0 ? `▲${value}` : `▼${Math.abs(value)}`;
  });

  // The triangles are decorative, so the movement is stated for screen readers.
  protected readonly label = computed(() => {
    const value = this.change();
    if (value === null) return 'no recent games';
    if (value === 0) return 'no change';
    const places = Math.abs(value) === 1 ? 'place' : 'places';
    return value > 0 ? `up ${value} ${places}` : `down ${Math.abs(value)} ${places}`;
  });
}
