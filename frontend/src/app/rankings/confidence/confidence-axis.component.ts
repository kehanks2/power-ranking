import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { AXIS_TICKS } from './confidence-range';

/**
 * The 0-100 scale labelled once in the column header, above the rows' ranges.
 * Owns the column's heading too, so the word sits centred over the scale it
 * names rather than at the cell's left edge.
 */
@Component({
  selector: 'app-confidence-axis',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './confidence-axis.component.scss',
  template: `
    @if (label(); as text) {
      <span class="axis__label">{{ text }}</span>
    }
    <span class="axis" aria-hidden="true">
      @for (tick of ticks; track tick) {
        <span class="axis__tick" [style.left.%]="tick">{{ tick }}</span>
      }
    </span>
  `,
})
export class ConfidenceAxisComponent {
  readonly label = input('');

  protected readonly ticks = AXIS_TICKS;
}
