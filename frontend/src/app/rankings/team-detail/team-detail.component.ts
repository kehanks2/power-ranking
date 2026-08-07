import { Component, ChangeDetectionStrategy, inject, signal, effect } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DecimalPipe, NgOptimizedImage, PercentPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { RankingsApiService } from '../rankings-api.service';
import type { TeamDetail, TeamRecord } from '../models';

@Component({
  selector: 'app-team-detail',
  imports: [DecimalPipe, NgOptimizedImage, PercentPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './team-detail.component.html',
  styleUrl: './team-detail.component.scss',
})
export class TeamDetailComponent {
  private readonly api = inject(RankingsApiService);
  private readonly route = inject(ActivatedRoute);

  private readonly teamId = toSignal(this.route.paramMap, { initialValue: this.route.snapshot.paramMap });

  protected readonly team = signal<TeamDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly notFound = signal(false);

  constructor() {
    effect((onCleanup) => {
      const idParam = this.teamId().get('id');
      const id = idParam ? Number(idParam) : Number.NaN;
      if (!Number.isInteger(id)) {
        this.notFound.set(true);
        this.loading.set(false);
        return;
      }
      this.loading.set(true);
      this.notFound.set(false);
      const subscription = this.api.getTeamById(id).subscribe({
        next: (team) => {
          this.team.set(team);
          this.loading.set(false);
        },
        error: () => {
          this.notFound.set(true);
          this.loading.set(false);
        },
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }

  /**
   * Which series rows are expanded, keyed by section-prefixed event name --
   * "intl:" and "reg:" because a split and an event can share a name. Held as a
   * Set in a signal rather than a flag on the row: the rows arrive from the API
   * and copying them to carry UI state would mean re-copying on every load.
   */
  private readonly openRows = signal<ReadonlySet<string>>(new Set());

  protected isOpen(key: string): boolean {
    return this.openRows().has(key);
  }

  protected toggle(key: string): void {
    this.openRows.update((open) => {
      const next = new Set(open);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /**
   * A DOM-safe id for a row's detail so `aria-controls` can name it. Event
   * names carry spaces, colons, and accents, none of which belong in an id.
   */
  protected detailId(key: string): string {
    return `series-detail-${key.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  }

  private total(rows: TeamRecord[]): { wins: number; losses: number } {
    return rows.reduce(
      (acc, row) => ({ wins: acc.wins + row.wins, losses: acc.losses + row.losses }),
      { wins: 0, losses: 0 },
    );
  }

  protected seriesTotal(rows: TeamRecord[]): { wins: number; losses: number } {
    return rows.reduce(
      (acc, row) => ({ wins: acc.wins + row.seriesWins, losses: acc.losses + row.seriesLosses }),
      { wins: 0, losses: 0 },
    );
  }

  /**
   * The headline rate, and the only one shown outside an expanded row. Series
   * are what decide placement: a team that wins four series 3-2 is 4-0 here,
   * which is what the bracket says about them, while its game rate is 12-8.
   *
   * 0 rather than NaN for a team with no games, so an empty row still renders.
   */
  protected seriesWinRate(rows: TeamRecord[]): number {
    const { wins, losses } = this.seriesTotal(rows);
    return wins + losses === 0 ? 0 : wins / (wins + losses);
  }

  /** Games won as a share of games played -- detail, shown inside an open row. */
  protected winRate(rows: TeamRecord[]): number {
    const { wins, losses } = this.total(rows);
    return wins + losses === 0 ? 0 : wins / (wins + losses);
  }

  /**
   * Ordinals, matching the placement pills on the board. Shared finishes stay
   * as the range Liquipedia reports -- "5-8th" would not read, and "5th" would
   * claim a place the data does not support.
   */
  protected finish(placement: string | null): string {
    if (!placement) return '—';
    if (!/^\d+$/.test(placement)) return placement;
    const n = Number(placement);
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
