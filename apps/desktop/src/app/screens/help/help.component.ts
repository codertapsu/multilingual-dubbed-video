import type { OnDestroy, OnInit } from '@angular/core';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';

import { IpcService } from '../../core/ipc/ipc.service';
import { recentErrors, toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { buildDiagnostics } from '../../core/util/diagnostics';
import type { EnginesResponse, StorageInfo } from '../../core/models';
import type { WorkersHealth } from '../../core/models/view-models';
import type { AppError } from '../../core/models';
import type { PreflightResult, SystemProfileResponse } from '../../core/models/setup';
import { TranslatePipe, TranslateService } from '../../core/i18n';

/** The troubleshooting page every error banner's `docsRef` points into. */
const TROUBLESHOOTING_URL =
  'https://github.com/codertapsu/multilingual-dubbed-video/blob/main/docs/TROUBLESHOOTING.md';

/** Where a user files what "Copy diagnostics" produced. */
const NEW_ISSUE_URL =
  'https://github.com/codertapsu/multilingual-dubbed-video/issues/new';

/**
 * HelpComponent (route "help") — the app's answer to "it didn't work".
 *
 * WHY THIS SCREEN EXISTS: there was no help anywhere in the app. The only route
 * named "Support" is a donation page, so a user whose first dub failed went
 * looking for help, found the word Support, clicked it, and was asked for
 * money. Meanwhile the maintainer had nothing to diagnose with either — the
 * shell discards worker stdout/stderr, the Python workers write no file log,
 * and the SSE log buffer is cleared on every new stream — so every bug report
 * degraded to a screenshot.
 *
 * Three things, in the order a stuck user needs them:
 *   1. Check my setup — re-runs GET /setup/preflight, which until now was
 *      reachable only from inside the first-run wizard, i.e. never again.
 *   2. Services — the five health rows (stt, translation, tts, ffmpeg,
 *      ffprobe), so "nothing happens" gets a cause.
 *   3. Copy diagnostics — a redacted, paste-ready bundle, plus the links that
 *      actually open (the error banner's docsRef target, and the issue form).
 */
@Component({
  selector: 'vd-help',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ErrorBannerComponent, TranslatePipe],
  templateUrl: './help.component.html',
  styleUrl: './help.component.scss',
})
export class HelpComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);

  protected readonly inTauri = this.ipc.inTauri;
  protected readonly error = signal<AppError | null>(null);

  protected readonly appVersion = signal<string | null>(null);
  protected readonly preflight = signal<PreflightResult | null>(null);
  protected readonly preflightLoading = signal(false);
  protected readonly workers = signal<WorkersHealth | null>(null);
  protected readonly system = signal<SystemProfileResponse | null>(null);
  protected readonly engines = signal<EnginesResponse | null>(null);
  protected readonly storage = signal<StorageInfo | null>(null);
  protected readonly installedWhisperModels = signal<readonly string[] | null>(null);

  /** Flashes "Copied" for a moment after the clipboard write succeeds. */
  protected readonly copied = signal(false);
  /** Diagnostics text shown inline when the clipboard API is unusable. */
  protected readonly manualCopy = signal<string | null>(null);
  private copiedTimer: ReturnType<typeof setTimeout> | null = null;

  ngOnInit(): void {
    void this.runPreflight();
    void this.loadInventory();
  }

  /** Cancel the "Copied" flash: it writes a signal on a destroyed component
   *  otherwise, which is the classic way a screen that is left quickly (this
   *  one is reached from a backend-down banner) throws after it is gone. */
  ngOnDestroy(): void {
    if (this.copiedTimer) clearTimeout(this.copiedTimer);
  }

  /**
   * Re-run the environment self-check.
   *
   * The endpoint and this renderer both already existed — the wizard's step 2
   * uses them — but only on a first run, so the one screen that could tell a
   * user "ffmpeg is missing" was unreachable the moment setup completed.
   */
  protected async runPreflight(): Promise<void> {
    if (this.preflightLoading()) return;
    this.preflightLoading.set(true);
    this.error.set(null);
    try {
      this.preflight.set(await this.ipc.setupPreflight());
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.preflightLoading.set(false);
    }
  }

  /**
   * Everything the diagnostics bundle needs, each independently best-effort: a
   * diagnostic taken while the backend is down is the most valuable one there
   * is, so a section that cannot be read is reported as missing rather than
   * failing the whole page.
   */
  private async loadInventory(): Promise<void> {
    const [version, workers, system, engines, storage, status] = await Promise.all([
      this.ipc.getAppVersion().catch(() => null),
      this.ipc.getWorkersHealth().catch(() => null),
      this.ipc.getSystemProfile().catch(() => null),
      this.ipc.getEngines().catch(() => null),
      this.ipc.getStorage().catch(() => null),
      this.ipc.setupGetStatus().catch(() => null),
    ]);
    this.appVersion.set(version);
    this.workers.set(workers);
    this.system.set(system);
    this.engines.set(engines);
    this.storage.set(storage);
    this.installedWhisperModels.set(status?.installed.whisperModels ?? null);
  }

  /** The health rows, as [name, available, detail] tuples for the template. */
  protected serviceRows(): { name: string; available: boolean; detail?: string }[] {
    const h = this.workers();
    if (!h) return [];
    return (Object.entries(h) as [string, { available: boolean; detail?: string }][]).map(
      ([name, v]) => ({ name, available: v.available, ...(v.detail ? { detail: v.detail } : {}) }),
    );
  }

  /** Build the redacted bundle and put it on the clipboard. */
  protected async copyDiagnostics(): Promise<void> {
    const text = buildDiagnostics(
      {
        appVersion: this.appVersion(),
        inTauri: this.inTauri,
        locale: this.translate.locale(),
        userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
        system: this.system(),
        workers: this.workers(),
        preflight: this.preflight(),
        engines: this.engines(),
        storage: this.storage(),
        installedWhisperModels: this.installedWhisperModels(),
        recentErrors: recentErrors(),
      },
      new Date(),
    );
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      this.manualCopy.set(null);
      if (this.copiedTimer) clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(false), 2000);
    } catch {
      // The clipboard API is unavailable in some webview configurations (and in
      // any non-secure context). Failing with a banner alone would be a dead
      // end: this whole screen exists for the user whose dub just failed, and
      // the report they came here to send would be reachable nowhere on the
      // page. Show the text instead so it can be selected by hand.
      this.manualCopy.set(text);
    }
  }

  /** Select the whole fallback block, so Cmd/Ctrl-C works on one keystroke. */
  protected selectAll(event: Event): void {
    (event.target as HTMLTextAreaElement | null)?.select();
  }

  protected openTroubleshooting(): void {
    void this.ipc.openExternal(TROUBLESHOOTING_URL);
  }

  protected openIssueTracker(): void {
    void this.ipc.openExternal(NEW_ISSUE_URL);
  }

  protected dismissError(): void {
    this.error.set(null);
  }
}
