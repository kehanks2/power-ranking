import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { DecimalPipe, PercentPipe } from '@angular/common';
import { ConfidenceAxisComponent } from '../confidence/confidence-axis.component';
import { ConfidenceRangeComponent } from '../confidence/confidence-range.component';
import type { PlayerDetail, PlayerStat, PlayerStats } from '../models';
import { TooltipDirective } from '../tooltip.directive';

/** The members of PlayerStats that are placed stats, not the bare counts alongside them. */
type StatKey = { [K in keyof PlayerStats]: PlayerStats[K] extends PlayerStat ? K : never }[keyof PlayerStats];

/** One stat as the panel renders it: already formatted, with its standing. */
interface StatView {
  label: string;
  display: string;
  /** "3rd", or null when the player has no value for this stat. */
  place: string | null;
  /** 0-1 along the ranking, best at 0. A dot marking position, not a magnitude bar. */
  position: number;
  /** Top quartile of the peer group (a fraction, so it holds across group sizes). */
  standout: boolean;
  /** Spelled out for the tooltip and for screen readers. */
  standing: string;
  /** Whether this stat carries weight at this role; the rest are context only. */
  feeds: boolean;
  /** Which side of the peer median a feeding stat sits on. Null when it doesn't feed, or sits on it. */
  drive: 'lifting' | 'dragging' | null;
}

/** The ten stats grouped by the question they answer. */
interface StatGroup {
  title: string;
  stats: StatView[];
}

/**
 * A player's stat line for one board, with what drives their rating marked.
 * Presentational: the caller owns which board is being shown and supplies the
 * coverage line, so the same panel serves the player board and a team roster.
 */
@Component({
  selector: 'app-player-panel',
  imports: [DecimalPipe, PercentPipe, ConfidenceAxisComponent, ConfidenceRangeComponent, TooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player-panel.component.html',
  styleUrl: './player-panel.component.scss',
  host: {
    '[attr.aria-busy]': 'loading() ? "true" : null',
    '[class.is-reloading]': 'loading() && !!detail()',
  },
})
export class PlayerPanelComponent {
  readonly detail = input<PlayerDetail | null>(null);
  readonly loading = input(false);
  /** Named separately so the loading and error states can still say who they mean. */
  readonly handle = input('');
  /** What the numbers are measured over, e.g. "LCK Only." */
  readonly coverage = input('');
  // Off where the row above already carries the rating, on where the panel can
  // be showing a different board than that row.
  readonly showRating = input(false);

  protected readonly roleRank = computed(() => {
    const detail = this.detail();
    return detail ? ordinal(detail.roleRank) : '';
  });

  protected readonly statGroups = computed<StatGroup[]>(() => {
    const detail = this.detail();
    if (!detail) return [];
    const s = detail.stats;
    const peers = detail.peerCount;
    const rated = new Set(detail.ratedStats);

    const view = (label: string, key: StatKey, display: (v: number) => string): StatView => {
      const stat = s[key];
      // 1st sits at 0, last at 1. Guarded against a peer group of one, where
      // there is no spread to place anyone along.
      const position = stat.place === null || peers <= 1 ? 0 : (stat.place - 1) / (peers - 1);
      const feeds = rated.has(key);
      return {
        label,
        display: stat.value === null ? '—' : display(stat.value),
        place: stat.place === null ? null : ordinal(stat.place),
        position,
        standout: stat.place !== null && peers > 0 && stat.place <= Math.ceil(peers / 4),
        standing:
          stat.place === null
            ? 'No games on this board to place'
            : `${ordinal(stat.place)} of ${peers} ${detail.role} players on this board`,
        feeds,
        // The peer median is the break-even point, so a stat sitting exactly on
        // it pulls neither way and takes no arrow.
        drive: !feeds || stat.place === null || position === 0.5 ? null : position < 0.5 ? 'lifting' : 'dragging',
      };
    };

    const to = (places: number) => (v: number) => v.toFixed(places);
    const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
    // Signed, because the sign IS the reading: negative means behind the
    // player they were matched against.
    const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(Math.round(v)).toLocaleString('en-US')}`;

    return [
      {
        title: 'Combat',
        stats: [
          view('KDA', 'kda', to(2)),
          view('Kills', 'kills', to(1)),
          view('Deaths', 'deaths', to(1)),
          view('Assists', 'assists', to(1)),
        ],
      },
      {
        title: 'Economy',
        stats: [
          view('CS / min', 'csPerMin', to(1)),
          view('Gold vs. lane', 'goldDiff', signed),
          view('Gold share', 'goldShare', pct),
        ],
      },
      {
        title: 'Team impact',
        stats: [
          view('Kill participation', 'killParticipation', pct),
          view('Damage share', 'damageShare', pct),
          view('Objective control', 'objectiveControl', pct),
        ],
      },
    ];
  });

  /** Whether this role has any dimmed stat, so the note is shown only where it applies. */
  protected readonly contextStats = computed(() =>
    this.statGroups().some((group) => group.stats.some((stat) => !stat.feeds)),
  );
}

/** 1st, 2nd, 3rd, 4th -- and 11th/12th/13th, which break the pattern. */
function ordinal(n: number): string {
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
