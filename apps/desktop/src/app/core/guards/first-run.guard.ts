import { inject, Injectable, signal, type Signal } from '@angular/core';
import {
  Router,
  type CanActivateFn,
  type UrlTree,
} from '@angular/router';

import { IpcService } from '../ipc/ipc.service';
import type { SetupStatus } from '../models/setup';

/**
 * FirstRunService — caches the first-run completion status for the session so
 * the guard doesn't re-hit the orchestrator on every navigation.
 *
 * Resilience: if the orchestrator isn't reachable yet (services still starting),
 * we DON'T strand the user on a blank screen — we retry a few times with a
 * short backoff, then fail OPEN (treat as "first run complete") so the app
 * still loads. The Home/onboarding screens surface a clearer error if the
 * services genuinely never come up.
 */
@Injectable({ providedIn: 'root' })
export class FirstRunService {
  private readonly ipc = inject(IpcService);

  /** Cached status for the session; null until first resolved. */
  private cached: SetupStatus | null = null;

  /** Exposes whether services were reachable on the last check (for UI hints). */
  private readonly _servicesReachable = signal<boolean>(true);
  readonly servicesReachable: Signal<boolean> = this._servicesReachable.asReadonly();

  /** Force a re-fetch on next call (e.g. after the wizard completes). */
  invalidate(): void {
    this.cached = null;
  }

  /**
   * Resolve the setup status, retrying transient connectivity failures.
   * Returns null if the status truly could not be determined (services down).
   */
  async resolve(): Promise<SetupStatus | null> {
    if (this.cached) return this.cached;

    const maxAttempts = 5;
    const delayMs = 600;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const status = await this.ipc.setupGetStatus();
        this.cached = status;
        this._servicesReachable.set(true);
        return status;
      } catch {
        this._servicesReachable.set(false);
        if (attempt < maxAttempts) {
          await sleep(delayMs);
        }
      }
    }
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Route guard for the Home (and other in-app) routes: if first run has NOT been
 * completed, redirect to the onboarding wizard ("welcome"). If we can't reach
 * the orchestrator after retries, we fail OPEN and allow navigation so the app
 * still renders (the destination screen shows its own connectivity error).
 */
export const firstRunGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const firstRun = inject(FirstRunService);
  const router = inject(Router);

  const status = await firstRun.resolve();
  if (status && !status.firstRunComplete) {
    return router.parseUrl('/welcome');
  }
  return true;
};

/**
 * Inverse guard for the "welcome" route: if first run is ALREADY complete,
 * bounce to Home so the wizard isn't reachable again via deep-link/back.
 */
export const onboardingGuard: CanActivateFn = async (): Promise<boolean | UrlTree> => {
  const firstRun = inject(FirstRunService);
  const router = inject(Router);

  const status = await firstRun.resolve();
  if (status && status.firstRunComplete) {
    return router.parseUrl('/');
  }
  // If unknown (services down) or not complete, allow the wizard.
  return true;
};
