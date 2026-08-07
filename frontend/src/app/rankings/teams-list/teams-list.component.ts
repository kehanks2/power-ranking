import { Component, ChangeDetectionStrategy, inject, signal, computed, effect } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { RankingsApiService } from '../rankings-api.service';
import { LeagueFilterService } from '../league-filter.service';
import type { TeamDetail, TeamRecord, TeamSummary } from '../models';

/**
 * The six most recent international events, OLDEST first. Column order on the
 * board, and the same window the international rating is built from -- showing
 * four while rating on six had the evidence column disagree with the number
 * beside it. At three events a year this is exactly two years.
 *
 * Oldest-left so it runs the same direction as the confidence range beside it;
 * two adjacent columns reading in opposite directions is a needless stumble.
 */
const RECENT_EVENTS = ['W24', 'FS25', 'MSI25', 'W25', 'FS26', 'MSI26'] as const;

/** Axis gridline spacing, in rating points. */
const AXIS_STEP = 100;

type SortKey = 'floor' | 'rating';

interface AxisTick {
  value: number;
  left: number;
}

@Component({
  selector: 'app-teams-list',
  imports: [DecimalPipe, PercentPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './teams-list.component.html',
  styleUrl: './teams-list.component.scss',
})
export class TeamsListComponent {
  private readonly api = inject(RankingsApiService);
  protected readonly filterService = inject(LeagueFilterService);

  protected readonly teams = signal<TeamSummary[]>([]);
  protected readonly loading = signal(true);
  protected readonly sortKey = signal<SortKey>('floor');
  protected readonly events = RECENT_EVENTS;

  protected readonly isInternational = computed(() => this.filterService.selectedScope() === 'international');

  /** The row whose panel is open. One at a time -- a board of open panels scrolls badly. */
  protected readonly openTeamId = signal<number | null>(null);
  protected readonly detail = signal<TeamDetail | null>(null);
  protected readonly detailLoading = signal(false);

  /** Panel spans the whole row, so the count has to track the conditional Region column. */
  protected readonly columnCount = computed(() => (this.isInternational() ? 9 : 8));

  /**
   * The records that belong to the board being read. An international board
   * showing a team's domestic splits would be answering a question nobody
   * asked of it, and the totals would not reconcile with the Games column.
   */
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
    return { ...sum, games, winRate: games === 0 ? 0 : sum.wins / games };
  });

  protected readonly sorted = computed(() => {
    const key = this.sortKey();
    return [...this.teams()].sort((a, b) => b[key] - a[key]);
  });

  /**
   * Shared scale for every range bar on the board, so bars can be read against
   * each other and against the axis. Recomputed per board, because
   * international ratings carry far wider ranges than regional ones.
   */
  private readonly bounds = computed(() => {
    const rows = this.teams();
    if (rows.length === 0) return { lo: 0, hi: 1 };
    const lo = Math.floor(Math.min(...rows.map((t) => t.floor)) / AXIS_STEP) * AXIS_STEP;
    const hi = Math.ceil(Math.max(...rows.map((t) => t.rating + t.rd)) / AXIS_STEP) * AXIS_STEP;
    return { lo, hi: hi === lo ? lo + AXIS_STEP : hi };
  });

  protected readonly ticks = computed<AxisTick[]>(() => {
    const { lo, hi } = this.bounds();
    const out: AxisTick[] = [];
    for (let value = lo; value <= hi; value += AXIS_STEP) out.push({ value, left: this.pct(value) });
    return out;
  });

  constructor() {
    effect((onCleanup) => {
      const scope = this.filterService.selectedScope();
      this.loading.set(true);
      // A panel left open across a tab switch would show one board's record
      // under another board's row.
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
   * What the slot shows: the finish where we have it, the event name where the
   * team played but standings are missing, and a dash where they did not play.
   *
   * Ordinals, because "1st" is how a finish is spoken. Shared finishes stay as
   * the range Liquipedia reports ("5-8") with the ordinal on the end, since
   * "5th-8th" would not fit and "5th" would be a claim we cannot make.
   */
  protected slotLabel(team: TeamSummary, event: string): string {
    const result = this.resultFor(team, event);
    if (!result) return '–';
    if (!result.placement) return event.slice(0, -2);
    return /^\d+$/.test(result.placement) ? this.ordinal(Number(result.placement)) : result.placement;
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

  /**
   * Podium finishes get filled medal colours; everything else stays outlined.
   * A podium is the result people actually remember, so filling only the top
   * three keeps the column scannable instead of a wall of identical boxes.
   * Returns '' for an attended-but-lower finish, and callers handle absence.
   */
  protected medal(team: TeamSummary, event: string): '' | 'gold' | 'silver' | 'bronze' {
    // Shared finishes arrive as ranges ("3-4"), and the lowest number in the
    // range is the one that decides the podium.
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

  /** Placeholder crest: teams.logo_url is empty for every team, so initials stand in. */
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
