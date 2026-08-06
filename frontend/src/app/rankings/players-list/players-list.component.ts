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
   * There is no meaningful cross-league list of REGIONAL player ratings --
   * they are within-league percentiles, so every league's distribution is
   * centred on ~50 and pooling them ranks nothing. The International board
   * serves that need instead, rating players purely on games they played
   * against each other.
   */
  protected readonly isGlobal = computed(() => this.filterService.selectedScope() === 'international');
  protected readonly regionLabel = computed(() => {
    const scope = this.filterService.selectedScope();
    return scope === 'international' ? 'international' : scope;
  });

  // Built here rather than inline in the template: an apostrophe written as
  // `&apos;` inside a template interpolation is not decoded, so it renders
  // literally as "Int&apos;l games".
  protected readonly gamesColumnLabel = computed(() => (this.isGlobal() ? "Int'l games" : 'Games'));

  constructor() {
    effect((onCleanup) => {
      const scope = this.filterService.selectedScope();
      this.loading.set(true);
      const subscription = this.api.getPlayers(scope).subscribe((players) => {
        this.players.set(players);
        this.loading.set(false);
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }
}
