import { Injectable, inject, signal } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import type { LeagueSlug } from './models';

/**
 * Single source of truth for the current league filter, synced to the
 * `?league=` query param so the filter is bookmarkable/shareable.
 */
@Injectable({ providedIn: 'root' })
export class LeagueFilterService {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly selectedLeague = signal<LeagueSlug | 'all'>(this.readFromUrl());

  constructor() {
    this.router.events.pipe(filter((event) => event instanceof NavigationEnd)).subscribe(() => {
      const fromUrl = this.readFromUrl();
      if (fromUrl !== this.selectedLeague()) {
        this.selectedLeague.set(fromUrl);
      }
    });
  }

  setLeague(league: LeagueSlug | 'all'): void {
    this.selectedLeague.set(league);
    void this.router.navigate([], {
      queryParams: { league: league === 'all' ? null : league },
      queryParamsHandling: 'merge',
    });
  }

  private readFromUrl(): LeagueSlug | 'all' {
    const value = this.route.snapshot.queryParamMap.get('league');
    return (value as LeagueSlug | null) ?? 'all';
  }
}
