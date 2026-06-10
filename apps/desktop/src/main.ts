import { bootstrapApplication } from '@angular/platform-browser';
import {
  provideZoneChangeDetection,
  type ApplicationConfig,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';

import { AppComponent } from './app/app.component';
import { APP_ROUTES } from './app/app.routes';

/**
 * Root application configuration.
 *
 * - provideRouter: standalone routing for the 5 screens.
 *   withComponentInputBinding() lets routed components receive route params
 *   (e.g. :id) directly as @Input() signals.
 * - provideHttpClient(withFetch()): the IPC service falls back to HTTP fetch
 *   against the orchestrator when not running inside Tauri. withFetch() uses
 *   the platform fetch implementation which is also what the Tauri webview
 *   exposes for SSE / cross-origin localhost calls.
 * - provideZoneChangeDetection: standard zone-based change detection with
 *   event coalescing for fewer redundant CD cycles.
 */
const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(APP_ROUTES, withComponentInputBinding()),
    provideHttpClient(withFetch()),
  ],
};

bootstrapApplication(AppComponent, appConfig).catch((err) =>
   
  console.error('[VideoDubber] bootstrap failed', err),
);
