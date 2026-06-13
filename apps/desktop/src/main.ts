import { bootstrapApplication } from '@angular/platform-browser';
import {
  provideZoneChangeDetection,
  type ApplicationConfig,
} from '@angular/core';
import { provideRouter, withComponentInputBinding, withHashLocation } from '@angular/router';
import { provideHttpClient, withFetch } from '@angular/common/http';

import { AppComponent } from './app/app.component';
import { APP_ROUTES } from './app/app.routes';

/**
 * Root application configuration.
 *
 * - provideRouter: standalone routing for the 5 screens.
 *   withComponentInputBinding() lets routed components receive route params
 *   (e.g. :id) directly as @Input() signals.
 *   withHashLocation() puts the route in the URL fragment (/#/project/:id/...).
 *   This is REQUIRED here: index.html uses a relative <base href="./"> (so the
 *   Tauri webview can resolve bundled assets), and with HTML5 path routing a
 *   reload of a deep route like /project/:id/editor would resolve assets against
 *   /project/:id/ and serve index.html for them -> blank page. With the hash,
 *   the server/webview always loads index.html at "/", so reload (F5/Ctrl-R)
 *   works on every screen.
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
    provideRouter(APP_ROUTES, withComponentInputBinding(), withHashLocation()),
    provideHttpClient(withFetch()),
  ],
};

bootstrapApplication(AppComponent, appConfig).catch((err) =>
   
  console.error('[VideoDubber] bootstrap failed', err),
);
