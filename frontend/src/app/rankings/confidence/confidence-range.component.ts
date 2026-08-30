import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { AXIS_TICKS, confidenceRange, type RatingConfidence } from './confidence-range';
import { TooltipDirective } from '../tooltip.directive';

/**
 * The rating drawn as a range: a solid band for the distance the games have
 * earned, a dashed tail on to the raw score. Pairs with `app-confidence-axis`
 * in the column header, which labels the same divisions.
 */
@Component({
  imports: [TooltipDirective],
  selector: 'app-confidence-range',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './confidence-range.component.scss',
  template: `
    <span class="range" [prTooltip]="range().label" tabindex="0">
      @for (tick of ticks; track tick) {
        <span class="range__gridline" [class.range__gridline--mid]="tick === 50" [style.left.%]="tick"></span>
      }
      <span
        class="range__band"
        [class.range__band--below]="range().bandBelow"
        [style.left.%]="range().bandLeft"
        [style.width.%]="range().bandWidth"
      ></span>
      @if (range().showTail) {
        <span
          class="range__tail"
          [class.range__tail--leftward]="range().tailLeftward"
          [style.left.%]="range().tailLeft"
          [style.width.%]="range().tailWidth"
        ></span>
      }
      <span class="range__point" [style.left.%]="range().point"></span>
    </span>
    <span class="visually-hidden">{{ range().description }}</span>
  `,
})
export class ConfidenceRangeComponent {
  readonly value = input.required<RatingConfidence>();

  protected readonly ticks = AXIS_TICKS;
  protected readonly range = computed(() => confidenceRange(this.value()));
}
