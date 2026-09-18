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

    // ~45 s of patience, not the ~3 s (5 x 600 ms) this used to allow.
    //
    // The budget has to match how long the ORCHESTRATOR takes to listen on a
    // cold first launch, not how long a navigation should feel. It was shorter
    // than the 5 s the app's own updater path already waits for that same
    // process (lib.rs), and on the one launch where the wizard matters most —
    // a freshly installed bundle, Gatekeeper scanning it on macOS or Defender
    // scanning the ~100 MB SEA on Windows — the guard lost the race, failed
    // open, and dropped the user on an empty Projects screen. /welcome has no
    // other entry point in the whole UI, so the wizard was simply gone.
    //
    // Budgeted by the CLOCK, not by an attempt count. `setupGetStatus()` is NOT
    // cheap to fail any more: both transports below it now wait out a cold boot
    // themselves — `fetchWaitingForBackend` in ipc.service.ts and, in the
    // packaged app, `send_with_boot_wait` in orchestrator_client.rs — each for
    // up to 60 s per call, and the Rust one re-arms that budget on every call
    // until the backend answers once. A first cut of this fix used
    // `maxAttempts = 45`, which multiplied rather than bounded: a machine where
    // the backend never starts would have sat on a blank window for ~45 MINUTES
    // before failing open. A deadline keeps the worst case at one in-flight
    // attempt past ~45 s no matter what each attempt costs.
    const deadline = Date.now() + 45_000;
    const delayMs = 700;
    for (;;) {
      try {
        const status = await this.ipc.setupGetStatus();
        this.cached = status;
        this._servicesReachable.set(true);
        return status;
      } catch {
        this._servicesReachable.set(false);
        if (Date.now() >= deadline) return null;
        await sleep(delayMs);
      }
    }
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
