import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'rankings' },
  {
    path: 'rankings',
    loadChildren: () => import('./rankings/rankings.routes').then((m) => m.rankingsRoutes),
  },
];
