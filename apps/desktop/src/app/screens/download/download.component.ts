import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { DownloadEventsService } from '../../core/ipc/download-events.service';
import { IpcService } from '../../core/ipc/ipc.service';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import type { AppError } from '../../core/models';
import type {
  DownloadProvider,
  QualityOption,
  ResolvedVideo,
  SessionCheck,
  SessionInfo,
} from '../../core/models/download';

/**
 * DownloadComponent (route "download") — fetch a source video to dub.
 *
 * Two steps on purpose: resolving a link is cheap and shows the user exactly
 * what they are about to fetch (title, uploader, part list), so nobody spends
 * several hundred megabytes discovering they pasted the wrong link.
 *
 * Marked experimental in the UI: it depends on a third-party site's public web
 * endpoints, which can change without notice.
 */
@Component({
  selector: 'vd-download',
  standalone: true,
  imports: [FormsModule, TranslatePipe, ErrorBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './download.component.html',
  styleUrl: './download.component.scss',
})
export class DownloadComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  protected readonly events = inject(DownloadEventsService);

  protected readonly input = signal('');
  protected readonly resolving = signal(false);
  protected readonly starting = signal(false);
  protected readonly video = signal<ResolvedVideo | null>(null);
  protected readonly selectedPage = signal(1);
  /** Chosen quality id, or undefined to take the best on offer. */
  protected readonly selectedQuality = signal<string | undefined>(undefined);
  private readonly localError = signal<AppError | null>(null);

  /** Either a local failure (bad link) or one reported by the running job. */
  protected readonly error = computed<AppError | null>(
    () => this.localError() ?? this.events.error(),
  );

  protected readonly progress = this.events.progress;
  protected readonly completedPath = this.events.completedPath;

  /** True while bytes are moving, so the form stays locked. */
  protected readonly downloading = computed(
    () => this.progress() !== null && this.completedPath() === null && this.error() === null,
  );

  /** Only multi-part videos need a picker; a single part is implied. */
  protected readonly showPartPicker = computed(() => (this.video()?.parts.length ?? 0) > 1);

  /**
   * Offer a quality picker only when there is a real choice to make.
   *
   * With one option the control is decoration, and with none the probe failed
   * — in which case showing an empty or guessed list would be worse than
   * saying nothing and letting the download take the best available.
   */
  protected readonly qualities = computed<QualityOption[]>(() => this.video()?.qualities ?? []);
  protected readonly showQualityPicker = computed(() => this.qualities().length > 1);

  // ---- optional per-provider credentials -------------------------------
  // Deliberately owned by this screen rather than Settings: it exists only to
  // raise the ceiling of THIS feature, and a credential for a downloader is
  // meaningless anywhere else in the app.
  protected readonly providers = signal<DownloadProvider[]>([]);
  protected readonly sessionInput = signal('');
  protected readonly sessionBusy = signal<string | null>(null);
  protected readonly sessionCheck = signal<SessionCheck | null>(null);
  protected readonly sessionOpen = signal(false);

  /** Only providers that actually take a credential get any UI. */
  protected readonly sessionProviders = computed(() =>
    this.providers().filter((p) => p.supportsSession),
  );

  ngOnInit(): void {
    // Connect on entry so a download already running (started before the user
    // navigated away) is picked up from the server's replayed state.
    this.events.connect();
    void this.loadProviders();
  }

  private async loadProviders(): Promise<void> {
    try {
      this.providers.set(await this.ipc.getDownloadProviders());
    } catch {
      /* optional affordance — never block the screen on it */
    }
  }

  protected sessionFor(providerId: string): SessionInfo | undefined {
    return this.providers().find((p) => p.id === providerId)?.session;
  }

  /**
   * Display name for a provider.
   *
   * The key is built from the provider id so a new source needs only one line
   * of i18n — but a missing key renders as the raw key string, which would be
   * an ugly way to meet a new provider. Fall back to the id itself, so adding
   * a provider without translations still looks deliberate.
   */
  protected providerLabel(providerId: string): string {
    const key = `source-video.provider.${providerId}`;
    const label = this.translate.instant(key);
    return label === key ? providerId : label;
  }

  protected async saveSession(providerId: string): Promise<void> {
    const value = this.sessionInput().trim();
    if (!value || this.sessionBusy()) return;
    this.sessionBusy.set(providerId);
    this.sessionCheck.set(null);
    try {
      await this.ipc.setProviderSession(providerId, value);
      // Drop the plaintext from the form as soon as it is stored; leaving a
      // live credential sitting in an input is needless exposure.
      this.sessionInput.set('');
      await this.loadProviders();
    } catch (err) {
      this.localError.set(err as AppError);
    } finally {
      this.sessionBusy.set(null);
    }
  }

  protected async clearSession(providerId: string): Promise<void> {
    if (this.sessionBusy()) return;
    this.sessionBusy.set(providerId);
    try {
      await this.ipc.clearProviderSession(providerId);
      this.sessionInput.set('');
      this.sessionCheck.set(null);
      await this.loadProviders();
    } catch (err) {
      this.localError.set(err as AppError);
    } finally {
      this.sessionBusy.set(null);
    }
  }

  /** Surface an expired credential, which otherwise just silently caps quality. */
  protected async checkSession(providerId: string): Promise<void> {
    if (this.sessionBusy()) return;
    this.sessionBusy.set(providerId);
    this.sessionCheck.set(null);
    try {
      this.sessionCheck.set(await this.ipc.testProviderSession(providerId));
    } catch (err) {
      this.localError.set(err as AppError);
    } finally {
      this.sessionBusy.set(null);
    }
  }

  ngOnDestroy(): void {
    this.events.disconnect();
  }

  /** Look the link up without committing to a download. */
  protected async resolve(): Promise<void> {
    const value = this.input().trim();
    if (!value || this.resolving()) return;

    this.resolving.set(true);
    this.localError.set(null);
    this.events.reset();
    this.video.set(null);
    try {
      const info = await this.ipc.resolveDownload(value);
      this.video.set(info);
      // Preselect the part the link pointed at, falling back to the first.
      const wanted = info.parts.find((p) => p.page === info.requestedPage);
      this.selectedPage.set(wanted?.page ?? info.parts[0]?.page ?? 1);
      // Default to the best that can actually be delivered.
      this.selectedQuality.set(info.qualities[0]?.id);
    } catch (err) {
      this.localError.set(err as AppError);
    } finally {
      this.resolving.set(false);
    }
  }

  /** Begin the download; progress arrives over SSE. */
  protected async start(): Promise<void> {
    const value = this.input().trim();
    if (!value || this.downloading() || this.starting()) return;

    this.starting.set(true);
    this.localError.set(null);
    this.events.reset();
    try {
      await this.ipc.startDownload(value, this.selectedPage(), this.selectedQuality());
    } catch (err) {
      this.localError.set(err as AppError);
    } finally {
      this.starting.set(false);
    }
  }

  /**
   * Hand the finished file to the New Project wizard.
   *
   * The path travels as a query param rather than shared state so the wizard
   * stays independently reachable and a reload does not lose the selection.
   */
  protected useAsSource(): void {
    const path = this.completedPath();
    if (!path) return;
    void this.router.navigate(['/new'], { queryParams: { source: path } });
  }

  /** Reveal the finished file in Finder/Explorer. */
  protected async reveal(): Promise<void> {
    const path = this.completedPath();
    if (path) await this.ipc.openOutputFolder(path);
  }

  /** Clear everything so the screen can take another link. */
  protected reset(): void {
    this.events.reset();
    this.localError.set(null);
    this.video.set(null);
    this.input.set('');
    this.selectedQuality.set(undefined);
  }

  protected dismissError(): void {
    this.localError.set(null);
    this.events.reset();
  }

  /** mm:ss for a part duration. */
  protected formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
}
