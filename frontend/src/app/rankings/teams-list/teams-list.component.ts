import { Component, ChangeDetectionStrategy, DestroyRef, inject, signal, computed, effect } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { RankingsApiService } from '../rankings-api.service';
import { displayTeamName } from '../team-name';
import { LeagueFilterService } from '../league-filter.service';
import { BoardAnchorService } from '../board-anchor.service';
import type { TeamDetail, TeamRecord, TeamSummary } from '../models';
import { RankChangeComponent } from '../rank-change/rank-change.component';
import { TooltipDirective } from '../tooltip.directive';

/**
 * OLDEST first, and the same window the international rating is built from --
 * rating on six while showing four had the evidence disagree with the number
 * beside it.
 */
const RECENT_EVENTS = ['W24', 'FS25', 'MSI25', 'W25', 'FS26', 'MSI26'] as const;

/** Axis gridline spacing, in rating points. */
/**
 * Axis gridline spacing, in rating points, coarsest first once 100 will not fit.
 *
 * The step is chosen, not fixed: the meter is 200px and a four-digit label is
 * ~26px, so a fixed 100 put seven labels on the international board with 3px
 * between them -- "1200130014001500160017001800".
 */
const AXIS_STEPS = [100, 200, 250, 500, 1000];

/** What fits the track without the labels touching. */
const MAX_AXIS_TICKS = 5;

type SortKey = 'floor' | 'rating';

interface AxisTick {
  value: number;
  left: number;
}

@Component({
  selector: 'app-teams-list',
  imports: [DecimalPipe, PercentPipe, RouterLink, RankChangeComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './teams-list.component.html',
  styleUrl: './teams-list.component.scss',
})
export class TeamsListComponent {
  private readonly api = inject(RankingsApiService);
  private readonly anchor = inject(BoardAnchorService);
  protected readonly filterService = inject(LeagueFilterService);

  protected readonly teams = signal<TeamSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly sortKey = signal<SortKey>('floor');

  protected readonly isInternational = computed(() => this.filterService.selectedScope() === 'international');

  /**
   * Regional order is read from the data, since the codes are per-league
   * (Spr26/Cup26/S126). Results arrive newest-first, so reverse for oldest-left.
   */
  protected readonly events = computed<readonly string[]>(() => {
    if (this.isInternational()) return RECENT_EVENTS;
    const fullest = this.teams().reduce<TeamSummary['results']>(
      (best, t) => (t.results.length > best.length ? t.results : best),
      [],
    );
    return fullest.map((r) => r.event).reverse();
  });

  protected readonly openTeamId = signal<number | null>(null);
  protected readonly detail = signal<TeamDetail | null>(null);
  protected readonly detailLoading = signal(false);

  /** Panel spans the whole row, so the count has to track the conditional Region column. */
  protected readonly columnCount = computed(() => (this.isInternational() ? 9 : 8));

  /** Must match the board being read, or the totals will not reconcile with the Games column. */
  protected readonly panelRecords = computed<TeamRecord[]>(() => {
    const detail = this.detail();
    if (!detail) return [];
    return this.isInternational() ? detail.international : detail.regional;
  });

  protected readonly panelTotals = computed(() => {
    const rows = this.panelRecords();
    const sum = rows.reduce(
      (acc, row) => ({
        wins: acc.wins + row.wins,
        losses: acc.losses + row.losses,
        seriesWins: acc.seriesWins + row.seriesWins,
        seriesLosses: acc.seriesLosses + row.seriesLosses,
      }),
      { wins: 0, losses: 0, seriesWins: 0, seriesLosses: 0 },
    );
    const games = sum.wins + sum.losses;
    const series = sum.seriesWins + sum.seriesLosses;
    // Both rates: a team that keeps winning 3-2 is far better by series than
    // by games, and series are what decide placement.
    return {
      ...sum,
      games,
      winRate: games === 0 ? 0 : sum.wins / games,
      seriesWinRate: series === 0 ? 0 : sum.seriesWins / series,
    };
  });

  protected readonly sorted = computed(() => {
    const key = this.sortKey();
    return [...this.teams()].sort((a, b) => b[key] - a[key]);
  });

  /** One scale for the whole board. Per-board, since international ranges run far wider. */
  private readonly bounds = computed(() => {
    const rows = this.teams();
    if (rows.length === 0) return { lo: 0, hi: 1, step: AXIS_STEPS[0]! };
    const low = Math.min(...rows.map((t) => t.floor));
    const high = Math.max(...rows.map((t) => t.rating + t.rd));
    const step =
      AXIS_STEPS.find((candidate) => Math.ceil(high / candidate) - Math.floor(low / candidate) + 1 <= MAX_AXIS_TICKS) ??
      AXIS_STEPS[AXIS_STEPS.length - 1]!;
    const lo = Math.floor(low / step) * step;
    const hi = Math.ceil(high / step) * step;
    return { lo, hi: hi === lo ? lo + step : hi, step };
  });

  protected readonly ticks = computed<AxisTick[]>(() => {
    const { lo, hi, step } = this.bounds();
    const out: AxisTick[] = [];
    for (let value = lo; value <= hi; value += step) out.push({ value, left: this.pct(value) });
    return out;
  });

  constructor() {
    // The shell's last-updated line reads this: cleared on destroy or the other
    // tab inherits this date, empty while loading or a scope switch shows the
    // old board's baseline under the new board's name.
    effect(() => this.anchor.publish(this.loading() ? [] : this.teams()));
    inject(DestroyRef).onDestroy(() => this.anchor.clear());

    effect((onCleanup) => {
      const scope = this.filterService.selectedScope();
      this.loading.set(true);
      // An open panel would survive into the next board and mismatch its row.
      this.openTeamId.set(null);
      this.detail.set(null);
      const subscription = this.api.getTeams(scope).subscribe({
        next: (teams) => {
          this.teams.set(teams);
          this.loading.set(false);
        },
        error: () => {
          this.teams.set([]);
          this.loading.set(false);
        },
      });
      onCleanup(() => subscription.unsubscribe());
    });

    effect((onCleanup) => {
      const teamId = this.openTeamId();
      if (teamId === null) return;
      this.detailLoading.set(true);
      const subscription = this.api.getTeamById(teamId).subscribe({
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

  protected toggle(teamId: number): void {
    const isOpen = this.openTeamId() === teamId;
    this.openTeamId.set(isOpen ? null : teamId);
    if (isOpen) this.detail.set(null);
  }

  protected isOpen(teamId: number): boolean {
    return this.openTeamId() === teamId;
  }

  protected pct(value: number): number {
    const { lo, hi } = this.bounds();
    return ((value - lo) / (hi - lo)) * 100;
  }

  protected bandWidth(team: TeamSummary): number {
    return this.pct(team.rating + team.rd) - this.pct(team.floor);
  }

  protected setSort(key: SortKey): void {
    this.sortKey.set(key);
  }

  protected resultFor(team: TeamSummary, event: string): { event: string; placement: string | null } | undefined {
    return team.results.find((r) => r.event === event);
  }

  /**
   * A dash covers both "did not play" and "played, no finish yet"; styling and
   * the tooltip carry that difference. Shared finishes stay as Liquipedia's
   * range ("5-8") -- "5th" would be a claim we cannot make.
   */
  protected slotLabel(team: TeamSummary, event: string): string {
    const placement = this.resultFor(team, event)?.placement;
    if (!placement) return '–';
    return /^\d+$/.test(placement) ? this.ordinal(Number(placement)) : placement;
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

  protected slotTitle(team: TeamSummary, event: string): string {
    const result = this.resultFor(team, event);
    if (!result) return `Did not play ${event}`;
    return result.placement ? `${event}: finished ${result.placement}` : `Played ${event}, finish unknown`;
  }

  /** '' for an attended-but-lower finish; callers handle absence. */
  protected medal(team: TeamSummary, event: string): '' | 'gold' | 'silver' | 'bronze' {
    // Shared finishes arrive as ranges ("3-4"); the lowest number decides.
    const placement = this.resultFor(team, event)?.placement;
    if (!placement) return '';
    switch (/^(\d+)/.exec(placement)?.[1]) {
      case '1':
        return 'gold';
      case '2':
        return 'silver';
      case '3':
        return 'bronze';
      default:
        return '';
    }
  }

  /**
   * Crests that failed to load. A stored logo can still 404 -- Team Vitality's
   * wiki file is gone -- and the row must fall back to initials rather than
   * leave a broken image, which no `alt` can rescue at 26px.
   */
  private readonly logoFailed = signal<ReadonlySet<number>>(new Set());

  protected showLogo(team: TeamSummary): boolean {
    return team.logoUrl !== null && !this.logoFailed().has(team.id);
  }

  protected displayName(name: string | null): string {
    return displayTeamName(name);
  }

  protected logoSrc(team: TeamSummary): string {
    return this.api.teamLogo(team.logoUrl!);
  }

  protected onLogoError(teamId: number): void {
    this.logoFailed.update((failed) => new Set(failed).add(teamId));
  }

  /** Stands in for a team with no crest, or one whose crest would not load. */
  protected initials(name: string): string {
    return name
      .replace(/[^A-Za-z0-9 ]/g, '')
      .split(' ')
      .filter(Boolean)
      .slice(0, 2)
      .map((word) => word[0])
      .join('')
      .toUpperCase();
  }
}
