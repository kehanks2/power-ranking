import { Component, ChangeDetectionStrategy, inject, signal, computed, effect } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { DecimalPipe, NgOptimizedImage, PercentPipe } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { RankingsApiService } from '../rankings-api.service';
import { ConfidenceAxisComponent } from '../confidence/confidence-axis.component';
import { ConfidenceRangeComponent } from '../confidence/confidence-range.component';
import { PlayerPanelComponent } from '../player-panel/player-panel.component';
import { UnplayedMarkerComponent } from '../unplayed-marker/unplayed-marker.component';
import type { BoardScope, PlayerDetail, PlayerRatingScope, TeamDetail, TeamRecord } from '../models';

@Component({
  selector: 'app-team-detail',
  imports: [
    DecimalPipe,
    NgOptimizedImage,
    PercentPipe,
    RouterLink,
    ConfidenceAxisComponent,
    ConfidenceRangeComponent,
    PlayerPanelComponent,
    UnplayedMarkerComponent,
  ],
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

    effect((onCleanup) => {
      const playerId = this.openPlayerId();
      const board = this.panelBoard();
      if (playerId === null) return;
      this.playerLoading.set(true);
      const subscription = this.api.getPlayerById(playerId, board).subscribe({
        next: (detail) => {
          this.playerDetail.set(detail);
          this.playerLoading.set(false);
        },
        error: () => {
          this.playerDetail.set(null);
          this.playerLoading.set(false);
        },
      });
      onCleanup(() => subscription.unsubscribe());
    });
  }

  // --- Roster detail -------------------------------------------------------

  /** The roster row whose panel is open. One at a time, as on the player board. */
  protected readonly openPlayerId = signal<number | null>(null);
  protected readonly playerDetail = signal<PlayerDetail | null>(null);
  protected readonly playerLoading = signal(false);

  /**
   * Which board the open panel reads. Regional is the team's own league; the
   * international pool is role-only and cross-region, so the two are never shown
   * together -- switching replaces the grid rather than adding to it.
   */
  protected readonly panelScope = signal<PlayerRatingScope>('regional');

  // Read off the detail on screen, not the chip that was clicked: during a swap
  // the request has already changed scope while the grid still shows the old
  // board, and a coverage line taken from the request would mislabel it.
  protected readonly panelCoverage = computed(() => {
    const shown = this.playerDetail();
    if (!shown) return '';
    return shown.scope === 'international' ? 'International Only.' : `${this.team()?.leagueSlug ?? 'Regional'} Only.`;
  });

  /** Where the panel's link goes -- the board being read, not the team's own. */
  protected readonly panelBoardLink = computed(() => {
    const shown = this.playerDetail();
    const league = this.team()?.leagueSlug;
    return shown?.scope === 'international'
      ? { label: 'international', queryParams: { player: shown.id } }
      : { label: league ?? 'regional', queryParams: { scope: league, player: shown?.id } };
  });

  /** The board the panel is reading, in the form the API service takes. */
  private readonly panelBoard = computed<BoardScope>(() =>
    this.panelScope() === 'international' ? 'international' : (this.team()?.leagueSlug ?? 'international'),
  );

  protected togglePlayer(playerId: number): void {
    const isOpen = this.openPlayerId() === playerId;
    this.openPlayerId.set(isOpen ? null : playerId);
    this.playerDetail.set(null);
    // Each player is opened on their own league's board, not on whichever one
    // the previously opened row was switched to.
    if (!isOpen) this.panelScope.set('regional');
  }

  protected isPlayerOpen(playerId: number): boolean {
    return this.openPlayerId() === playerId;
  }

  protected setPanelScope(scope: PlayerRatingScope): void {
    this.panelScope.set(scope);
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
    return this.ordinal(Number(placement));
  }

  /** 1st, 2nd, 3rd, 4th -- and 11th/12th/13th, which break the pattern. */
  protected ordinal(n: number): string {
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
