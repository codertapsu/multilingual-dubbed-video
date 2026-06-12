import type { OnDestroy, OnInit } from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
  imports: [FormsModule, ErrorBannerComponent],
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

  /** The resolved info for the currently-selected voice (for the size label). */
  protected readonly selectedVoice = computed(
    () => this.voices().find((v) => v.id === this.selectedVoiceId()) ?? null,
  );

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
      const cat = await this.ipc.setupGetCatalog();
      this.catalog.set(cat);
      if (cat.languages.length > 0) {
        this.languages.set(cat.languages);
      }
      if (cat.whisperModels.length > 0) {
        this.whisperModels.set(cat.whisperModels);
        const recommended =
          cat.whisperModels.find((m) => m.recommended) ?? cat.whisperModels[0];
        this.whisperModel.set(recommended.id);
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

  /** Finish: mark first-run complete, then navigate to Home. */
  protected async finish(): Promise<void> {
    if (this.completing()) return;
    this.completing.set(true);
    this.error.set(null);
    try {
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

  protected dismissError(): void {
    this.error.set(null);
  }

  // ----------------------------- helpers -----------------------------

  /** Human label for a language code, falling back to the raw code. */
  protected languageLabel(code: LanguageCode): string {
    return this.languages().find((l) => l.code === code)?.label ?? code;
  }

  protected progressWidth(percent: number | null): string {
    return percent === null ? '100%' : `${Math.max(0, Math.min(100, percent))}%`;
  }
}

/** Base subtag of a locale code (e.g. "en-US" -> "en"). */
function baseLang(code: LanguageCode): string {
  return code.split('-')[0]?.toLowerCase() ?? code.toLowerCase();
}
