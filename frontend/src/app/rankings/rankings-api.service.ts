import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type { Observable } from 'rxjs';
import type { LeagueSummary, TeamSummary, TeamDetail, PlayerSummary, LeagueSlug } from './models';

const API_BASE_URL = 'http://localhost:3000';

@Injectable({ providedIn: 'root' })
export class RankingsApiService {
  private readonly http = inject(HttpClient);

  getLeagues(): Observable<LeagueSummary[]> {
    return this.http.get<LeagueSummary[]>(`${API_BASE_URL}/leagues`);
  }

  getTeams(league?: LeagueSlug | 'all'): Observable<TeamSummary[]> {
    const params: Record<string, string> = league && league !== 'all' ? { league } : {};
    return this.http.get<TeamSummary[]>(`${API_BASE_URL}/teams`, { params });
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
  getPlayers(league?: LeagueSlug | 'all'): Observable<PlayerSummary[]> {
    const params: Record<string, string> =
      league && league !== 'all' ? { league } : { scope: 'international' };
    return this.http.get<PlayerSummary[]>(`${API_BASE_URL}/players`, { params });
  }
}
