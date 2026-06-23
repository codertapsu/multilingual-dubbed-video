import type { Routes } from '@angular/router';

import { firstRunGuard, onboardingGuard } from './core/guards/first-run.guard';

/**
 * Application routes. Every screen is a lazily-loaded standalone component so
 * the initial bundle stays small. Component input binding (configured in
 * main.ts) feeds `:id` straight into each routed component as an input.
 *
 * First-run flow: the Home route is guarded by {@link firstRunGuard}. If the
 * orchestrator reports `firstRunComplete=false`, the guard redirects to the
 * "welcome" onboarding wizard. The wizard route uses {@link onboardingGuard}
 * so it's not reachable once setup is done.
 */
export const APP_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'VideoDubber — Projects',
    canActivate: [firstRunGuard],
    loadComponent: () =>
      import('./screens/home/home.component').then((m) => m.HomeComponent),
  },
  {
    path: 'welcome',
    title: 'VideoDubber — Welcome',
    canActivate: [onboardingGuard],
    loadComponent: () =>
      import('./screens/onboarding/onboarding.component').then(
        (m) => m.OnboardingComponent,
      ),
  },
  {
    path: 'settings',
    title: 'VideoDubber — Settings',
    loadComponent: () =>
      import('./screens/settings/settings.component').then(
        (m) => m.SettingsComponent,
      ),
  },
  {
    path: 'new',
    title: 'VideoDubber — New project',
    loadComponent: () =>
      import('./screens/new-project-wizard/new-project-wizard.component').then(
        (m) => m.NewProjectWizardComponent,
      ),
  },
  {
    path: 'project/:id/processing',
    title: 'VideoDubber — Processing',
    loadComponent: () =>
      import('./screens/processing/processing.component').then(
        (m) => m.ProcessingComponent,
      ),
  },
  {
    path: 'project/:id/editor',
    title: 'VideoDubber — Editor',
    loadComponent: () =>
      import('./screens/editor/editor.component').then((m) => m.EditorComponent),
  },
  {
    path: 'project/:id/export',
    title: 'VideoDubber — Export',
    loadComponent: () =>
      import('./screens/export/export.component').then((m) => m.ExportComponent),
  },
  {
    path: 'support',
    title: 'VideoDubber — Support',
    loadComponent: () =>
      import('./screens/support/support.component').then(
        (m) => m.SupportComponent,
      ),
  },
  { path: '**', redirectTo: '' },
];
