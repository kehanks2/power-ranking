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
import { DatePipe, DecimalPipe } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LeagueFilterService } from '../league-filter.service';
import { BoardAnchorService } from '../board-anchor.service';
import { RankingsApiService } from '../rankings-api.service';
import { BOARD_SCOPES, type BoardScope, type BoardUpdated, type LeagueSummary } from '../models';
import { TooltipDirective } from '../tooltip.directive';

@Component({
  selector: 'app-rankings-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, DecimalPipe, DatePipe, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rankings-shell.component.html',
  styleUrl: './rankings-shell.component.scss',
})
export class RankingsShellComponent {
  private readonly api = inject(RankingsApiService);

  protected readonly filter = inject(LeagueFilterService);
  protected readonly scopes = BOARD_SCOPES;

  // Regional strength shows alongside every board as context, not on its own
  // tab -- the only place the league rating appears now.
  protected readonly leagues = signal<LeagueSummary[]>([]);

  private readonly boardsUpdated = signal<BoardUpdated[]>([]);

  protected readonly lastUpdated = computed(
    () => this.boardsUpdated().find((board) => board.scope === this.filter.selectedScope())?.lastUpdated ?? null,
  );

  /** What the board's arrows measure against, published by the board itself. */
  protected readonly anchor = inject(BoardAnchorService).anchor;

  private readonly stickyTop = viewChild.required<ElementRef<HTMLElement>>('stickyTop');
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);

  // Which view is showing, so the scope note describes the right thing: teams
  // and players are rated differently, and one shared description fit neither.
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
    ),
    { initialValue: this.router.url },
  );

  protected readonly isPlayers = computed(() => this.url().includes('/players'));

  // A team's page is not a board, so the scope tabs and strength box are hidden
  // there -- the block is just the header.
  protected readonly isBoard = computed(() => !/\/teams\/\d/.test(this.url()));

  constructor() {
    this.api.getLeagues().subscribe((leagues) => this.leagues.set(leagues));
    this.api.getBoardsLastUpdated().subscribe((boards) => this.boardsUpdated.set(boards));

    // Publishes the sticky block's height so a board's table header pins beneath
    // it. Measured, not hard-coded: the scope note is two or three lines
    // depending on the board and reflows with the viewport.
    effect((onCleanup) => {
      const element = this.stickyTop().nativeElement;
      const root = this.document.documentElement;
      // Border box, not contentRect: the block's bottom padding (excluded from
      // contentRect) is the gap above the board, and dropping it pinned 16px too
      // high. Ceil, not round: a rounded-down fraction leaves a sub-pixel seam
      // the scrolling rows show through.
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

  // Half-width of the shared scale, rounded out past the board's widest range.
  // Symmetric about zero and shared across all six leagues so the ranges are
  // comparable.
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
