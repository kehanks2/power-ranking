import { ChangeDetectionStrategy, Component, ElementRef, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RankingsApiService } from '../rankings-api.service';
import { TooltipDirective } from '../tooltip.directive';
import {
  INTERNATIONAL_EVENTS,
  type ChampionBoard,
  type ChampionIndex,
  type ChampionRow,
  type ChampionWindow,
} from '../models';


type SortKey = 'presence' | 'pickRate' | 'banRate' | 'winRate' | 'gamesPicked';

type PanelKey = 'year' | 'region' | 'window';

interface EventOption {
  key: string;
  label: string;
  /** An event with no games yet -- listed, but not selectable. */
  disabled: boolean;
}

@Component({
  selector: 'app-champions-list',
  imports: [DecimalPipe, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './champions-list.component.html',
  styleUrl: './champions-list.component.scss',
  host: {
    '(document:pointerdown)': 'onDocumentPointerDown($event)',
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class ChampionsListComponent {
  private readonly api = inject(RankingsApiService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected readonly openPanel = signal<PanelKey | null>(null);

  protected readonly index = signal<ChampionIndex | null>(null);
  protected readonly board = signal<ChampionBoard | null>(null);
  protected readonly loading = signal(true);

  protected readonly year = signal<number | null>(null);
  protected readonly scope = signal('all');
  protected readonly window = signal<ChampionWindow>('year');

  private readonly sortKey = signal<SortKey>('presence');
  private readonly sortDescending = signal(true);

  /** Portraits that failed to load; the row falls back to the name alone. */
  private readonly portraitFailed = signal<ReadonlySet<string>>(new Set());

  constructor() {
    this.api.getChampionIndex().subscribe((index) => {
      this.index.set(index);
      this.year.set(index.years[0] ?? null);
      this.load();
    });
  }

  protected readonly years = computed(() => this.index()?.years ?? []);

  protected readonly leagues = computed(() => {
    const year = this.year();
    return year === null ? [] : (this.index()?.leaguesByYear[year] ?? []);
  });

  /**
   * All three events, always. An unplayed Worlds has no tournament row at all --
   * the pull reaches only 21 days forward -- so dropping it would make "not yet"
   * and "never" look the same; it is listed and disabled instead.
   */
  protected readonly events = computed<EventOption[]>(() => {
    const index = this.index();
    const year = this.year();
    if (!index || year === null) return [];
    const played = new Set(index.eventsByYear[year] ?? []);
    return INTERNATIONAL_EVENTS.map((event) => ({
      key: event.key,
      label: event.label,
      disabled: !played.has(event.key),
    }));
  });

  /** Every scope that can currently be chosen, for validating one across years. */
  private readonly selectableScopes = computed(() => [
    'all',
    ...this.leagues(),
    'international',
    ...this.events().filter((event) => !event.disabled).map((event) => event.key),
  ]);

  /**
   * Only a regional scope has a split to narrow to, and only in a year that
   * holds a current split -- offering it on a past year would serve a board
   * that is empty by definition, since the split being run is this year's.
   */
  protected readonly splitAvailable = computed(() => {
    const index = this.index();
    const year = this.year();
    if (!index || year === null || !index.splitYears.includes(year)) return false;
    const scope = this.scope();
    return scope === 'all' || (index.leaguesByYear[year] ?? []).includes(scope);
  });

  protected readonly rows = computed(() => {
    const rows = [...(this.board()?.rows ?? [])];
    const key = this.sortKey();
    const descending = this.sortDescending() ? -1 : 1;
    return rows.sort((a, b) => {
      // A champion never picked has no win rate. It sorts to the bottom rather
      // than reading as 0%, which would rank it below a genuine 1%.
      const left = a[key] ?? Number.NEGATIVE_INFINITY;
      const right = b[key] ?? Number.NEGATIVE_INFINITY;
      if (left === right) return a.champion.localeCompare(b.champion);
      return (left < right ? -1 : 1) * descending;
    });
  });

  protected readonly coverage = computed(() => this.board()?.coverage ?? []);

  protected togglePanel(panel: PanelKey): void {
    this.openPanel.update((open) => (open === panel ? null : panel));
  }

  /**
   * Closes an open panel on a click anywhere outside the filter bar, and on
   * Escape. Bound through the decorator's `host`, not @HostListener.
   */
  protected onDocumentPointerDown(event: Event): void {
    if (this.openPanel() === null) return;
    const target = event.target as Node | null;
    if (target && this.host.nativeElement.querySelector('.filterbar')?.contains(target)) return;
    this.openPanel.set(null);
  }

  protected onEscape(): void {
    this.openPanel.set(null);
  }

  /** "Region" for a league, "International" once an event is in view. */
  protected readonly regionTabLabel = computed(() =>
    this.scope() === 'international' || this.events().some((event) => event.key === this.scope())
      ? 'International'
      : 'Region',
  );

  protected readonly regionTabValue = computed(() => {
    const scope = this.scope();
    if (scope === 'all') return 'All leagues';
    if (scope === 'international') return 'All events';
    return this.events().find((event) => event.key === scope)?.label ?? scope;
  });

  protected selectYear(year: number): void {
    this.openPanel.set(null);
    if (this.year() === year) return;
    this.year.set(year);
    // The scope may not exist in the newly chosen year -- a league can come and
    // go, and an event may not have been played -- so fall back rather than
    // requesting a document that was never written.
    if (!this.selectableScopes().includes(this.scope())) this.scope.set('all');
    // A past year has no current split, so leaving the window on 'split' would
    // request a document that was never written.
    if (!this.splitAvailable()) this.window.set('year');
    this.load();
  }

  protected selectScope(key: string): void {
    this.openPanel.set(null);
    if (this.scope() === key) return;
    this.scope.set(key);
    if (!this.splitAvailable()) this.window.set('year');
    this.load();
  }

  protected selectWindow(window: ChampionWindow): void {
    this.openPanel.set(null);
    if (this.window() === window) return;
    this.window.set(window);
    this.load();
  }

  protected sortBy(key: SortKey): void {
    if (this.sortKey() === key) {
      this.sortDescending.update((descending) => !descending);
      return;
    }
    this.sortKey.set(key);
    this.sortDescending.set(true);
  }

  protected sortState(key: SortKey): 'ascending' | 'descending' | 'none' {
    if (this.sortKey() !== key) return 'none';
    return this.sortDescending() ? 'descending' : 'ascending';
  }

  /** Drawn only on the sorted column; `aria-sort` carries it for screen readers. */
  protected arrow(key: SortKey): string {
    if (this.sortKey() !== key) return '';
    return this.sortDescending() ? '▼' : '▲';
  }

  protected ofGames(count: number, total: number, verb = 'available'): string {
    return `${count} of ${total} games ${verb}`;
  }

  protected presenceTitle(row: ChampionRow): string {
    return `${row.gamesPicked} picked, ${row.gamesBanned} banned of ${row.gamesAvailable} games available`;
  }

  /** 'international' is far longer than a league slug and would truncate. */
  protected coverageLabel(slug: string): string {
    return slug === 'international' ? 'Intl' : slug;
  }

  protected portrait(row: ChampionRow): string | null {
    if (!row.assetKey || this.portraitFailed().has(row.assetKey)) return null;
    return this.api.championPortrait(row.assetKey);
  }

  protected onPortraitError(row: ChampionRow): void {
    if (!row.assetKey) return;
    this.portraitFailed.update((failed) => new Set(failed).add(row.assetKey!));
  }

  protected coveragePct(entry: { games: number; gamesWithDraft: number }): number {
    return entry.games === 0 ? 0 : entry.gamesWithDraft / entry.games;
  }

  private load(): void {
    const year = this.year();
    if (year === null) return;
    this.loading.set(true);
    this.api.getChampions(year, this.scope(), this.window()).subscribe({
      next: (board) => {
        this.board.set(board);
        this.loading.set(false);
      },
      error: () => {
        this.board.set(null);
        this.loading.set(false);
      },
    });
  }
}
