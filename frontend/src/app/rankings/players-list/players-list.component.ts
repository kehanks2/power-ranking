import {
  Component,
  ChangeDetectionStrategy,
  Injector,
  afterNextRender,
  inject,
  signal,
  computed,
  effect,
} from '@angular/core';
import { DOCUMENT, DecimalPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { RankingsApiService } from '../rankings-api.service';
import { LeagueFilterService } from '../league-filter.service';
import { ConfidenceAxisComponent } from '../confidence/confidence-axis.component';
import { ConfidenceRangeComponent } from '../confidence/confidence-range.component';
import { PlayerPanelComponent } from '../player-panel/player-panel.component';
import { RankChangeComponent } from '../rank-change/rank-change.component';
import { RATING_WINDOWS, ROLES, type PlayerDetail, type PlayerSummary, type RatingWindow, type Role } from '../models';

@Component({
  selector: 'app-players-list',
  imports: [
    DecimalPipe,
    RouterLink,
    ConfidenceAxisComponent,
    ConfidenceRangeComponent,
    PlayerPanelComponent,
    RankChangeComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './players-list.component.html',
  styleUrl: './players-list.component.scss',
})
export class PlayersListComponent {
  private readonly api = inject(RankingsApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  protected readonly filterService = inject(LeagueFilterService);

  // Read once, not tracked: it says which row to open on arrival, and keeping it
  // live would re-open that row every time the reader closed it.
  private readonly requestedPlayerId = Number(this.route.snapshot.queryParamMap.get('player'));
  private openedFromLink = false;

  private readonly allPlayers = signal<PlayerSummary[]>([]);
  protected readonly loading = signal(true);

  // Role filter is client-side: places in the panel are measured against the
  // whole role peer group, so narrowing the view must not change the numbers.
  protected readonly roles = ROLES;
  protected readonly roleFilter = signal<Role | null>(null);

  // Window is server-side, unlike the role filter: each is its own set of
  // ratings from its own games, not a subset of one board.
  protected readonly windows = RATING_WINDOWS;
  protected readonly window = signal<RatingWindow>('all');

  // Renumbered 1..n for whatever is shown; the rating is unaffected (always
  // measured against role peers).
  //
  // The carets are renumbered too. The server's delta is against the whole
  // board, so leaving it alone puts "+7" next to a role-filtered rank of 3 and
  // the visible deltas stop cancelling. A player's prior board rank is
  // recoverable as rank + rankChange (positive means they rose, so their number
  // was higher), which re-sorts into the prior ordering of whatever subset is
  // shown. Rows the server dashed have no prior rank, so they stay dashed and
  // sit outside the comparison rather than shifting everyone else's.
  protected readonly players = computed(() => {
    const role = this.roleFilter();
    const rows = this.allPlayers();
    if (role === null) return rows;

    const filtered = rows.filter((p) => p.role === role);
    const comparable = filtered.filter((p) => p.rankChange !== null);
    const priorRank = new Map(
      [...comparable]
        .sort((a, b) => a.rank + (a.rankChange ?? 0) - (b.rank + (b.rankChange ?? 0)))
        .map((p, index) => [p.id, index + 1] as const),
    );
    const currentRank = new Map(comparable.map((p, index) => [p.id, index + 1] as const));

    return filtered.map((p, index) => ({
      ...p,
      rank: index + 1,
      rankChange: priorRank.has(p.id) ? priorRank.get(p.id)! - currentRank.get(p.id)! : null,
    }));
  });

  /** The row whose panel is open. Only one at a time -- a board of open panels scrolls badly. */
  protected readonly openPlayerId = signal<number | null>(null);
  protected readonly detail = signal<PlayerDetail | null>(null);
  protected readonly detailLoading = signal(false);

  // Regional player ratings are within-league percentiles (each league centred
  // on ~50), so they can't be pooled cross-league; the International board does that.
  protected readonly isGlobal = computed(() => this.filterService.selectedScope() === 'international');
  protected readonly regionLabel = computed(() => {
    const scope = this.filterService.selectedScope();
    return scope === 'international' ? 'international' : scope;
  });

  // Built here rather than inline in the template: an apostrophe written as
  // `&apos;` inside a template interpolation is not decoded, so it renders
  // literally as "Int&apos;l games".
  protected readonly gamesColumnLabel = computed(() => (this.isGlobal() ? "Int'l games" : 'Games'));

  /** Panel spans the whole row, so the count has to track the conditional Region column. */
  protected readonly columnCount = computed(() => (this.isGlobal() ? 8 : 7));

  // What the panel's numbers are measured over. Phrased to match the teams
  // board's panel word for word.
  protected readonly coverageNote = computed(() => {
    if (this.isGlobal()) return 'International Only.';
    const region = this.regionLabel();
    switch (this.window()) {
      case 'year':
        return `${region} Only, this year.`;
      case 'split':
        return `${region} Only, this split.`;
      default:
        return `${region} Only.`;
    }
  });

  // Said on the short windows: fewer games means ratings sit closer to the
  // neutral 50, which is honest, not a filter bug.
  protected readonly windowCaveat = computed(() =>
    this.window() === 'all'
      ? null
      : 'Fewer games behind every rating here, so they sit closer to the neutral 50 than the full-history board does.',
  );

  constructor() {
    effect((onCleanup) => {
      const scope = this.filterService.selectedScope();
      const window = this.window();
      this.loading.set(true);
      // A panel left open across a tab switch would show one board's stats
      // under another board's row.
      this.openPlayerId.set(null);
      this.detail.set(null);
      const subscription = this.api.getPlayers(scope, window).subscribe((players) => {
        this.allPlayers.set(players);
        this.loading.set(false);
        this.openRequestedPlayer(players);
      });
      onCleanup(() => subscription.unsubscribe());
    });

    effect((onCleanup) => {
      const playerId = this.openPlayerId();
      if (playerId === null) return;
      const scope = this.filterService.selectedScope();
      const window = this.window();
      this.detailLoading.set(true);
      const subscription = this.api.getPlayerById(playerId, scope, window).subscribe({
        next: (detail) => {
          this.detail.set(detail);
          this.detailLoading.set(false);
        },
        error: () => {
          this.detail.set(null);
          this.detailLoading.set(false);
        },
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }

  protected setWindow(window: RatingWindow): void {
    this.window.set(window);
  }

  protected windowLabel(window: RatingWindow): string {
    switch (window) {
      case 'year':
        return 'This year';
      case 'split':
        return 'This split';
      default:
        // Not "All time": every game we hold is nowhere near a career.
        return 'All data';
    }
  }

  protected windowHint(window: RatingWindow): string {
    switch (window) {
      case 'year':
        return 'Games from the calendar year this league’s current split sits in';
      case 'split':
        return 'Games from this league’s current split only';
      default:
        return 'Every game we hold, with recent ones counting for more';
    }
  }

  protected setRole(role: Role | null): void {
    this.roleFilter.set(role);
    // A panel left open can belong to a row the filter just removed.
    this.openPlayerId.set(null);
    this.detail.set(null);
  }

  protected toggle(playerId: number): void {
    const isOpen = this.openPlayerId() === playerId;
    this.openPlayerId.set(isOpen ? null : playerId);
    if (isOpen) this.detail.set(null);
  }

  protected isOpen(playerId: number): boolean {
    return this.openPlayerId() === playerId;
  }

  /**
   * Opens the row a `?player=` link asked for, once, and scrolls to it -- a
   * board is long enough that landing on it without scrolling looks like the
   * link did nothing. Silently ignored when that player has no row here.
   */
  private openRequestedPlayer(players: PlayerSummary[]): void {
    const id = this.requestedPlayerId;
    if (!id || this.openedFromLink) return;
    if (!players.some((p) => p.id === id)) return;
    this.openedFromLink = true;
    this.openPlayerId.set(id);
    afterNextRender(() => this.document.getElementById(`player-row-${id}`)?.scrollIntoView({ block: 'center' }), {
      injector: this.injector,
    });
  }
}
