import { Component, ChangeDetectionStrategy, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { LeagueFilterService } from '../league-filter.service';
import { RankingsApiService } from '../rankings-api.service';
import { BOARD_SCOPES, type BoardScope, type LeagueSummary } from '../models';

@Component({
  selector: 'app-rankings-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet, DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rankings-shell.component.html',
  styleUrl: './rankings-shell.component.scss',
})
export class RankingsShellComponent {
  private readonly api = inject(RankingsApiService);

  protected readonly filter = inject(LeagueFilterService);
  protected readonly scopes = BOARD_SCOPES;

  /**
   * Regional strength is shown alongside every board, not on a tab of its own.
   * It is the only place the league rating appears now that it is no longer
   * added to team ratings, and it is context for whichever board you are
   * reading rather than a ranking in its own right.
   */
  protected readonly leagues = signal<LeagueSummary[]>([]);

  constructor() {
    this.api.getLeagues().subscribe((leagues) => this.leagues.set(leagues));
  }

  protected label(scope: BoardScope): string {
    return scope === 'international' ? 'International' : scope;
  }

  /**
   * Half-width of the diverging meter, as a percentage. League ratings are
   * offsets from "no region assumed stronger", so the bar grows out from a
   * centre line rather than from the left edge.
   */
  protected barWidth(rating: number): number {
    const max = Math.max(...this.leagues().map((l) => Math.abs(l.rating)), 1);
    return (Math.abs(rating) / max) * 50;
  }

  protected barLeft(rating: number): number {
    return rating >= 0 ? 50 : 50 - this.barWidth(rating);
  }
}
