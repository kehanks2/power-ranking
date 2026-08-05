import { Component, ChangeDetectionStrategy, inject, signal, computed, effect } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { RankingsApiService } from '../rankings-api.service';
import { LeagueFilterService } from '../league-filter.service';
import type { PlayerSummary } from '../models';

@Component({
  selector: 'app-players-list',
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './players-list.component.html',
  styleUrl: './players-list.component.scss',
})
export class PlayersListComponent {
  private readonly api = inject(RankingsApiService);
  protected readonly filterService = inject(LeagueFilterService);

  protected readonly players = signal<PlayerSummary[]>([]);
  protected readonly loading = signal(true);

  /**
   * The shared league chips offer 'all', but there is no meaningful
   * cross-league list of REGIONAL ratings -- they are within-league
   * percentiles, so pooling them ranks nothing. 'all' therefore selects the
   * international view instead, which is genuinely cross-league.
   */
  protected readonly isGlobal = computed(() => this.filterService.selectedLeague() === 'all');
  protected readonly regionLabel = computed(() => {
    const league = this.filterService.selectedLeague();
    return league === 'all' ? 'international' : league;
  });

  // Built here rather than inline in the template: an apostrophe written as
  // `&apos;` inside a template interpolation is not decoded, so it renders
  // literally as "Int&apos;l games".
  protected readonly gamesColumnLabel = computed(() => (this.isGlobal() ? "Int'l games" : 'Games'));

  constructor() {
    effect((onCleanup) => {
      const league = this.filterService.selectedLeague();
      this.loading.set(true);
      const subscription = this.api.getPlayers(league).subscribe((players) => {
        this.players.set(players);
        this.loading.set(false);
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }
}
