import { Injectable, inject, DOCUMENT } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type {
  LeagueSummary,
  TeamSummary,
  TeamDetail,
  PlayerSummary,
  PlayerDetail,
  BoardScope,
  BoardUpdated,
  RatingWindow,
} from './models';

/**
 * Every board is a file, written once a day by the same queries the API server
 * runs -- see `backend/api/src/exportStatic.ts`, whose `dataPath` this mirrors
 * the way `models.ts` mirrors the DTOs. The two are pinned together by
 * `exportStatic.integration.test.ts`; a path invented here is a 404 nothing
 * catches until it is live.
 */
const DATA_ROOT = 'data';

/**
 * The international board is one pool rather than one per window, so it has a
 * single set of documents instead of three identical ones.
 */
const INTERNATIONAL_WINDOW: RatingWindow = 'all';

@Injectable({ providedIn: 'root' })
export class RankingsApiService {
  private readonly http = inject(HttpClient);

  /**
   * Resolved against `<base href>`, which is `/power-ranking/` on Pages and `/`
   * in dev. A page-relative URL would resolve against whichever route is showing
   * instead, and a root-relative one would miss the subpath entirely.
   */
  private readonly base = `${inject(DOCUMENT).baseURI.replace(/\/$/, '')}/${DATA_ROOT}`;

  getLeagues(): Observable<LeagueSummary[]> {
    return this.http.get<LeagueSummary[]>(`${this.base}/leagues.json`);
  }

  getBoardsLastUpdated(): Observable<BoardUpdated[]> {
    return this.http.get<BoardUpdated[]>(`${this.base}/boards-updated.json`);
  }

  /**
   * `scope` names the file, because there is no global team board: ranking teams
   * that have never played each other is the guess this structure removes.
   */
  getTeams(scope: BoardScope): Observable<TeamSummary[]> {
    return this.http.get<TeamSummary[]>(`${this.base}/teams/${scope}.json`);
  }

  getTeamById(id: number): Observable<TeamDetail> {
    return this.http.get<TeamDetail>(`${this.base}/teams/${id}/detail.json`);
  }

  /**
   * Absolute URL for a crest path the data handed us. The path already carries
   * both the extension its bytes need and the `?v=` digest that makes new
   * artwork a new URL, so this only prefixes the root -- never build the path
   * here, or a re-fetched logo stays cached.
   */
  teamLogo(path: string): string {
    return `${this.base}${path}`;
  }

  /**
   * There is no cross-league "all players" list, because the regional rating is
   * a percentile within (league, role) -- every league's distribution is centred
   * on ~50, so pooling them ranks nothing. The 'all' selection is served by the
   * international scope instead: players rated purely on games they played
   * against each other at international events. That list is much shorter and
   * its ratings are on a different scale from the regional ones.
   */
  getPlayers(scope: BoardScope, window: RatingWindow = 'all'): Observable<PlayerSummary[]> {
    return this.http.get<PlayerSummary[]>(`${this.base}/players/${this.boardFile(scope, window)}`);
  }

  /**
   * The stat line is scoped the same way the board is, because it is measured
   * over the same games the rating was: on the International board a player's
   * numbers are their international games only, not their season.
   */
  getPlayerById(id: number, scope: BoardScope, window: RatingWindow = 'all'): Observable<PlayerDetail> {
    return this.http.get<PlayerDetail>(`${this.base}/players/${id}/${this.boardFile(scope, window)}`);
  }

  private boardFile(scope: BoardScope, window: RatingWindow): string {
    return scope === 'international'
      ? `international/${INTERNATIONAL_WINDOW}.json`
      : `${scope}/${window}.json`;
  }
}
