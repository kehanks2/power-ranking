import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { DatePipe, ViewportScroller } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { RankingsApiService } from '../rankings-api.service';
import { BOARD_SCOPES, type BoardScope, type BoardUpdated, type LeagueSummary } from '../models';

interface BoardRow {
  scope: BoardScope;
  label: string;
  nameClass: string;
  ranks: string;
  lastUpdated: string | null;
}

const ANCHOR_GAP = 16;

// Matches the stylesheet's breakpoint: above it the contents list is a sidebar
// and always open, below it a disclosure.
const WIDE_VIEWPORT = '(min-width: 941px)';

const BOARD_RANKS: Record<BoardScope, string> = {
  international: 'Teams and players measured against the same field, at First Stand, MSI and Worlds',
  LCK: 'Teams and players in the LCK, against each other only',
  LPL: 'Teams and players in the LPL, against each other only',
  LEC: 'Teams and players in the LEC, against each other only',
  LCS: 'Teams and players in the LCS, against each other only',
  CBLOL: 'Teams and players in the CBLOL, against each other only',
  LCP: 'Teams and players in the LCP, against each other only',
};

@Component({
  selector: 'app-how-it-works',
  imports: [DatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './how-it-works.component.html',
  styleUrl: './how-it-works.component.scss',
})
export class HowItWorksComponent {
  private readonly api = inject(RankingsApiService);

  protected readonly contents = [
    { id: 'boards', label: 'Boards are not comparable' },
    { id: 'teams', label: "What a team's rating is" },
    { id: 'range', label: 'The ± range' },
    { id: 'order', label: 'Why a lower number can sit higher' },
    { id: 'arrows', label: 'The ▲▼ arrows' },
    { id: 'players', label: 'Player ratings' },
    { id: 'games', label: 'Which games count' },
    { id: 'limits', label: 'Where the model is weakest' },
  ];

  protected readonly wideViewport = signal(true);

  private readonly updated = signal<BoardUpdated[]>([]);

  protected readonly leagues = signal<LeagueSummary[]>([]);

  protected readonly boards = computed<BoardRow[]>(() =>
    BOARD_SCOPES.map((scope) => ({
      scope,
      label: scope === 'international' ? 'International' : scope,
      nameClass: scope === 'international' ? 'intl' : `lg-${scope}`,
      ranks: BOARD_RANKS[scope],
      lastUpdated: this.updated().find((board) => board.scope === scope)?.lastUpdated ?? null,
    })),
  );

  constructor() {
    this.trackViewport();

    // The router scrolls an anchor with `scrollBy`, so it ignores
    // `scroll-margin-top` and lands every heading under the sticky header. The
    // offset is a function because that header is measured, not fixed.
    const scroller = inject(ViewportScroller);
    const root = inject(DOCUMENT).documentElement;
    scroller.setOffset(() => [0, this.stickyHeight(root) + ANCHOR_GAP]);
    inject(DestroyRef).onDestroy(() => scroller.setOffset([0, 0]));

    // A deep link is scrolled before the live figures arrive, and the league
    // line they add sits above most of the page.
    const fragment = inject(ActivatedRoute).snapshot.fragment;
    const injector = inject(Injector);
    const keepAnchor = () => {
      if (fragment) afterNextRender(() => scroller.scrollToAnchor(fragment), { injector });
    };

    this.api.getLeagues().subscribe((leagues) => {
      this.leagues.set(leagues);
      keepAnchor();
    });
    this.api.getBoardsLastUpdated().subscribe((boards) => {
      this.updated.set(boards);
      keepAnchor();
    });
  }

  private trackViewport(): void {
    const view = inject(DOCUMENT).defaultView;
    if (!view) return;
    const query = view.matchMedia(WIDE_VIEWPORT);
    const apply = () => this.wideViewport.set(query.matches);
    apply();
    query.addEventListener('change', apply);
    inject(DestroyRef).onDestroy(() => query.removeEventListener('change', apply));
  }

  private stickyHeight(root: HTMLElement): number {
    const height = getComputedStyle(root).getPropertyValue('--sticky-top-height');
    return Number.parseFloat(height) || 0;
  }

  protected signed(rating: number): string {
    return `${rating > 0 ? '+' : ''}${Math.round(rating)}`;
  }
}
