import type { OnDestroy, OnInit } from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { argosPivotLegs } from '@videodubber/shared';
import { IpcService } from '../../core/ipc/ipc.service';
import { SetupEventsService } from '../../core/ipc/setup-events.service';
import { FirstRunService } from '../../core/guards/first-run.guard';
import { toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { DownloadProgressListComponent } from '../../shared/download-progress-list/download-progress-list.component';
import { BusyIndicatorComponent } from '../../shared/busy-indicator/busy-indicator.component';
import { FALLBACK_COMMON_LANGUAGES } from '../../core/models/view-models';
import type { AppError, LanguageCode } from '../../core/models';
import type {
  ArgosPair,
  CommonLanguage,
  PiperVoiceInfo,
  PreflightResult,
  SetupCatalog,
  SetupInstallRequest,
  WhisperModelInfo,
} from '../../core/models/setup';
import { TranslatePipe } from '../../core/i18n';

/** Wizard step index (1..4). */
type OnboardingStep = 1 | 2 | 3 | 4;

/**
 * OnboardingComponent (route "welcome") — the first-run wizard.
 *
 * Shown when {@link IpcService.setupGetStatus} reports `firstRunComplete=false`.
 * Four steps:
 *   1. Welcome — what's about to happen.
 *   2. Self-check — runs {@link IpcService.setupPreflight}; lists checks with
 *      ok/warn/fail + remediation; a Re-check button.
 *   3. Choose — source + target language, a Whisper model (default recommended),
 *      and whether to fetch a Piper voice for the target.
 *   4. Download — POST {@link IpcService.setupInstallModels}, subscribe to the
 *      setup SSE stream ({@link SetupEventsService}), show per-item progress +
 *      a live log; on `done` call {@link IpcService.setupComplete} and navigate
 *      home.
 */
@Component({
  selector: 'vd-onboarding',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule, ErrorBannerComponent, DownloadProgressListComponent, BusyIndicatorComponent, TranslatePipe],
  templateUrl: './onboarding.component.html',
  styleUrl: './onboarding.component.scss',
})
export class OnboardingComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly router = inject(Router);
  private readonly firstRun = inject(FirstRunService);
  protected readonly setupEvents = inject(SetupEventsService);

  protected readonly inTauri = this.ipc.inTauri;

  // -------- navigation --------
  protected readonly step = signal<OnboardingStep>(1);

  // -------- shared state --------
  protected readonly error = signal<AppError | null>(null);

  // -------- step 2: preflight --------
  protected readonly preflight = signal<PreflightResult | null>(null);
  protected readonly preflightLoading = signal(false);

  // -------- step 3: catalog + choices --------
  protected readonly catalog = signal<SetupCatalog | null>(null);
  protected readonly catalogLoading = signal(false);
  /**
   * The Whisper model THIS machine should use, from `GET /system`'s
   * hardware-aware recommendation. Empty until it resolves (or if it fails),
   * in which case the catalog's static `recommended` flag is used instead.
   *
   * Every model stays listed and selectable regardless — the recommendation is
   * a measured hint about fit, never a restriction.
   */
  protected readonly recommendedModelId = signal<string>('');
  protected readonly languages = signal<CommonLanguage[]>([
    ...FALLBACK_COMMON_LANGUAGES,
  ]);
  protected readonly whisperModels = signal<WhisperModelInfo[]>([]);

  protected readonly sourceLanguage = signal<LanguageCode>('en-US');
  protected readonly targetLanguage = signal<LanguageCode>('vi-VN');
  protected readonly whisperModel = signal<string>('small');
  protected readonly fetchPiperVoice = signal(true);

  /** Every Piper voice for the chosen target language (best-first). */
  protected readonly voices = signal<PiperVoiceInfo[]>([]);
  /** The voice id the user picked to download (defaults to the recommended one). */
  protected readonly selectedVoiceId = signal<string>('');
  protected readonly voicesLoading = signal(false);

  // -------- step 4: install --------
  protected readonly installing = signal(false);
  protected readonly completing = signal(false);
  /** True while "Skip for now" is finishing setup without a download. */
  protected readonly skipping = signal(false);

  /** Once the install stream ends or errors, it's no longer in flight — so the
   *  Retry button enables on error (and Finish enables on done). */
  private readonly _syncInstalling = effect(() => {
    if (this.setupEvents.done() || this.setupEvents.error()) this.installing.set(false);
  });

  /** The resolved info for the currently-selected voice (for the size label). */
  protected readonly selectedVoice = computed(
    () => this.voices().find((v) => v.id === this.selectedVoiceId()) ?? null,
  );

  /**
   * Approximate megabytes this wizard is about to download, so the cost of the
   * chosen model is visible BEFORE the download starts rather than discovered
   * as a stalled progress bar. Argos packs aren't in the catalog with sizes, so
   * this is the model + the voice: the two the user actually chooses here.
   */
  protected readonly totalDownloadMb = computed(() => {
    const model = this.whisperModels().find((m) => m.id === this.whisperModel());
    const voice = this.fetchPiperVoice() ? this.selectedVoice() : null;
    return (model?.approxSizeMb ?? 0) + (voice?.approxSizeMb ?? 0);
  });

  /** Whether the chosen Argos pair appears in the catalog's available list. */
  protected readonly argosPairAvailable = computed(() => {
    const cat = this.catalog();
    if (!cat) return true; // optimistic before the catalog loads
    const from = baseLang(this.sourceLanguage());
    const to = baseLang(this.targetLanguage());
    if (from === to) return true;
    return cat.argosAvailable.some(
      (p) => baseLang(p.from) === from && baseLang(p.to) === to,
    );
  });

  protected readonly languagesDiffer = computed(
    () => baseLang(this.sourceLanguage()) !== baseLang(this.targetLanguage()),
  );

  /** Step 3 is valid once languages differ and a model is selected. */
  protected readonly step3Valid = computed(
    () => this.languagesDiffer() && this.whisperModel().length > 0,
  );

  /** True once the SSE stream reports completion. */
  protected readonly installDone = computed(() => this.setupEvents.done());

  /** Surface an SSE error over an action error. */
  protected readonly displayError = computed<AppError | null>(
    () => this.setupEvents.error() ?? this.error(),
  );

  ngOnInit(): void {
    void this.init();
  }

  private async init(): Promise<void> {
    await this.loadCatalog();
    await this.loadVoicesForTarget();
  }

  ngOnDestroy(): void {
    this.setupEvents.disconnect();
  }

  // ----------------------------- navigation -----------------------------

  protected goToStep(step: OnboardingStep): void {
    this.step.set(step);
    if (step === 2 && !this.preflight()) {
      void this.runPreflight();
    }
  }

  protected next(): void {
    const s = this.step();
    if (s < 4) {
      this.goToStep((s + 1) as OnboardingStep);
    }
  }

  protected back(): void {
    const s = this.step();
    if (s > 1) {
      this.step.set((s - 1) as OnboardingStep);
    }
  }

  // ----------------------------- step 2 -----------------------------

  protected async runPreflight(): Promise<void> {
    if (this.preflightLoading()) return;
    this.preflightLoading.set(true);
    this.error.set(null);
    try {
      const result = await this.ipc.setupPreflight();
      this.preflight.set(result);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.preflightLoading.set(false);
    }
  }

  // ----------------------------- step 3 -----------------------------

  private async loadCatalog(): Promise<void> {
    this.catalogLoading.set(true);
    try {
      // The recommendation is per-MACHINE (GET /system), the catalog's
      // `recommended` flag is a static property of the table. Prefer the
      // measured one; a failed probe just falls back to the flag.
      const [cat, system] = await Promise.all([
        this.ipc.setupGetCatalog(),
        this.ipc.getSystemProfile().catch(() => null),
      ]);
      this.catalog.set(cat);
      if (cat.languages.length > 0) {
        this.languages.set(cat.languages);
      }
      if (cat.whisperModels.length > 0) {
        this.whisperModels.set(cat.whisperModels);
        const forThisMachine = system?.recommendation.whisperModel;
        const offered = forThisMachine
          ? cat.whisperModels.find((m) => m.id === forThisMachine)
          : undefined;
        if (offered) this.recommendedModelId.set(offered.id);
        const preselect =
          offered ?? cat.whisperModels.find((m) => m.recommended) ?? cat.whisperModels[0];
        this.whisperModel.set(preselect.id);
      }
    } catch {
      // Offline / orchestrator not up yet: keep fallback languages; the user
      // can still proceed once services are reachable (preflight will flag it).
    } finally {
      this.catalogLoading.set(false);
    }
  }

  protected setSourceLanguage(code: LanguageCode): void {
    this.sourceLanguage.set(code);
  }

  protected setTargetLanguage(code: LanguageCode): void {
    this.targetLanguage.set(code);
    void this.loadVoicesForTarget();
  }

  /**
   * Load every Piper voice for the chosen target language (best-first) and
   * pre-select the recommended one. Offline / no-voice languages leave the list
   * empty, and the "download a voice" toggle simply becomes a no-op.
   */
  private async loadVoicesForTarget(): Promise<void> {
    this.voicesLoading.set(true);
    try {
      const voices = await this.ipc.setupListVoices(this.targetLanguage());
      this.voices.set(voices);
      const current = this.selectedVoiceId();
      const stillOffered = current && voices.some((v) => v.id === current);
      if (!stillOffered) {
        this.selectedVoiceId.set((voices.find((v) => v.recommended) ?? voices[0])?.id ?? '');
      }
    } catch {
      // Offline / backend down: no per-language voices; user can add one later.
      this.voices.set([]);
      this.selectedVoiceId.set('');
    } finally {
      this.voicesLoading.set(false);
    }
  }

  protected setWhisperModel(id: string): void {
    this.whisperModel.set(id);
  }

  protected toggleFetchPiperVoice(value: boolean): void {
    this.fetchPiperVoice.set(value);
  }

  // ----------------------------- step 4 -----------------------------

  /** Build the install request from the user's step-3 choices. */
  private buildInstallRequest(): SetupInstallRequest {
    const req: SetupInstallRequest = { whisperModel: this.whisperModel() };

    // Argos translates through English, so a non-English pair (e.g. zh->vi) needs
    // BOTH pivot legs — not a single direct package Argos doesn't publish.
    const legs = argosPivotLegs(this.sourceLanguage(), this.targetLanguage());
    if (legs.length > 0) {
      req.argosPairs = legs as ArgosPair[];
    }

    if (this.fetchPiperVoice() && this.selectedVoiceId()) {
      req.piperVoices = [this.selectedVoiceId()];
    }

    return req;
  }

  /**
   * Start the download: connect the SSE stream FIRST (so no early progress is
   * missed), then POST the install request. Progress renders from the events
   * service signals.
   */
  protected async startInstall(): Promise<void> {
    if (this.installing() || !this.step3Valid()) return;
    this.installing.set(true);
    this.error.set(null);

    // Connect before kicking off so we don't miss the first progress frames.
    this.setupEvents.connect();
    this.goToStep(4);

    try {
      await this.ipc.setupInstallModels(this.buildInstallRequest());
    } catch (err) {
      this.error.set(toAppError(err));
      this.installing.set(false);
      this.setupEvents.disconnect();
    }
  }

  /** Retry after a failed/aborted download (e.g. the connection dropped). */
  protected async retryInstall(): Promise<void> {
    this.installing.set(false); // reset so startInstall proceeds
    await this.startInstall();
  }

  /**
   * Make the wizard's model choice the default for new projects.
   *
   * WHY: the wizard downloaded the model and then threw the choice away. The
   * New Project wizard defaults to `sttModel: 'small'` and only overrides it
   * from `providerDefaults`, and `computeRequiredResources` then treats `small`
   * as a missing REQUIRED resource — so choosing `large-v3-turbo` here meant
   * downloading 1.6 GB that was never used, followed by a surprise, blocking
   * 484 MB download the first time the user created a project. The Settings
   * screen already persists exactly this field the same way.
   *
   * Deliberately best-effort: a preferences write that fails must not strand the
   * user in the wizard they are trying to leave. The worst case is the old
   * behaviour (the New Project wizard falls back to `small`), which is exactly
   * what happens today anyway.
   */
  private async persistModelChoice(): Promise<void> {
    const sttModel = this.whisperModel();
    if (!sttModel) return;
    await this.ipc
      .saveAppPreferences({ providerDefaults: { sttModel } })
      .catch(() => undefined);
  }

  /** Finish: persist the model choice, mark first-run complete, go Home. */
  protected async finish(): Promise<void> {
    if (this.completing()) return;
    this.completing.set(true);
    this.error.set(null);
    try {
      await this.persistModelChoice();
      await this.ipc.setupComplete();
      this.setupEvents.disconnect();
      // Invalidate the cached first-run status so the guard sees the new state
      // and lets Home render instead of bouncing back to the wizard.
      this.firstRun.invalidate();
      await this.router.navigate(['/']);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.completing.set(false);
    }
  }

  /**
   * "Skip for now — I'll download later": complete setup WITHOUT a successful
   * download and land on Home.
   *
   * WHY this exists: Finish was gated on the SSE `done` event and step 4 offered
   * only Retry, so a user who is offline, behind a blocked mirror, rate-limited
   * or out of disk could never complete setup — and because `setup_complete` is
   * written nowhere else, `firstRunGuard` bounced them back to this same screen
   * at every launch, making the Projects list the one screen in the app they
   * could never reach.
   *
   * Skipping is safe: creating a project runs `ensure-resources`, which
   * downloads exactly what that project needs before the run can start. The
   * models are deferred, not lost — and Home shows a standing reminder.
   */
  protected async skipSetup(): Promise<void> {
    if (this.skipping() || this.completing()) return;
    this.skipping.set(true);
    this.error.set(null);
    try {
      // Persist the choice anyway: when they do download later, from Settings
      // or from their first project, it should be the model they picked here.
      await this.persistModelChoice();
      await this.ipc.setupComplete();
      this.setupEvents.disconnect();
      this.firstRun.invalidate();
      await this.router.navigate(['/']);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.skipping.set(false);
    }
  }

  protected dismissError(): void {
    this.error.set(null);
  }

  // ----------------------------- helpers -----------------------------

  /** Human label for a language code, falling back to the raw code. */
  protected languageLabel(code: LanguageCode): string {
    return this.languages().find((l) => l.code === code)?.label ?? code;
  }

}

/** Base subtag of a locale code (e.g. "en-US" -> "en"). */
function baseLang(code: LanguageCode): string {
  return code.split('-')[0]?.toLowerCase() ?? code.toLowerCase();
}
