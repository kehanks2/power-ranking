import { Component, ChangeDetectionStrategy, inject, signal, computed, effect } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { RankingsApiService } from '../rankings-api.service';
import { LeagueFilterService } from '../league-filter.service';
import type { TeamSummary } from '../models';

/** The four most recent international events, newest first. Column order on the board. */
const RECENT_EVENTS = ['MSI26', 'FS26', 'W25', 'MSI25'] as const;

/** Axis gridline spacing, in rating points. */
const AXIS_STEP = 100;

type SortKey = 'floor' | 'rating';

interface AxisTick {
  value: number;
  left: number;
}

@Component({
  selector: 'app-teams-list',
  imports: [DecimalPipe, RouterLink],
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
   */
  protected slotLabel(team: TeamSummary, event: string): string {
    const result = this.resultFor(team, event);
    if (!result) return '–';
    return result.placement ?? event.slice(0, -2);
  }

  protected slotTitle(team: TeamSummary, event: string): string {
    const result = this.resultFor(team, event);
    if (!result) return `Did not play ${event}`;
    return result.placement ? `${event}: finished ${result.placement}` : `Played ${event}, finish unknown`;
  }

  /** Winners get their own treatment -- a tournament win is the headline result. */
  protected isWin(team: TeamSummary, event: string): boolean {
    return this.resultFor(team, event)?.placement === '1';
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
