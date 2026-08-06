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
      const observer = new ResizeObserver(([entry]) => {
        root.style.setProperty('--sticky-top-height', `${Math.round(entry.contentRect.height)}px`);
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
   * Half-width of the diverging meter, as a percentage. League ratings are
   * offsets from "no region assumed stronger", so the bar grows out from a
   * centre line rather than from the left edge.
   */
  protected barWidth(rating: number): number {
    const max = Math.max(...this.leagues().map((l) => Math.abs(l.rating)), 1);
    return (Math.abs(rating) / max) * 50;
  }

  protected barLeft(rating: number): number {
    return rating >= 0 ? 50 : 50 - this.barWidth(rating);
  }
}
