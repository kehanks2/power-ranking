import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type {
  LeagueSummary,
  TeamSummary,
  TeamDetail,
  PlayerSummary,
  PlayerDetail,
  BoardScope,
  RatingWindow,
} from './models';

const API_BASE_URL = 'http://localhost:3000';

@Injectable({ providedIn: 'root' })
export class RankingsApiService {
  private readonly http = inject(HttpClient);

  getLeagues(): Observable<LeagueSummary[]> {
    return this.http.get<LeagueSummary[]>(`${API_BASE_URL}/leagues`);
  }

  /**
   * `scope` is required by the API -- there is no global team board, because
   * ranking teams that have never played each other is the guess this
   * structure removes.
   */
  getTeams(scope: BoardScope): Observable<TeamSummary[]> {
    return this.http.get<TeamSummary[]>(`${API_BASE_URL}/teams`, { params: { scope } });
  }

  getTeamById(id: number): Observable<TeamDetail> {
    return this.http.get<TeamDetail>(`${API_BASE_URL}/teams/${id}`);
  }

  /**
   * There is no cross-league "all players" list, because the regional rating
   * is a percentile within (league, role) -- every league's distribution is
   * centred on ~50, so pooling them ranks nothing. The 'all' selection is
   * therefore served by the international scope instead: players rated purely
   * on games they played against each other at international events. That
   * list is much shorter (only players with an international record appear)
   * and its ratings are on a different scale from the regional ones.
   */
  getPlayers(scope: BoardScope, window: RatingWindow = 'all'): Observable<PlayerSummary[]> {
    const params: Record<string, string> =
      scope === 'international' ? { scope: 'international' } : { league: scope, window };
    return this.http.get<PlayerSummary[]>(`${API_BASE_URL}/players`, { params });
  }

  /**
   * The stat line is scoped the same way the board is, because it is measured
   * over the same games the rating was: on the International board a player's
   * numbers are their international games only, not their season.
   */
  getPlayerById(id: number, scope: BoardScope, window: RatingWindow = 'all'): Observable<PlayerDetail> {
    const params: Record<string, string> =
      scope === 'international' ? { scope: 'international' } : { window };
    return this.http.get<PlayerDetail>(`${API_BASE_URL}/players/${id}`, { params });
  }
}
