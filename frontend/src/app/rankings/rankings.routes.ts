import type { Routes } from '@angular/router';
import { RankingsShellComponent } from './rankings-shell/rankings-shell.component';

export const rankingsRoutes: Routes = [
  {
    path: '',
    component: RankingsShellComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'teams' },
      {
        path: 'teams',
        loadComponent: () => import('./teams-list/teams-list.component').then((m) => m.TeamsListComponent),
      },
      {
        path: 'teams/:id',
        loadComponent: () => import('./team-detail/team-detail.component').then((m) => m.TeamDetailComponent),
      },
      {
        path: 'players',
        loadComponent: () => import('./players-list/players-list.component').then((m) => m.PlayersListComponent),
      },
      {
        path: 'how-it-works',
        loadComponent: () => import('./how-it-works/how-it-works.component').then((m) => m.HowItWorksComponent),
      },
    ],
  },
];
