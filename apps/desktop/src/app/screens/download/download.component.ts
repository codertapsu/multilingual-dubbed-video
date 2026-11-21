import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
  type ElementRef,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';

import { DownloadEventsService } from '../../core/ipc/download-events.service';
import { IpcService } from '../../core/ipc/ipc.service';
import { defaultSeriesAi, rememberSeriesAi } from '../../shared/series-ai';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { QUALITY_LADDER, pickClosestHeight } from '@videodubber/shared';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { ConfirmService } from '../../shared/confirm-dialog/confirm.service';
import { toAppError } from '../../core/state/project.store';
import type { AppError } from '../../core/models';
import type { SeriesAiOption } from '@videodubber/shared';
import type {
  DownloadItem,
  DownloadProvider,
  DubPreset,
  QualityOption,
  ResolvedVideo,
  SessionCheck,
  SessionInfo,
} from '../../core/models/download';
import { bilibiliLoginFrom, MAX_COOKIE_FILE_BYTES, type CookieFileProblem } from './cookie-file';
import { dubResultRows, type DubResultRow } from './dub-results';
import { sourceErrorKeys } from './source-errors';

/**
 * DownloadComponent (route "download") — fetch source videos to dub.
 *
 * Paste one link or many. One link can be checked first (title, uploader,
 * parts) so nobody spends hundreds of megabytes on the wrong link; several go
 * straight to the download list, which the orchestrator works through two at
 * a time (providers/download/queue.ts) and keeps across restarts. Finished
 * videos can be dubbed in one go with a preset, or one by one in New project.
 *
 * Marked experimental in the UI: it depends on third-party sites' public web
 * endpoints, which can change without notice.
 */
@Component({
  selector: 'vd-download',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe, ErrorBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './download.component.html',
  styleUrl: './download.component.scss',
})
export class DownloadComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly router = inject(Router);
  private readonly translate = inject(TranslateService);
  private readonly confirm = inject(ConfirmService);
  protected readonly events = inject(DownloadEventsService);

  protected readonly input = signal('');
  /** The pasted lines that hold something. */
  protected readonly links = computed(() =>
    this.input()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean),
  );
  protected readonly resolving = signal(false);
  protected readonly adding = signal(false);
  protected readonly video = signal<ResolvedVideo | null>(null);
  /** A list link's videos (a collection, favourites, an uploader's page), to tick. */
  protected readonly list = signal<{ title: string; total: number; videos: { input: string; title: string; durationSec: number }[] } | null>(null);
  protected readonly listPicked = signal<ReadonlySet<string>>(new Set());
  protected readonly selectedPage = signal(1);
  /**
   * Preferred quality, as a pixel height. Undefined means "the best there is".
   * A standing preference rather than a pick from one video's list: the whole
   * ladder stays selectable, and each download snaps to the closest its video
   * can serve.
   */
  protected readonly targetHeight = signal<number | undefined>(undefined);
  protected readonly allParts = signal(false);
  protected readonly qualityLadder = QUALITY_LADDER;
  protected readonly error = signal<AppError | null>(null);
  /** What the last action did ("3 added to downloads."). */
  protected readonly notice = signal<string | null>(null);

  protected readonly items = this.events.items;
  protected readonly doneItems = computed(() => this.items().filter((i) => i.state === 'done'));

  // ---- dubbing finished downloads with a preset ------------------------
  protected readonly presets = signal<DubPreset[]>([]);
  protected readonly presetId = signal('');
  protected readonly dubStart = signal(true);
  protected readonly dubbing = signal(false);
  /** What the last "Dub N videos" did, one line per video, shown under the button. */
  protected readonly dubResults = signal<DubResultRow[] | null>(null);
  /** The dub request itself failed: shown in the dub card, where the button is. */
  protected readonly dubError = signal<AppError | null>(null);
  protected readonly dubMade = computed(() => (this.dubResults() ?? []).filter((r) => r.outcome !== 'failed').length);
  protected readonly dubParts = computed(() => (this.dubResults() ?? []).filter((r) => r.outcome === 'series').length);
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly selectedDone = computed(() => this.doneItems().filter((i) => this.selected().has(i.id)));
  /**
   * Long ones as a series of parts (series/): only with an AI from Settings,
   * which the user picks when there are several (Claude through Mother Claude
   * first, as in New project).
   */
  protected readonly seriesAiReady = signal<SeriesAiOption[]>([]);
  protected readonly dubSplit = signal(false);
  protected readonly dubSplitLength = signal<'15-20' | '30-40' | '55-65'>('15-20');
  protected readonly dubSplitAi = signal('');
  /** Only videos longer than this are split: below it, two parts would be shorter than the shortest part asked for. */
  protected readonly dubSplitAbove = computed(() => Math.round(Number(this.dubSplitLength().split('-')[1]) * 1.5));

  /** Only multi-part videos need a picker; a single part is implied. */
  protected readonly showPartPicker = computed(() => (this.video()?.parts.length ?? 0) > 1);

  /** The checked video's qualities (empty when none was checked, or the probe failed). */
  protected readonly qualities = computed<QualityOption[]>(() => this.video()?.qualities ?? []);

  /**
   * What the preference will download for the checked video. Same function as
   * the orchestrator's, so the promise made here and the choice made there
   * cannot drift.
   */
  protected readonly resolvedQuality = computed<QualityOption | undefined>(() => {
    const available = this.qualities();
    const height = pickClosestHeight(
      available.map((q) => q.heightPx ?? 0),
      this.targetHeight(),
    );
    return available.find((q) => q.heightPx === height);
  });

  protected readonly qualityDowngraded = computed(() => {
    const target = this.targetHeight();
    const resolved = this.resolvedQuality()?.heightPx;
    return target !== undefined && resolved !== undefined && resolved !== target;
  });

  // ---- optional per-provider credentials -------------------------------
  // Owned by this screen rather than Settings: it exists only to raise the
  // ceiling of THIS feature.
  protected readonly providers = signal<DownloadProvider[]>([]);
  protected readonly sessionInput = signal('');
  protected readonly sessionBusy = signal<string | null>(null);
  protected readonly sessionCheck = signal<SessionCheck | null>(null);
  protected readonly sessionOpen = signal(false);
  protected readonly sessionProviders = computed(() => this.providers().filter((p) => p.supportsSession));
  /** Why the chosen cookie file cannot sign the app in (never anything from inside it). */
  protected readonly cookieProblem = signal<CookieFileProblem | 'too-big' | null>(null);
  /** A sign-in action failed: shown in the sign-in card, not at the top of the screen. */
  protected readonly sessionError = signal<AppError | null>(null);
  private readonly sessionCard = viewChild<ElementRef<HTMLElement>>('sessionCard');

  ngOnInit(): void {
    // The server replays every download on connect: the list is right after a
    // navigation or a reload mid-download.
    this.events.connect();
    void this.loadProviders();
    void this.loadPresets();
    void this.loadSeriesAi();
  }

  private async loadSeriesAi(): Promise<void> {
    try {
      const ready = (await this.ipc.seriesAiOptions()).filter((o) => o.ready);
      this.seriesAiReady.set(ready);
      if (!ready.some((o) => o.id === this.dubSplitAi())) this.dubSplitAi.set(defaultSeriesAi(ready));
    } catch {
      /* the option says it needs an AI */
    }
  }

  ngOnDestroy(): void {
    this.events.disconnect();
  }

  private async loadProviders(): Promise<void> {
    try {
      this.providers.set(await this.ipc.getDownloadProviders());
    } catch {
      /* optional affordance — never block the screen on it */
    }
  }

  private async loadPresets(): Promise<void> {
    try {
      const list = await this.ipc.listPresets();
      this.presets.set(list);
      if (!list.some((p) => p.id === this.presetId())) this.presetId.set(list[0]?.id ?? '');
    } catch {
      /* the dub card says there are none */
    }
  }

  protected sessionFor(providerId: string): SessionInfo | undefined {
    return this.providers().find((p) => p.id === providerId)?.session;
  }

  /** A provider's display name; the id itself when there is no translation yet. */
  protected providerLabel(providerId: string): string {
    const key = `source-video.provider.${providerId}`;
    const label = this.translate.instant(key);
    return label === key ? providerId : label;
  }

  /** A quality rung's name; a plain "1080p" when it has no translation. */
  protected qualityLabelFor(rung: { heightPx: number; key: string }): string {
    const key = `source-video.quality-${rung.key}`;
    const label = this.translate.instant(key);
    return label === key ? `${rung.heightPx}p` : label;
  }

  protected async saveSession(providerId: string): Promise<void> {
    const value = this.sessionInput().trim();
    if (!value || this.sessionBusy()) return;
    await this.storeSession(providerId, value);
    // Drop the plaintext from the form as soon as it is stored.
    if (!this.sessionError()) this.sessionInput.set('');
  }

  /**
   * "Choose the cookie file": the sign-in from a browser's cookie export. The
   * file is read here and only Bilibili's two cookies leave this function, to
   * the orchestrator; nothing from it is shown or kept, and a file that cannot
   * sign the app in is answered with the reason (cookie-file.ts).
   */
  protected async onCookieFile(event: Event, providerId: string): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || this.sessionBusy()) return;
    this.cookieProblem.set(null);
    this.sessionError.set(null);
    this.sessionCheck.set(null);
    if (file.size > MAX_COOKIE_FILE_BYTES) {
      this.cookieProblem.set('too-big');
      return;
    }
    const login = bilibiliLoginFrom(await file.text());
    if (!login.ok) {
      this.cookieProblem.set(login.problem);
      return;
    }
    await this.storeSession(providerId, login.cookie);
  }

  /** Save a sign-in, then ask the site at once whether it works: the user should not have to. */
  private async storeSession(providerId: string, cookie: string): Promise<void> {
    this.sessionBusy.set(providerId);
    this.sessionCheck.set(null);
    this.sessionError.set(null);
    this.cookieProblem.set(null);
    try {
      await this.ipc.setProviderSession(providerId, cookie);
      await this.loadProviders();
      this.sessionCheck.set(await this.ipc.testProviderSession(providerId).catch(() => null));
    } catch (err) {
      this.sessionError.set(toAppError(err));
    } finally {
      this.sessionBusy.set(null);
    }
  }

  protected async clearSession(providerId: string): Promise<void> {
    if (this.sessionBusy()) return;
    this.sessionBusy.set(providerId);
    this.sessionError.set(null);
    this.cookieProblem.set(null);
    try {
      await this.ipc.clearProviderSession(providerId);
      this.sessionInput.set('');
      this.sessionCheck.set(null);
      await this.loadProviders();
    } catch (err) {
      this.sessionError.set(toAppError(err));
    } finally {
      this.sessionBusy.set(null);
    }
  }

  /** Surface an expired credential, which otherwise just silently caps quality. */
  protected async checkSession(providerId: string): Promise<void> {
    if (this.sessionBusy()) return;
    this.sessionBusy.set(providerId);
    this.sessionCheck.set(null);
    this.sessionError.set(null);
    try {
      this.sessionCheck.set(await this.ipc.testProviderSession(providerId));
    } catch (err) {
      this.sessionError.set(toAppError(err));
    } finally {
      this.sessionBusy.set(null);
    }
  }

  /** From a download that needs a signed-in account: open the sign-in card and bring it into view. */
  protected openSignIn(): void {
    this.sessionOpen.set(true);
    setTimeout(() => this.sessionCard()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  /** The sign-in card's own open state (the summary toggles it too). */
  protected onSessionToggle(event: Event): void {
    this.sessionOpen.set((event.target as HTMLDetailsElement).open);
  }

  /** A download failure the user can act on, in their language; null keeps the server's words. */
  protected readonly sourceError = sourceErrorKeys;

  /** A failure in a sentence or two: what happened and what to do when the code is known, else the server's message. */
  private errorLine(error: AppError): string {
    const keys = sourceErrorKeys(error);
    return keys ? `${this.translate.instant(keys.message)} ${this.translate.instant(keys.fix)}` : error.message;
  }

  /** Look one link up without downloading anything. */
  protected async resolve(): Promise<void> {
    const value = this.links()[0];
    if (!value || this.links().length !== 1 || this.resolving()) return;
    this.resolving.set(true);
    this.error.set(null);
    this.notice.set(null);
    this.video.set(null);
    this.list.set(null);
    try {
      // A list link: its videos, all ticked.
      const { list } = await this.ipc.expandDownload(value);
      if (list) {
        this.list.set(list);
        this.listPicked.set(new Set(list.videos.map((v) => v.input)));
        return;
      }
      const info = await this.ipc.resolveDownload(value);
      this.video.set(info);
      // Preselect the part the link pointed at, falling back to the first.
      const wanted = info.parts.find((p) => p.page === info.requestedPage);
      this.selectedPage.set(wanted?.page ?? info.parts[0]?.page ?? 1);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.resolving.set(false);
    }
  }

  /** Put the pasted links on the download list. */
  protected async add(): Promise<void> {
    const links = this.links();
    if (links.length === 0 || this.adding()) return;
    // A checked single video downloads the part picked in its preview.
    const page = links.length === 1 && this.video() && !this.allParts() ? this.selectedPage() : undefined;
    const height = this.targetHeight();
    this.adding.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const res = await this.ipc.addDownloads(
        links.map((input) => ({ input, ...(page ? { page } : {}), ...(height ? { targetHeightPx: height } : {}) })),
        this.allParts(),
      );
      for (const item of [...res.added, ...res.existing]) this.events.upsert(item);
      const lines = [
        ...(res.added.length > 0 ? [this.translate.instant('source-video.added', { n: res.added.length })] : []),
        ...(res.existing.length > 0 ? [this.translate.instant('source-video.already', { n: res.existing.length })] : []),
        // The reason the server gave: every refusal used to read "Not a supported link".
        ...res.rejected.map((r) => this.translate.instant('source-video.rejected-why', { input: r.input, why: this.errorLine(r.error) })),
      ];
      this.notice.set(lines.join(' '));
      if (res.rejected.length === 0) {
        this.input.set('');
        this.video.set(null);
      } else {
        // Keep only the links that were refused, so they can be fixed.
        this.input.set(res.rejected.map((r) => r.input).join('\n'));
      }
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.adding.set(false);
    }
  }

  protected toggleListItem(input: string, on: boolean): void {
    this.listPicked.update((s) => {
      const next = new Set(s);
      if (on) next.add(input);
      else next.delete(input);
      return next;
    });
  }

  /** The ticked videos of a list link, to the download list. */
  protected async addPicked(): Promise<void> {
    const picked = [...this.listPicked()];
    if (picked.length === 0) return;
    this.input.set(picked.join('\n'));
    this.list.set(null);
    await this.add();
  }

  protected async cancel(item: DownloadItem): Promise<void> {
    await this.act(async () => this.events.upsert(await this.ipc.cancelDownload(item.id)));
  }

  protected async retry(item: DownloadItem): Promise<void> {
    await this.act(async () => this.events.upsert(await this.ipc.retryDownload(item.id)));
  }

  /** Off the list; the video stays where it is. */
  protected async remove(item: DownloadItem): Promise<void> {
    await this.act(() => this.ipc.removeDownload(item.id, false));
  }

  /** Off the list, and the video deleted (projects keep their own copy). */
  protected async deleteFile(item: DownloadItem): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('source-video.remove-confirm-title'),
      message: this.translate.instant('source-video.remove-confirm-body'),
      confirmLabel: this.translate.instant('source-video.remove-file'),
    });
    if (ok) await this.act(() => this.ipc.removeDownload(item.id, true));
  }

  private async act(fn: () => Promise<unknown>): Promise<void> {
    this.error.set(null);
    try {
      await fn();
    } catch (err) {
      this.error.set(toAppError(err));
    }
  }

  /** The folder a finished video is in (not the video: it would start playing). */
  protected async reveal(item: DownloadItem): Promise<void> {
    const file = item.filePath;
    if (!file) return;
    const cut = Math.max(file.lastIndexOf('\\'), file.lastIndexOf('/'));
    await this.act(() => this.ipc.openOutputFolder(cut > 0 ? file.slice(0, cut) : file));
  }

  /**
   * Hand a finished file to New project. The path travels as a query param so
   * the wizard stays independently reachable; the server links it into the
   * project (no second copy) because it is a download.
   */
  protected useAsSource(item: DownloadItem): void {
    if (item.filePath) void this.router.navigate(['/new'], { queryParams: { source: item.filePath } });
  }

  protected toggle(item: DownloadItem, on: boolean): void {
    this.selected.update((s) => {
      const next = new Set(s);
      if (on) next.add(item.id);
      else next.delete(item.id);
      return next;
    });
  }

  protected selectAllDone(): void {
    this.selected.set(new Set(this.doneItems().map((i) => i.id)));
  }

  /**
   * A project per ticked video, from the chosen preset. The result is listed
   * under the button, a line per video with the way to its progress.
   */
  protected async dubSelected(): Promise<void> {
    const ids = this.selectedDone().map((i) => i.id);
    if (ids.length === 0 || !this.presetId() || this.dubbing()) return;
    this.dubbing.set(true);
    this.dubError.set(null);
    this.dubResults.set(null);
    try {
      const split = this.dubSplit() && this.dubSplitAi();
      if (split) rememberSeriesAi(this.dubSplitAi());
      const [min, max] = this.dubSplitLength().split('-').map(Number);
      const { results } = await this.ipc.dubDownloads({
        downloadIds: ids,
        presetId: this.presetId(),
        start: this.dubStart(),
        ...(split
          ? { series: { minMinutes: min!, maxMinutes: max!, aiProviderId: this.dubSplitAi(), longerThanMinutes: this.dubSplitAbove(), autoStart: true } }
          : {}),
      });
      this.dubResults.set(dubResultRows(results, this.items()));
      // Untick what was made; a video that failed stays ticked, to try again.
      const failed = new Set(results.filter((r) => r.error || !r.projectId).map((r) => r.downloadId));
      this.selected.update((s) => new Set([...s].filter((id) => failed.has(id))));
    } catch (err) {
      this.dubError.set(toAppError(err));
    } finally {
      this.dubbing.set(false);
    }
  }

  protected titleOf(item: DownloadItem): string {
    return item.source?.title ?? item.input;
  }

  /** Clock time of a rate-limit retry. */
  protected timeOf(iso: string): string {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  protected formatBytes(n: number | undefined): string {
    if (!n) return '0 MB';
    return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
  }

  protected dismissError(): void {
    this.error.set(null);
  }

  /** mm:ss for a part duration. */
  protected formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${String(secs).padStart(2, '0')}`;
  }
}
