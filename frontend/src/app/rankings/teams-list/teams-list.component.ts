import { Component, ChangeDetectionStrategy, inject, signal, effect } from '@angular/core';
import { NgOptimizedImage, DecimalPipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { RankingsApiService } from '../rankings-api.service';
import { LeagueFilterService } from '../league-filter.service';
import type { TeamSummary } from '../models';

/** RD above this threshold means the rating carries too little evidence to trust yet. */
const UNPROVEN_RD_THRESHOLD = 150;

@Component({
  selector: 'app-teams-list',
  imports: [NgOptimizedImage, DecimalPipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './teams-list.component.html',
  styleUrl: './teams-list.component.scss',
})
export class TeamsListComponent {
  private readonly api = inject(RankingsApiService);
  protected readonly filterService = inject(LeagueFilterService);

  protected readonly teams = signal<TeamSummary[]>([]);
  protected readonly loading = signal(true);

  constructor() {
    effect((onCleanup) => {
      const league = this.filterService.selectedLeague();
      this.loading.set(true);
      const subscription = this.api.getTeams(league).subscribe((teams) => {
        this.teams.set(teams);
        this.loading.set(false);
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }

  protected isUnproven(rd: number): boolean {
    return rd > UNPROVEN_RD_THRESHOLD;
  }
}
