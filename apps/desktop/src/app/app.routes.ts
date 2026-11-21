import { inject } from '@angular/core';
import { Router, type Routes } from '@angular/router';

import { firstRunGuard, onboardingGuard } from './core/guards/first-run.guard';
import { leaveWhileBusyGuard } from './core/guards/leave-while-busy.guard';
import { unsavedChangesGuard } from './core/guards/unsaved-changes.guard';
import { sectionForAnchor } from './screens/settings/settings-sections';

/**
 * Application routes. Every screen is a lazily-loaded standalone component so
 * the initial bundle stays small. Component input binding (configured in
 * main.ts) feeds `:id` straight into each routed component as an input.
 *
 * First-run flow: the Home route is guarded by {@link firstRunGuard}. If the
 * orchestrator reports `firstRunComplete=false`, the guard redirects to the
 * "welcome" onboarding wizard. The wizard route uses {@link onboardingGuard}
 * so it's not reachable once setup is done.
 *
 * Each `title` is an i18n key (`nav.title.*`), not text: the window title
 * follows the chosen language, also when it changes on a screen
 * (core/title/translated-title.strategy.ts). They were English literals.
 */
export const APP_ROUTES: Routes = [
  {
    path: '',
    pathMatch: 'full',
    title: 'nav.title.projects',
    canActivate: [firstRunGuard],
    loadComponent: () =>
      import('./screens/home/home.component').then((m) => m.HomeComponent),
  },
  {
    path: 'welcome',
    title: 'nav.title.welcome',
    canActivate: [onboardingGuard],
    loadComponent: () =>
      import('./screens/onboarding/onboarding.component').then(
        (m) => m.OnboardingComponent,
      ),
  },
  {
    // Settings is a set of sections (/settings/general, /settings/stt, …). The
    // bare address, and the anchors of the single page it used to be
    // (/settings#brand-kit, #downloads), land on the section holding them,
    // anchor kept, so a link written for the old page still finds its option.
    path: 'settings',
    pathMatch: 'full',
    redirectTo: ({ fragment }) =>
      inject(Router).createUrlTree(['/settings', sectionForAnchor(fragment)], fragment ? { fragment } : {}),
  },
  {
    path: 'settings/:section',
    title: 'nav.title.settings',
    loadComponent: () =>
      import('./screens/settings/settings.component').then(
        (m) => m.SettingsComponent,
      ),
  },
  {
    path: 'new',
    title: 'nav.title.new-project',
    canDeactivate: [leaveWhileBusyGuard],
    loadComponent: () =>
      import('./screens/new-project-wizard/new-project-wizard.component').then(
        (m) => m.NewProjectWizardComponent,
      ),
  },
  {
    path: 'project/:id/processing',
    title: 'nav.title.processing',
    loadComponent: () =>
      import('./screens/processing/processing.component').then(
        (m) => m.ProcessingComponent,
      ),
  },
  {
    path: 'project/:id/editor',
    title: 'nav.title.editor',
    // Transcript edits live in a draft buffer until Save, and leaving the screen
    // threw them away without a word. The guard asks first.
    canDeactivate: [unsavedChangesGuard],
    loadComponent: () =>
      import('./screens/editor/editor.component').then((m) => m.EditorComponent),
  },
  {
    path: 'project/:id/series',
    title: 'nav.title.series',
    loadComponent: () => import('./screens/series/series.component').then((m) => m.SeriesComponent),
  },
  {
    path: 'project/:id/export',
    title: 'nav.title.export',
    loadComponent: () =>
      import('./screens/export/export.component').then((m) => m.ExportComponent),
  },
  {
    // The voice library: browse, preview, install and favourite voices of
    // every engine, each with its licence (docs/VOICES.md).
    path: 'voices',
    title: 'nav.title.voices',
    loadComponent: () => import('./screens/voices/voices.component').then((m) => m.VoicesComponent),
  },
  {
    path: 'download',
    title: 'nav.title.download',
    loadComponent: () =>
      import('./screens/download/download.component').then(
        (m) => m.DownloadComponent,
      ),
  },
  {
    // "Use VideoDubber from Claude": connect Claude Desktop / Claude Code and
    // drive VideoDubber from Mother Claude, step by step. Linked from
    // Settings → Claude, Help, and a one-time tip on Home.
    path: 'claude',
    title: 'nav.title.claude',
    loadComponent: () =>
      import('./screens/claude-guide/claude-guide.component').then((m) => m.ClaudeGuideComponent),
  },
  {
    // The end-user entry point for "it didn't work": a re-runnable self-check,
    // the service health rows and a copyable diagnostics bundle. Added because
    // the only route that sounded like help was /support — a donation page —
    // which is the worst possible screen to land on after a failed first dub.
    path: 'help',
    title: 'nav.title.help',
    loadComponent: () =>
      import('./screens/help/help.component').then((m) => m.HelpComponent),
  },
  {
    path: 'support',
    title: 'nav.title.support',
    loadComponent: () =>
      import('./screens/support/support.component').then(
        (m) => m.SupportComponent,
      ),
  },
  { path: '**', redirectTo: '' },
];
