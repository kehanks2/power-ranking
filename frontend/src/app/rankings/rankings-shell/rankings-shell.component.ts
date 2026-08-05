import { Component, ChangeDetectionStrategy, inject, signal, computed } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter } from 'rxjs';
import { LeagueFilterService } from '../league-filter.service';
import type { LeagueSlug } from '../models';

const LEAGUES: (LeagueSlug | 'all')[] = ['all', 'LCK', 'LPL', 'LEC', 'LCS', 'CBLOL', 'LCP'];

@Component({
  selector: 'app-rankings-shell',
  imports: [RouterLink, RouterLinkActive, RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rankings-shell.component.html',
  styleUrl: './rankings-shell.component.scss',
})
export class RankingsShellComponent {
  private readonly router = inject(Router);

  protected readonly filter = inject(LeagueFilterService);
  protected readonly leagues = LEAGUES;

  private readonly url = signal(this.router.url);

  constructor() {
    this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => this.url.set(this.router.url));
  }

  /**
   * On Teams and Leagues, 'all' really is every league on one comparable
   * scale -- those ratings are calibrated against each other through
   * international play. On Players it is NOT: regional player ratings are
   * within-league percentiles, so 'all' serves the international-only view
   * instead. Different meaning, so it gets a different label rather than
   * quietly reusing "All Leagues".
   */
  protected readonly allLabel = computed(() => (this.url().includes('/players') ? 'Global' : 'All Leagues'));
}
