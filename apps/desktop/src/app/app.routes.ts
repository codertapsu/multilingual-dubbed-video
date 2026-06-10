import type { Routes } from '@angular/router';

/**
 * Application routes. Every screen is a lazily-loaded standalone component so
 * the initial bundle stays small. Component input binding (configured in
 * main.ts) feeds `:id` straight into each routed component as an input.
 */
export const APP_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'VideoDubber — Projects',
    loadComponent: () =>
      import('./screens/home/home.component').then((m) => m.HomeComponent),
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
  { path: '**', redirectTo: '' },
];
