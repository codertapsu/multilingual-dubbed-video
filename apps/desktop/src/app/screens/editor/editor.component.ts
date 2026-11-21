import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
  type OnDestroy,
  type OnInit,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';

import type { HasUnsavedChanges } from '../../core/guards/unsaved-changes.guard';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { IpcService } from '../../core/ipc/ipc.service';
import { toAppError } from '../../core/state/project.store';
import { ConfirmService } from '../../shared/confirm-dialog/confirm.service';
import { ErrorBannerComponent } from '../../shared/error-banner/error-banner.component';
import { InspectorComponent } from './studio/inspector.component';
import { LinesPanelComponent } from './studio/lines-panel.component';
import { describeTightenReason } from './studio/notes';
import { PlaybackService, type MonitorMode } from './studio/playback.service';
import { PreviewComponent } from './studio/preview.component';
import { ProjectPanelComponent } from './studio/project-panel.component';
import { StudioStore, type SaveState } from './studio/studio.store';
import { TimelineComponent } from './studio/timeline.component';

const TIMELINE_H_KEY = 'vd.studio.timelineHeight';
const LINES_OPEN_KEY = 'vd.studio.linesOpen';

/**
 * EditorComponent (route "project/:id/editor") — the dubbing studio.
 *
 *   ┌ toolbar: project · save state · undo/redo · voice changed lines · render ┐
 *   │ notice: being dubbed (read-only) | waiting at the review checkpoint      │
 *   │ lines (search/filter) │ preview + transport │ inspector | project panel  │
 *   ├────────────────────── resizable splitter ────────────────────────────────┤
 *   │ timeline: ruler · filmstrip · original waveform · source · subtitles · dub│
 *
 * Every edit autosaves (debounced) through StudioStore; timing edits re-place
 * the existing clips server-side, so what you see and hear is what renders.
 * The previous editor's settings / re-dub / character-sheet surface lives on
 * in the Project tab; the review checkpoint's way forward ("Continue
 * dubbing") is in the toolbar, where Render is otherwise.
 */
@Component({
  selector: 'vd-editor',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [StudioStore, PlaybackService],
  imports: [
    RouterLink,
    TranslatePipe,
    ErrorBannerComponent,
    LinesPanelComponent,
    PreviewComponent,
    InspectorComponent,
    ProjectPanelComponent,
    TimelineComponent,
  ],
  templateUrl: './editor.component.html',
  styleUrl: './editor.component.scss',
})
export class EditorComponent implements OnInit, OnDestroy, HasUnsavedChanges {
  readonly id = input.required<string>();

  protected readonly store = inject(StudioStore);
  protected readonly playback = inject(PlaybackService);
  private readonly ipc = inject(IpcService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmService);
  private readonly translate = inject(TranslateService);

  private readonly timeline = viewChild(TimelineComponent);
  private readonly inspector = viewChild(InspectorComponent);
  private readonly projectPanel = viewChild(ProjectPanelComponent);

  /** In the store: the Project tab's speakers can show their lines in the Line tab. */
  protected readonly sideTab = this.store.sideTab;
  protected readonly linesOpen = signal(localStorage.getItem(LINES_OPEN_KEY) !== '0');
  protected readonly timelineHeight = signal(Number(localStorage.getItem(TIMELINE_H_KEY)) || 300);
  protected readonly rendering = signal(false);
  protected readonly showHelp = signal(false);

  protected readonly projectName = computed(() => this.store.project()?.name ?? '');
  protected readonly canRender = computed(() => this.store.aligned() && !this.rendering());
  /**
   * Why Render is greyed out, said next to it. It used to be disabled with no
   * word, and at the review checkpoint (no voices yet) that looked like the
   * end of the road.
   */
  protected readonly renderWhy = computed<'running' | 'no-voices' | null>(() => {
    if (this.store.aligned() || this.store.loading()) return null;
    return this.store.dubRunning() ? 'running' : 'no-voices';
  });
  /** Why "Tighten to fit" kept a line, in words (the server gives its reason in English). */
  protected readonly tightenText = computed(() => {
    const kept = this.store.tightenKept();
    if (!kept) return null;
    const reason = describeTightenReason(kept.reason, (key, params) => this.translate.instant(key, params));
    return this.translate.instant('studio.tighten-kept', { n: kept.line, reason });
  });

  private readonly monitors: readonly MonitorMode[] = ['mix', 'original', 'dub'];
  protected readonly saveKeys: Record<SaveState, string> = {
    saved: 'studio.save-saved',
    pending: 'studio.save-pending',
    saving: 'studio.save-saving',
    error: 'studio.save-error',
  };

  constructor() {
    // The preview plays what the timeline shows — re-placed live during edits.
    effect(() => {
      const clips = this.store
        .units()
        .map((u) => ({ u, url: this.store.clipUrl(u) }))
        .filter((c): c is { u: (typeof c)['u']; url: string } => c.url !== null && c.u.placedDurationMs > 0)
        .map(({ u, url }) => ({ id: u.id, startMs: u.startMs, durationMs: u.placedDurationMs, url }));
      this.playback.setClips(clips);
    });
    // Simulate the project's mix in the preview (ducking, original removed).
    effect(() => {
      const s = this.store.settings();
      if (!s) return;
      this.playback.duckingDb.set(s.duckOriginalAudio === false ? 0 : s.duckingLevelDb);
      this.playback.originalMode.set(s.originalAudioMode ?? (s.includeOriginalBackgroundAudio ? 'keep' : 'remove'));
    });
  }

  ngOnInit(): void {
    void this.store.load(this.id());
  }

  ngOnDestroy(): void {
    // Best effort: an edit made in the last half-second still reaches the disk.
    void this.store.flushNow();
  }

  /**
   * Route guard: only the drafts that are lost on leaving count (the project
   * settings, the character sheet, the greeting times: each saved by its own
   * button). Line edits save themselves, and the last ones are flushed as the
   * editor closes, so they are not asked about.
   */
  hasUnsavedChanges(): boolean {
    return (this.projectPanel()?.unsavedDrafts().length ?? 0) > 0;
  }

  /** What the leave prompt names. */
  unsavedChangesList(): string[] {
    return this.projectPanel()?.unsavedDrafts() ?? [];
  }

  // ------------------------------------------------------------- actions

  protected onPick(e: { id: string; mode: 'replace' | 'toggle' | 'range' }): void {
    this.store.select(e.id, e.mode);
    const seg = this.store.segments()[this.store.indexById().get(e.id) ?? -1];
    if (seg && e.mode === 'replace') {
      this.playback.seek(seg.startMs);
      this.timeline()?.reveal(seg.startMs);
    }
    this.sideTab.set('line');
  }

  protected editText(): void {
    this.sideTab.set('line');
    this.inspector()?.focusText();
  }

  protected toggleLines(): void {
    this.linesOpen.update((v) => !v);
    localStorage.setItem(LINES_OPEN_KEY, this.linesOpen() ? '1' : '0');
  }

  /** Leave the review checkpoint (the toolbar's way forward), then follow the dub. */
  protected async continueDubbing(): Promise<void> {
    if (await this.store.continueDubbing()) {
      await this.router.navigate(['/project', this.store.projectId(), 'processing']);
    }
  }

  /** Re-mix + render from the edited timeline (alignment is already on disk). */
  protected async render(): Promise<void> {
    if (this.rendering()) return;
    // Rendering restarts the dub from the mix: a dub in progress is stopped
    // first (orchestrator.retryStep cancels it), so ask before doing that.
    if (
      this.store.dubRunning() &&
      !(await this.confirm.confirm({
        title: this.translate.instant('studio.stop-dub-title'),
        message: this.translate.instant('studio.stop-dub-body'),
        confirmLabel: this.translate.instant('studio.stop-dub-render'),
      }))
    ) {
      return;
    }
    this.rendering.set(true);
    try {
      // Voicing the changed lines below is refused while the dub runs.
      if (this.store.dubRunning() && !(await this.store.stopRunningDub())) return;
      if (!(await this.store.flushNow())) return;
      const stale = this.store.staleCount();
      if (stale > 0) {
        const ok = await this.confirm.confirm({
          title: this.translate.instant('studio.render-stale-title'),
          message: this.translate.instant('studio.render-stale-body', { n: stale }),
          confirmLabel: this.translate.instant('studio.render-stale-confirm'),
        });
        if (!ok) return;
        await this.store.regenerateStale();
        if (this.store.staleCount() > 0) return;
      }
      this.playback.pause();
      await this.ipc.retryPipelineStep(this.store.projectId(), 'audio-mix');
      await this.router.navigate(['/project', this.store.projectId(), 'processing']);
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.rendering.set(false);
    }
  }

  // ------------------------------------------------------------ splitter

  protected onSplitterDown(e: PointerEvent): void {
    const startY = e.clientY;
    const startH = this.timelineHeight();
    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent): void => {
      const h = Math.max(200, Math.min(window.innerHeight - 260, startH + (startY - ev.clientY)));
      this.timelineHeight.set(h);
    };
    const up = (): void => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      localStorage.setItem(TIMELINE_H_KEY, String(this.timelineHeight()));
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  }

  // ----------------------------------------------------------- keyboard

  @HostListener('window:keydown', ['$event'])
  protected onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    const target = e.target as HTMLElement | null;
    const typing =
      !!target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));

    // Save works everywhere; the rest yield to a focused text field.
    if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      void this.store.flushNow();
      return;
    }
    if (typing) {
      if (e.key === 'Escape') target?.blur();
      return;
    }

    const sel = [...this.store.selection()];
    const primary = this.store.primary();
    const key = e.key;

    if (mod && key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.store.redo();
      else this.store.undo();
      return;
    }
    if (mod && key.toLowerCase() === 'y') {
      e.preventDefault();
      this.store.redo();
      return;
    }
    if (mod && key.toLowerCase() === 'a') {
      e.preventDefault();
      this.store.selection.set(new Set(this.store.segments().map((s) => s.id)));
      return;
    }
    if ((mod && (key === '=' || key === '+')) || (!mod && (key === '=' || key === '+'))) {
      e.preventDefault();
      this.timeline()?.zoomBy(1.5);
      return;
    }
    if (key === '-' || key === '_') {
      e.preventDefault();
      this.timeline()?.zoomBy(1 / 1.5);
      return;
    }
    if (mod && key === '0') {
      e.preventDefault();
      this.timeline()?.zoomToFit();
      return;
    }
    if (mod) return;

    const frame = 1000 / (this.store.media()?.fps || 30);
    switch (key) {
      case ' ':
        e.preventDefault();
        this.playback.toggle();
        break;
      case 'j':
      case 'k':
      case 'l':
        this.playback.shuttle(key);
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.playback.skip(e.shiftKey ? -1000 : -frame);
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.playback.skip(e.shiftKey ? 1000 : frame);
        break;
      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const seg = this.store.step(key === 'ArrowUp' ? -1 : 1);
        if (seg) {
          this.playback.seek(seg.startMs);
          this.timeline()?.reveal(seg.startMs);
        }
        break;
      }
      case 'Home':
        this.playback.seek(0);
        break;
      case 'End':
        this.playback.seek(this.store.durationMs());
        break;
      case 'Enter':
        if (primary) {
          e.preventDefault();
          this.editText();
        }
        break;
      case 'Escape':
        this.store.clearSelection();
        break;
      case '[':
      case ']':
        if (sel.length) this.store.shift(sel, (key === '[' ? -1 : 1) * (e.shiftKey ? 100 : 10), `kbd-shift:${sel.join(',')}`);
        break;
      case '{':
      case '}':
        if (sel.length) this.store.shift(sel, (key === '{' ? -1 : 1) * 100, `kbd-shift:${sel.join(',')}`);
        break;
      case 'i':
      case 'o':
        if (primary) {
          const t = Math.round(this.playback.currentMs());
          const s = primary.seg;
          if (key === 'i' && t < s.endMs) this.store.setTiming([{ id: s.id, startMs: Math.max(0, t), endMs: s.endMs }], 'studio.undo-trim');
          if (key === 'o' && t > s.startMs) this.store.setTiming([{ id: s.id, startMs: s.startMs, endMs: t }], 'studio.undo-trim');
        }
        break;
      case 'r':
        // Once per clip, none already being voiced (the store maps lines to clips).
        if (sel.length) void this.store.regenerate(sel);
        break;
      case 'm': {
        const i = this.monitors.indexOf(this.playback.monitor());
        this.playback.setMonitor(this.monitors[(i + 1) % this.monitors.length]!);
        break;
      }
      case '?':
        this.showHelp.update((v) => !v);
        break;
      default:
        return;
    }
  }

  @HostListener('window:blur')
  protected onBlur(): void {
    // Switching away from the app saves immediately rather than after the debounce.
    void this.store.flushNow();
  }
}
