import {
  Component,
  ChangeDetectionStrategy,
  inject,
  signal,
  viewChild,
  effect,
  computed,
  ElementRef,
  DOCUMENT,
} from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LeagueFilterService } from '../league-filter.service';
import { RankingsApiService } from '../rankings-api.service';
import { BOARD_SCOPES, type BoardScope, type LeagueSummary } from '../models';

@Component({
  selector: 'app-rankings-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rankings-shell.component.html',
  styleUrl: './rankings-shell.component.scss',
})
export class RankingsShellComponent {
  private readonly api = inject(RankingsApiService);

  protected readonly filter = inject(LeagueFilterService);
  protected readonly scopes = BOARD_SCOPES;

  /**
   * Regional strength is shown alongside every board, not on a tab of its own.
   * It is the only place the league rating appears now that it is no longer
   * added to team ratings, and it is context for whichever board you are
   * reading rather than a ranking in its own right.
   */
  protected readonly leagues = signal<LeagueSummary[]>([]);

  private readonly stickyTop = viewChild.required<ElementRef<HTMLElement>>('stickyTop');
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);

  /**
   * Which view is showing, so the scope note can describe the right thing.
   * Teams and players are rated by genuinely different methods, and one shared
   * description was wrong on whichever view it was not written for.
   */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  protected readonly isPlayers = computed(() => this.url().includes('/players'));

  /**
   * One team's page is not a board. The scope tabs would switch a board that
   * isn't showing, and the description and strength box both describe one --
   * so on that route the block is just the header and the tabs.
   */
  protected readonly isBoard = computed(() => !/\/teams\/\d/.test(this.url()));

  constructor() {
    this.api.getLeagues().subscribe((leagues) => this.leagues.set(leagues));

    /**
     * Publishes the sticky block's height so a board's table header can pin
     * directly beneath it.
     *
     * Measured rather than hard-coded because the height genuinely varies: the
     * scope note is three lines on the International board and two on a
     * regional one, and it reflows with the viewport. A written-down `top` is
     * what put the control bar 4px under the header in the first place.
     */
    effect((onCleanup) => {
      const element = this.stickyTop().nativeElement;
      const root = this.document.documentElement;
      // The BORDER box, not contentRect: the block carries bottom padding (the
      // breathing room above the board), and contentRect excludes padding, so
      // measuring that pinned everything 16px too high, straight through the
      // gap it was meant to preserve.
      //
      // Ceil, not round: rounding 257.4 down to 257 leaves a sub-pixel gap the
      // scrolling rows show through. Ceiling it errs the other way, and the
      // 1px of background the block paints below itself covers what is left.
      const observer = new ResizeObserver(([entry]) => {
        const height = entry.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height;
        root.style.setProperty('--sticky-top-height', `${Math.ceil(height)}px`);
      });
      observer.observe(element);
      onCleanup(() => {
        observer.disconnect();
        root.style.removeProperty('--sticky-top-height');
      });
    });
  }

  protected label(scope: BoardScope): string {
    return scope === 'international' ? 'International' : scope;
  }

  /**
   * Half-width of the shared scale, in rating points, rounded out past the
   * widest range on the board. Symmetric about zero so the centre line -- "no
   * region assumed stronger" -- stays where it can be read, and shared across
   * all six so their ranges can be compared against each other.
   */
  private readonly halfScale = computed(() => {
    const widest = Math.max(...this.leagues().map((l) => Math.abs(l.rating) + l.rd), 1);
    return Math.ceil(widest / 50) * 50;
  });

  /** Where a rating sits on that scale, as a percentage across the track. */
  protected scalePct(value: number): number {
    const half = this.halfScale();
    return ((value + half) / (2 * half)) * 100;
  }

  /** Width of the ± band: the whole range the evidence supports. */
  protected spanPct(league: LeagueSummary): number {
    return this.scalePct(league.rating + league.rd) - this.scalePct(league.rating - league.rd);
  }

  protected signed(rating: number): string {
    return `${rating > 0 ? '+' : ''}${Math.round(rating)}`;
  }

  protected rangeTitle(league: LeagueSummary): string {
    const lo = Math.round(league.rating - league.rd);
    const hi = Math.round(league.rating + league.rd);
    return `${league.name}: ${this.signed(league.rating)}, and the evidence supports anywhere from ${this.signed(lo)} to ${this.signed(hi)}`;
  }
}
