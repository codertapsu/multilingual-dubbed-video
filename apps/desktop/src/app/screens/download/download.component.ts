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
import { ProjectStore } from '../../core/state/project.store';
import { clockDuration, fileName, shortDate } from '../../core/util/list-format';
import { defaultSeriesAi, rememberSeriesAi } from '../../shared/series-ai';
import { LanguageNamePipe, TranslatePipe, TranslateService } from '../../core/i18n';
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
import { DOWNLOAD_FILTERS, downloadCounts, filterDownloads, shortUrl, sourcePageOf, type DownloadFilter } from './download-list';
import { dubResultRows, type DubResultRow } from './dub-results';
import { linkedPage, partRanges, pickParts } from './part-pick';
import { sourceErrorKeys } from './source-errors';
import { PartNameFieldComponent } from '../../shared/series/part-name-field.component';

/** Rows shown before "Show more". */
const PAGE = 30;

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
  imports: [LanguageNamePipe, FormsModule, RouterLink, TranslatePipe, ErrorBannerComponent, PartNameFieldComponent],
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
  /** The checked video's parts to download (part-pick.ts): the linked one at first, any others ticked. */
  protected readonly pickedPages = signal<ReadonlySet<number>>(new Set());
  /** The part clicked last, where a Shift-click's range starts. */
  private lastPart: number | undefined;
  protected readonly partRanges = partRanges;
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

  // ---- the list: search, filters, pages ---------------------------------
  // A long list (a playlist, a series' parts) used to push the sign-in and dub
  // cards out of reach below it (2026-11-27): they are above it now, and the
  // list itself can be searched, narrowed and paged.
  protected readonly query = signal('');
  protected readonly filter = signal<DownloadFilter>('all');
  protected readonly limit = signal(PAGE);
  protected readonly filters = DOWNLOAD_FILTERS;
  protected readonly filterKeys: Record<DownloadFilter, string> = {
    all: 'source-video.filter-all',
    active: 'source-video.filter-active',
    done: 'source-video.filter-done',
    problem: 'source-video.filter-problem',
  };
  protected readonly counts = computed(() => downloadCounts(this.items()));
  protected readonly visible = computed(() => filterDownloads(this.items(), { query: this.query(), filter: this.filter() }));
  protected readonly shown = computed(() => this.visible().slice(0, this.limit()));
  /** Failed or cancelled: "Retry all" tries them again. */
  protected readonly retryable = computed(() => this.items().filter((i) => i.state === 'failed' || i.state === 'cancelled'));
  /** The download whose link was just copied, for a moment's "Copied". */
  protected readonly copiedId = signal<string | null>(null);
  protected readonly shortUrl = shortUrl;
  protected readonly sourcePageOf = sourcePageOf;
  protected readonly fileName = fileName;
  /** The projects made from downloads, by id: "Used in" names them and opens them. */
  private readonly projectStore = inject(ProjectStore);
  private readonly projectById = computed(() => new Map(this.projectStore.projects().map((p) => [p.id, p])));
  /** The checked video's cover could not be shown (the app loads no pictures from other sites). */
  protected readonly coverBroken = signal(false);
  private readonly dubCard = viewChild<ElementRef<HTMLElement>>('dubCard');

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
  /** How the parts of each split video are named ('' = the usual names). */
  protected readonly dubSplitTemplate = signal('');
  /** The part names' example: the first ticked video, in the preset's language. */
  protected readonly dubExampleName = computed(() => {
    const first = this.selectedDone()[0];
    return first ? this.titleOf(first) : '';
  });
  protected readonly dubTargetLanguage = computed(() => this.presets().find((p) => p.id === this.presetId())?.targetLanguage ?? 'vi');

  /** Only multi-part videos need a picker; a single part is implied. */
  protected readonly showPartPicker = computed(() => (this.video()?.parts.length ?? 0) > 1);
  /**
   * "All parts", as the box shows it: with a checked multi-part video, whether
   * every part is ticked (unticking one unticks it); else the choice itself.
   */
  protected readonly allPartsShown = computed(() =>
    this.showPartPicker() ? this.pickedPages().size === this.video()!.parts.length : this.allParts(),
  );
  /** A checked multi-part video with no part ticked: nothing to download. */
  protected readonly noPartPicked = computed(() => this.showPartPicker() && this.pickedPages().size === 0);

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
    // Names for "Used in": best-effort, the ids show until they come.
    void this.projectStore.refreshProjects();
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
    this.coverBroken.set(false);
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
      // The part the link pointed at (else the first), or every part when "All parts" is on.
      this.pickedPages.set(new Set(this.allParts() ? info.parts.map((p) => p.page) : [linkedPage(info)]));
      this.lastPart = undefined;
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.resolving.set(false);
    }
  }

  /** Put the pasted links on the download list. */
  protected async add(): Promise<void> {
    const links = this.links();
    if (links.length === 0 || this.adding() || this.noPartPicked()) return;
    // A checked multi-part video downloads the parts ticked in its preview, one
    // download each; other links the part they point at, or all with "All parts".
    const pages = links.length === 1 && this.showPartPicker() ? [...this.pickedPages()].sort((a, b) => a - b) : undefined;
    const height = this.targetHeight();
    const quality = height ? { targetHeightPx: height } : {};
    this.adding.set(true);
    this.error.set(null);
    this.notice.set(null);
    try {
      const res = await this.ipc.addDownloads(
        pages ? pages.map((page) => ({ input: links[0]!, page, ...quality })) : links.map((input) => ({ input, ...quality })),
        pages ? false : this.allParts(),
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

  /** "All parts": with a checked multi-part video, ticks every part (or goes back to the linked one). */
  protected setAllParts(on: boolean): void {
    this.allParts.set(on);
    const info = this.video();
    if (info && info.parts.length > 1) {
      this.pickedPages.set(new Set(on ? info.parts.map((p) => p.page) : [linkedPage(info)]));
      this.lastPart = undefined;
    }
  }

  /** A part ticked or unticked; with Shift, every part since the last one clicked too. */
  protected togglePart(page: number, event: MouseEvent): void {
    const on = (event.target as HTMLInputElement).checked;
    const pages = this.video()?.parts.map((p) => p.page) ?? [];
    this.pickedPages.set(pickParts(this.pickedPages(), pages, page, on, event.shiftKey ? this.lastPart : undefined));
    this.lastPart = page;
  }

  /** Every part of the checked video, or none. */
  protected pickAllParts(on: boolean): void {
    this.pickedPages.set(new Set(on ? (this.video()?.parts ?? []).map((p) => p.page) : []));
    this.lastPart = undefined;
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

  protected clearSelection(): void {
    this.selected.set(new Set());
  }

  protected setQuery(query: string): void {
    this.query.set(query);
    this.limit.set(PAGE);
  }

  protected setFilter(filter: DownloadFilter): void {
    this.filter.set(filter);
    this.limit.set(PAGE);
  }

  protected clearFilters(): void {
    this.query.set('');
    this.filter.set('all');
    this.limit.set(PAGE);
  }

  protected showMore(): void {
    this.limit.update((n) => n + PAGE);
  }

  /** The video's page on its site, in the default browser. */
  protected openSource(item: DownloadItem): void {
    const url = sourcePageOf(item);
    if (url) void this.ipc.openExternal(url);
  }

  /** The video's link on the clipboard, with a moment's "Copied". */
  protected async copyLink(item: DownloadItem): Promise<void> {
    try {
      await navigator.clipboard.writeText(sourcePageOf(item) ?? item.input);
      this.copiedId.set(item.id);
      setTimeout(() => {
        if (this.copiedId() === item.id) this.copiedId.set(null);
      }, 1500);
    } catch {
      /* no clipboard here: the link is on screen to copy by hand */
    }
  }

  /** Every failed or cancelled download tried again, in the list's order. */
  protected async retryAll(): Promise<void> {
    for (const item of this.retryable()) await this.retry(item);
  }

  /**
   * "Dub N videos" from the list's own bar, with the choices in the dub card
   * above it; the card then comes into view, since its answer is shown there.
   */
  protected async dubFromList(): Promise<void> {
    await this.dubSelected();
    this.dubCard()?.nativeElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** A project made from a download: its name (its id until the list has come), and the screen it opens on. */
  protected madeProject(id: string): { name: string; link: string[] } {
    const p = this.projectById().get(id);
    if (!p) return { name: id, link: ['/project', id, 'processing'] };
    const screen = p.series?.role === 'parent' ? 'series' : p.status === 'completed' ? 'editor' : 'processing';
    return { name: p.name, link: ['/project', id, screen] };
  }

  /** A date as short as it can be told apart, in the app's language. */
  protected dateOf(iso: string | undefined): string {
    return iso ? shortDate(iso, this.translate.locale()) : '';
  }

  /** The video's length as players write it ("24:05", "1:02:40"). */
  protected lengthOf(item: DownloadItem): string | undefined {
    return item.source?.durationSec ? clockDuration(item.source.durationSec * 1000) : undefined;
  }

  /** The quality it came in, or the ceiling asked for while it is not here yet. */
  protected qualityOf(item: DownloadItem): string | undefined {
    if (item.heightPx) return `${item.heightPx}p`;
    if (item.targetHeightPx) return this.translate.instant('source-video.quality-up-to', { h: item.targetHeightPx });
    return undefined;
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
          ? {
              series: {
                minMinutes: min!,
                maxMinutes: max!,
                aiProviderId: this.dubSplitAi(),
                longerThanMinutes: this.dubSplitAbove(),
                autoStart: true,
                ...(this.dubSplitTemplate().trim() ? { nameTemplate: this.dubSplitTemplate().trim() } : {}),
              },
            }
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

  /** Clock time of a rate-limit retry, in the app's language (the system's wrote "09:51:04 AM" in Vietnamese text). */
  protected timeOf(iso: string): string {
    return new Date(iso).toLocaleTimeString(this.translate.locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
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
