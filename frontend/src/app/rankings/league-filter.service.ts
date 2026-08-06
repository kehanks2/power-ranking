import { Injectable, inject, signal } from '@angular/core';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter } from 'rxjs';
import { isBoardScope, type BoardScope } from './models';

/**
 * Single source of truth for the board being shown, synced to the `?scope=`
 * query param so it is bookmarkable and shareable.
 *
 * Defaults to 'international' rather than a region: it is the only board that
 * ranks across regions, so it is the closest thing to a headline ranking.
 */
@Injectable({ providedIn: 'root' })
export class LeagueFilterService {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly selectedScope = signal<BoardScope>(this.readFromUrl());

  constructor() {
    this.router.events.pipe(filter((event) => event instanceof NavigationEnd)).subscribe(() => {
      const fromUrl = this.readFromUrl();
      if (fromUrl !== this.selectedScope()) {
        this.selectedScope.set(fromUrl);
      }
    });
  }

  setScope(scope: BoardScope): void {
    this.selectedScope.set(scope);
    void this.router.navigate([], {
      queryParams: { scope: scope === 'international' ? null : scope },
      queryParamsHandling: 'merge',
    });
  }

  private readFromUrl(): BoardScope {
    // Validated rather than cast: `?scope=` is user-editable, and an
    // unrecognised value would reach the API, match nothing, and render an
    // empty board with no tab selected.
    const value = this.route.snapshot.queryParamMap.get('scope');
    return isBoardScope(value) ? value : 'international';
  }
}
