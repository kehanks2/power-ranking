import { Component, ChangeDetectionStrategy, inject, signal, computed, effect } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { RankingsApiService } from '../rankings-api.service';
import { LeagueFilterService } from '../league-filter.service';
import type { PlayerDetail, PlayerStat, PlayerSummary } from '../models';

/** One stat as the panel renders it: already formatted, with its standing. */
interface StatView {
  label: string;
  display: string;
  /** "3rd", or null when the player has no value for this stat. */
  place: string | null;
  /** 0-1, how far from last to first -- what the bar length shows. */
  fill: number;
  /** Spelled out for the tooltip and for screen readers. */
  standing: string;
}

@Component({
  selector: 'app-players-list',
  imports: [DecimalPipe, PercentPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './players-list.component.html',
  styleUrl: './players-list.component.scss',
})
export class PlayersListComponent {
  private readonly api = inject(RankingsApiService);
  protected readonly filterService = inject(LeagueFilterService);

  protected readonly players = signal<PlayerSummary[]>([]);
  protected readonly loading = signal(true);

  /** The row whose panel is open. Only one at a time -- a board of open panels scrolls badly. */
  protected readonly openPlayerId = signal<number | null>(null);
  protected readonly detail = signal<PlayerDetail | null>(null);
  protected readonly detailLoading = signal(false);

  /**
   * There is no meaningful cross-league list of REGIONAL player ratings --
   * they are within-league percentiles, so every league's distribution is
   * centred on ~50 and pooling them ranks nothing. The International board
   * serves that need instead, rating players purely on games they played
   * against each other.
   */
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
  protected readonly columnCount = computed(() => (this.isGlobal() ? 7 : 6));

  /** What the numbers in the panel are measured over -- never left implicit. */
  protected readonly coverageNote = computed(() =>
    this.isGlobal()
      ? 'International games from the last 3 years — the same games this rating is built from, not their league season.'
      : 'Every recorded game in this league, most recent weighted highest.',
  );

  protected readonly stats = computed<StatView[]>(() => {
    const detail = this.detail();
    if (!detail) return [];
    const s = detail.stats;
    const peers = detail.peerCount;

    const view = (label: string, stat: PlayerStat, display: (v: number) => string): StatView => ({
      label,
      display: stat.value === null ? '—' : display(stat.value),
      place: stat.place === null ? null : this.ordinal(stat.place),
      // Longest bar is 1st, shortest is last. Guarded against a peer group of
      // one, where there is no spread to show.
      fill: stat.place === null || peers <= 1 ? 0 : (peers - stat.place + 1) / peers,
      standing:
        stat.place === null
          ? 'No games on this board to place'
          : `${this.ordinal(stat.place)} of ${peers} ${detail.role} players on this board`,
    });

    const to = (places: number) => (v: number) => v.toFixed(places);
    const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
    // Signed, because the sign IS the reading: negative means behind the
    // player they were matched against.
    const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`;

    return [
      view('KDA', s.kda, to(2)),
      view('Kills', s.kills, to(1)),
      view('Deaths', s.deaths, to(1)),
      view('Assists', s.assists, to(1)),
      view('CS / min', s.csPerMin, to(1)),
      view('Gold vs. lane', s.goldDiff, signed),
      view('Kill participation', s.killParticipation, pct),
      view('Damage share', s.damageShare, pct),
      view('Gold share', s.goldShare, pct),
    ];
  });

  constructor() {
    effect((onCleanup) => {
      const scope = this.filterService.selectedScope();
      this.loading.set(true);
      // A panel left open across a tab switch would show one board's stats
      // under another board's row.
      this.openPlayerId.set(null);
      this.detail.set(null);
      const subscription = this.api.getPlayers(scope).subscribe((players) => {
        this.players.set(players);
        this.loading.set(false);
      });
      onCleanup(() => subscription.unsubscribe());
    });

    effect((onCleanup) => {
      const playerId = this.openPlayerId();
      if (playerId === null) return;
      const scope = this.filterService.selectedScope();
      this.detailLoading.set(true);
      const subscription = this.api.getPlayerById(playerId, scope).subscribe({
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

  protected toggle(playerId: number): void {
    const isOpen = this.openPlayerId() === playerId;
    this.openPlayerId.set(isOpen ? null : playerId);
    if (isOpen) this.detail.set(null);
  }

  protected isOpen(playerId: number): boolean {
    return this.openPlayerId() === playerId;
  }

  /** Bands, so the bar reads at a glance and not only by length. */
  protected band(fill: number): string {
    if (fill >= 0.75) return 'high';
    if (fill >= 0.4) return 'mid';
    return 'low';
  }

  /** 1st, 2nd, 3rd, 4th -- and 11th/12th/13th, which break the pattern. */
  private ordinal(n: number): string {
    const teens = n % 100;
    if (teens >= 11 && teens <= 13) return `${n}th`;
    switch (n % 10) {
      case 1:
        return `${n}st`;
      case 2:
        return `${n}nd`;
      case 3:
        return `${n}rd`;
      default:
        return `${n}th`;
    }
  }
}
