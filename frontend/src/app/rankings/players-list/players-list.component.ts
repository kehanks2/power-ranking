import { Component, ChangeDetectionStrategy, inject, signal, computed, effect } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { RankingsApiService } from '../rankings-api.service';
import { LeagueFilterService } from '../league-filter.service';
import {
  RATING_WINDOWS,
  ROLES,
  type PlayerDetail,
  type PlayerStat,
  type PlayerSummary,
  type RatingWindow,
  type Role,
} from '../models';

/** One stat as the panel renders it: already formatted, with its standing. */
interface StatView {
  label: string;
  display: string;
  /** "3rd", or null when the player has no value for this stat. */
  place: string | null;
  /** 0-1 along the ranking, best at 0. A dot marking position, not a magnitude bar. */
  position: number;
  /** Top quartile of the peer group (a fraction, so it holds across group sizes). */
  standout: boolean;
  /** Spelled out for the tooltip and for screen readers. */
  standing: string;
}

/** The nine stats grouped by the question they answer (Combat / Economy / Team impact). */
interface StatGroup {
  title: string;
  stats: StatView[];
}

@Component({
  selector: 'app-players-list',
  imports: [DecimalPipe, PercentPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './players-list.component.html',
  styleUrl: './players-list.component.scss',
})
export class PlayersListComponent {
  private readonly api = inject(RankingsApiService);
  protected readonly filterService = inject(LeagueFilterService);

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
  protected readonly players = computed(() => {
    const role = this.roleFilter();
    const rows = this.allPlayers();
    if (role === null) return rows;
    return rows.filter((p) => p.role === role).map((p, index) => ({ ...p, rank: index + 1 }));
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
  protected readonly columnCount = computed(() => (this.isGlobal() ? 7 : 6));

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

  protected readonly statGroups = computed<StatGroup[]>(() => {
    const detail = this.detail();
    if (!detail) return [];
    const s = detail.stats;
    const peers = detail.peerCount;

    const view = (label: string, stat: PlayerStat, display: (v: number) => string): StatView => {
      // 1st sits at 0, last at 1. Guarded against a peer group of one, where
      // there is no spread to place anyone along.
      const position = stat.place === null || peers <= 1 ? 0 : (stat.place - 1) / (peers - 1);
      return {
        label,
        display: stat.value === null ? '—' : display(stat.value),
        place: stat.place === null ? null : this.ordinal(stat.place),
        position,
        standout: stat.place !== null && peers > 0 && stat.place <= Math.ceil(peers / 4),
        standing:
          stat.place === null
            ? 'No games on this board to place'
            : `${this.ordinal(stat.place)} of ${peers} ${detail.role} players on this board`,
      };
    };

    const to = (places: number) => (v: number) => v.toFixed(places);
    const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
    // Signed, because the sign IS the reading: negative means behind the
    // player they were matched against.
    const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`;

    return [
      {
        title: 'Combat',
        stats: [
          view('KDA', s.kda, to(2)),
          view('Kills', s.kills, to(1)),
          view('Deaths', s.deaths, to(1)),
          view('Assists', s.assists, to(1)),
        ],
      },
      {
        title: 'Economy',
        stats: [
          view('CS / min', s.csPerMin, to(1)),
          view('Gold vs. lane', s.goldDiff, signed),
          view('Gold share', s.goldShare, pct),
        ],
      },
      {
        title: 'Team impact',
        stats: [
          view('Kill participation', s.killParticipation, pct),
          view('Damage share', s.damageShare, pct),
          view('Objective control', s.objectiveControl, pct),
        ],
      },
    ];
  });

  // Objective control is a jungle stat; it feeds the rating for junglers (and
  // lightly supports) but is display-only context for top/mid/bot.
  protected readonly objectiveControlContextOnly = computed(() => {
    const role = this.detail()?.role;
    return role === 'TOP' || role === 'MID' || role === 'BOT';
  });

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
