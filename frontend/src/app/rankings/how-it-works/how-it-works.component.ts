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

/** Breathing room between the sticky header and a heading jumped to. */
const ANCHOR_GAP = 16;

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

  /** Every id here has to be a heading on the page; the spec asserts it. */
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
    // Angular's scroller lands an anchor flush at the viewport top with
    // `scrollBy`, so it ignores `scroll-margin-top` and every heading arrived
    // underneath the sticky header. The offset is read at scroll time because
    // the header's height is measured, not fixed -- 94px on a desktop, 142
    // once the tabs wrap on a phone.
    const scroller = inject(ViewportScroller);
    const root = inject(DOCUMENT).documentElement;
    scroller.setOffset(() => [0, this.stickyHeight(root) + ANCHOR_GAP]);
    inject(DestroyRef).onDestroy(() => scroller.setOffset([0, 0]));

    // A deep link is scrolled before the live figures arrive, and the league
    // line they add sits above most of the page -- so the anchor has to be
    // taken again once they have rendered, or it lands 78px short.
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

  private stickyHeight(root: HTMLElement): number {
    const height = getComputedStyle(root).getPropertyValue('--sticky-top-height');
    return Number.parseFloat(height) || 0;
  }

  protected signed(rating: number): string {
    return `${rating > 0 ? '+' : ''}${Math.round(rating)}`;
  }
}
