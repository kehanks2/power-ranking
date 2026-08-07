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

  protected total(rows: TeamRecord[]): { wins: number; losses: number } {
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

  /** 0 rather than NaN for a team with no games, so an empty row still renders. */
  protected winRate(rows: TeamRecord[]): number {
    const { wins, losses } = this.total(rows);
    return wins + losses === 0 ? 0 : wins / (wins + losses);
  }

  /**
   * "Bo3 · Bo5" -- what the series record is a record OF. A 12-6 in Bo1s and a
   * 12-6 in Bo5s are different seasons, and this is the column that says which
   * one you are reading; most events run a shorter regular season and a longer
   * playoff, so more than one is normal rather than a data problem.
   */
  protected formatLabel(formats: number[]): string {
    if (formats.length === 0) return '—';
    return formats.map((n) => `Bo${n}`).join(' · ');
  }

  /** The set across a whole section, for the totals row. */
  protected allFormats(rows: TeamRecord[]): number[] {
    return [...new Set(rows.flatMap((row) => row.formats))].sort((a, b) => a - b);
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
