import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { NgOptimizedImage, DecimalPipe } from '@angular/common';
import { RankingsApiService } from '../rankings-api.service';
import type { LeagueSummary } from '../models';

@Component({
  selector: 'app-leagues-list',
  imports: [NgOptimizedImage, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './leagues-list.component.html',
  styleUrl: './leagues-list.component.scss',
})
export class LeaguesListComponent {
  private readonly api = inject(RankingsApiService);

  protected readonly leagues = signal<LeagueSummary[]>([]);
  protected readonly loading = signal(true);

  constructor() {
    this.api.getLeagues().subscribe((leagues) => {
      this.leagues.set(leagues);
      this.loading.set(false);
    });
  }
}
