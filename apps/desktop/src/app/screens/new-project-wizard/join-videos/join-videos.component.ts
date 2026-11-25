import type { OnDestroy } from '@angular/core';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, model, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { JoinCheck, RenderQuality } from '@videodubber/shared';

import { TranslatePipe } from '../../../core/i18n';
import { IpcService } from '../../../core/ipc/ipc.service';
import type { AppError } from '../../../core/models';
import { toAppError } from '../../../core/state/project.store';
import { formatDurationCoarse } from '../../../core/util/format';
import { BusyIndicatorComponent } from '../../../shared/busy-indicator/busy-indicator.component';
import { ErrorBannerComponent } from '../../../shared/error-banner/error-banner.component';
import { addJoinPaths, fileNameOf, gbOf, moveJoinPath, removeJoinPath, samePaths } from './join-form';

/** The latest check as the form needs it for Continue. */
export interface JoinCheckState {
  checking: boolean;
  check: JoinCheck | null;
  /** The list the check was made of (a check of an older list must not unlock Continue). */
  checkedPaths: string[] | null;
}

/**
 * New project → "Join several videos": the files in the order they play
 * (add, remove, move up and down), and what the app's check says about them
 * as soon as there are two: whether the picture can be copied as it is, or
 * must be encoded again, at what cost on this computer (the user agrees to
 * it here), and whether the drive has room for the joined video.
 *
 * WHY: the 27.8-hour series was five files the agent joined by hand outside
 * the app, and that join garbled two of them (claude-dubber report,
 * 2026-11-23). The app joins them now, each file's sound timed to its own
 * picture; this is where the user says which files, in which order.
 */
@Component({
  selector: 'vd-join-videos',
  standalone: true,
  imports: [FormsModule, TranslatePipe, BusyIndicatorComponent, ErrorBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    p {
      margin: 0;
    }
    .join-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: flex;
      flex-direction: column;
      gap: var(--vd-sp-2);
    }
    .join-item {
      display: flex;
      align-items: center;
      gap: var(--vd-sp-2);
      padding: var(--vd-sp-2) var(--vd-sp-3);
      border: 1px solid var(--vd-border);
      border-radius: var(--vd-radius-sm);
      background: var(--vd-surface);
    }
    .join-item.has-error {
      border-color: var(--vd-danger);
    }
    .join-index {
      flex: none;
      min-width: 1.6rem;
      font-weight: 650;
      color: var(--vd-text-muted);
      font-variant-numeric: tabular-nums;
    }
    .join-body {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .join-file {
      font-weight: 550;
      overflow-wrap: anywhere;
    }
    .join-actions {
      flex: none;
      display: flex;
      gap: 2px;
    }
    .join-add {
      flex-wrap: wrap;
    }
    .join-add input {
      flex: 1;
      min-width: 14rem;
    }
    .warn-text {
      color: var(--vd-warning);
    }
    .danger-text {
      color: var(--vd-danger);
    }
    .ok-text {
      color: var(--vd-success);
    }
    .notice {
      border: 1px solid var(--vd-border);
      border-radius: var(--vd-radius);
      padding: var(--vd-sp-3) var(--vd-sp-4);
    }
    .notice-danger {
      border-color: var(--vd-danger);
      background: var(--vd-danger-bg);
    }
    .notice-warning {
      border-color: var(--vd-warning);
      background: var(--vd-warning-bg);
    }
    .notice ul {
      margin: 0;
      padding-left: 1.2rem;
    }
    .check-row {
      display: flex;
      align-items: center;
      gap: var(--vd-sp-2);
      margin: 0;
      font-weight: 550;
    }
  `,
  template: `
    <div class="stack">
      <p class="hint">{{ 'join.intro' | translate }}</p>

      @if (paths().length === 0) {
        <p class="hint muted">{{ 'join.empty' | translate }}</p>
      } @else {
        <ol class="join-list" [attr.aria-label]="'join.list-aria' | translate">
          @for (p of paths(); track p; let i = $index; let first = $first; let last = $last) {
            @let info = fileInfo(i);
            <li class="join-item" [class.has-error]="!!info?.error">
              <span class="join-index">{{ i + 1 }}</span>
              <span class="join-body" [title]="p">
                <span class="join-file">{{ name(p) }}</span>
                @if (info?.error; as err) {
                  <span class="hint danger-text">{{ 'join.file-error' | translate: { why: err.message } }}</span>
                } @else if (info) {
                  <span class="hint mono">{{ meta(i) }}</span>
                } @else {
                  <span class="hint mono">{{ p }}</span>
                }
              </span>
              @if (!locked()) {
                <span class="join-actions">
                  <button type="button" class="btn btn-ghost btn-sm" (click)="move(i, -1)" [disabled]="first"
                    [attr.aria-label]="'join.up' | translate: { name: name(p) }" [title]="'join.up' | translate: { name: name(p) }">↑</button>
                  <button type="button" class="btn btn-ghost btn-sm" (click)="move(i, 1)" [disabled]="last"
                    [attr.aria-label]="'join.down' | translate: { name: name(p) }" [title]="'join.down' | translate: { name: name(p) }">↓</button>
                  <button type="button" class="btn btn-ghost btn-sm" (click)="remove(i)"
                    [attr.aria-label]="'join.remove' | translate: { name: name(p) }" [title]="'join.remove' | translate: { name: name(p) }">✕</button>
                </span>
              }
            </li>
          }
        </ol>
      }

      @if (locked()) {
        <p class="hint">{{ 'join.locked' | translate }}</p>
      } @else {
        <div class="row join-add">
          @if (inTauri) {
            <button type="button" class="btn btn-sm" (click)="pick()" [title]="'join.add-title' | translate">{{ 'join.add' | translate }}</button>
          }
          <label class="visually-hidden" for="joinPath">{{ 'join.path-label' | translate }}</label>
          <input
            id="joinPath"
            type="text"
            name="joinPath"
            autocomplete="off"
            [placeholder]="'join.path-ph' | translate"
            [ngModelOptions]="{ standalone: true }" [ngModel]="typed()"
            (ngModelChange)="typed.set($event)"
            (keydown.enter)="addTyped($event)"
          />
          <button type="button" class="btn btn-sm" (click)="addTyped()" [disabled]="!typed().trim()">{{ 'join.add-path' | translate }}</button>
        </div>
      }

      @if (error()) {
        <p class="warn-text" role="alert">{{ 'join.check-failed' | translate }}</p>
      }
      <vd-error-banner [error]="error()" (dismiss)="error.set(null)" />

      @if (checking()) {
        <vd-busy-indicator [active]="true" [label]="'join.checking' | translate" />
      } @else if (current(); as c) {
        @if (!c.ok) {
          <div class="notice notice-danger" role="alert">{{ 'join.unusable' | translate }}</div>
        } @else if (c.mode === 'copy') {
          <p class="ok-text">✓ {{ 'join.copy-ok' | translate: { count: c.files.length, duration: duration(c.totalDurationMs) } }}</p>
        } @else {
          <div class="notice notice-warning stack-sm" role="alert">
            <strong>{{ 'join.reencode-title' | translate }}</strong>
            <ul>
              @for (m of c.mismatches; track $index) {
                @let d = { name: c.files[m.index]?.name ?? m.index + 1, value: m.value, expected: m.expected };
                <li>
                  @switch (m.field) {
                    @case ('codec') { {{ 'join.field.codec' | translate: d }} }
                    @case ('profile') { {{ 'join.field.profile' | translate: d }} }
                    @case ('resolution') { {{ 'join.field.resolution' | translate: d }} }
                    @case ('frame-rate') { {{ 'join.field.frame-rate' | translate: d }} }
                    @case ('pixel-format') { {{ 'join.field.pixel-format' | translate: d }} }
                    @case ('encoding') { {{ 'join.field.encoding' | translate: d }} }
                  }
                </li>
              }
            </ul>
            @if (c.reencode; as r) {
              <span>{{ 'join.reencode-target' | translate: { width: r.target.width, height: r.target.height, fps: r.target.fps } }}</span>
              @if (r.estimatedSec !== undefined) {
                <span>{{ 'join.reencode-cost' | translate: { time: duration(r.estimatedSec * 1000), encoder: r.encoder ?? '', size: gb(r.estimatedBytes ?? 0) } }}</span>
              } @else {
                <span>{{ 'join.reencode-cost-unknown' | translate }}</span>
              }
            }
            <label class="check-row">
              <input type="checkbox" name="joinReencode" [checked]="reencode()" (change)="onReencode($event)" [disabled]="locked()" />
              <span>{{ 'join.reencode-agree' | translate }}</span>
            </label>
          </div>
        }
        @if (c.ok && c.mixedSampleRates) {
          <p class="hint">{{ 'join.mixed-rates' | translate }}</p>
        }
        @if (!c.disk.enough) {
          <p class="warn-text" role="alert">{{ 'join.disk-short' | translate: { need: gb(c.disk.needBytes), folder: c.disk.folder, free: gb(c.disk.freeBytes ?? 0) } }}</p>
        } @else if (c.disk.freeBytes !== undefined) {
          <p class="hint">{{ 'join.disk' | translate: { need: gb(c.disk.needBytes), folder: c.disk.folder, free: gb(c.disk.freeBytes) } }}</p>
        } @else {
          <p class="hint">{{ 'join.disk-unknown' | translate: { need: gb(c.disk.needBytes), folder: c.disk.folder } }}</p>
        }
      }
    </div>
  `,
})
export class JoinVideosComponent implements OnDestroy {
  private readonly ipc = inject(IpcService);
  protected readonly inTauri = this.ipc.inTauri;

  /** The files, in the order they play. */
  readonly paths = model<string[]>([]);
  /** The user agreed to encode the picture again. */
  readonly reencode = model(false);
  /** The project was made from this list: shown, no longer changed. */
  readonly locked = input(false);
  /** The project's render quality: which encoder a re-encode uses, and so what it costs. */
  readonly renderQuality = input<RenderQuality | undefined>(undefined);
  /** Every change of the check, for the form's Continue. */
  readonly checkChange = output<JoinCheckState>();

  protected readonly typed = signal('');
  protected readonly checking = signal(false);
  private readonly check = signal<JoinCheck | null>(null);
  private readonly checkedPaths = signal<string[] | null>(null);
  protected readonly error = signal<AppError | null>(null);
  /** The check of exactly the list shown (an older one is not shown as current). */
  protected readonly current = computed(() => (samePaths(this.checkedPaths(), this.paths()) ? this.check() : null));

  private seq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The list the agreement to re-encode was given for. */
  private agreedFor: string[] | null = null;

  constructor() {
    // Check again whenever the list (or the encoder a re-encode would use) changes.
    effect(() => {
      const paths = this.paths();
      const quality = this.renderQuality();
      untracked(() => this.schedule(paths, quality));
    });
  }

  ngOnDestroy(): void {
    clearTimeout(this.timer);
    this.seq++;
  }

  protected name(p: string): string {
    return fileNameOf(p);
  }

  protected gb(bytes: number): string {
    return gbOf(bytes);
  }

  protected duration(ms: number): string {
    return formatDurationCoarse(ms);
  }

  protected fileInfo(i: number): JoinCheck['files'][number] | undefined {
    return this.current()?.files[i];
  }

  /** One file's facts: length, size of picture, rate, codec, sound, bytes. */
  protected meta(i: number): string {
    const f = this.fileInfo(i);
    if (!f) return '';
    const parts = [formatDurationCoarse(f.durationMs)];
    if (f.video) parts.push(`${f.video.width}×${f.video.height}`, `${f.video.fps} fps`, f.video.codec);
    if (f.audio) parts.push(`${f.audio.sampleRate / 1000} kHz`);
    parts.push(`${gbOf(f.sizeBytes)} GB`);
    return parts.join(' · ');
  }

  protected async pick(): Promise<void> {
    try {
      const picked = await this.ipc.pickVideoFile();
      if (picked) this.paths.set(addJoinPaths(this.paths(), [picked]));
    } catch (err) {
      this.error.set(toAppError(err));
    }
  }

  protected addTyped(event?: Event): void {
    event?.preventDefault(); // Enter in the field must not submit the form
    const typed = this.typed().trim();
    if (!typed) return;
    this.paths.set(addJoinPaths(this.paths(), [typed]));
    this.typed.set('');
  }

  protected move(index: number, delta: -1 | 1): void {
    this.paths.set(moveJoinPath(this.paths(), index, delta));
  }

  protected remove(index: number): void {
    this.paths.set(removeJoinPath(this.paths(), index));
  }

  protected onReencode(event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.agreedFor = on ? [...this.paths()] : null;
    this.reencode.set(on);
  }

  private emit(): void {
    this.checkChange.emit({ checking: this.checking(), check: this.check(), checkedPaths: this.checkedPaths() });
  }

  /** Check the list shortly after it stops changing; a newer list's check wins. */
  private schedule(paths: string[], quality: RenderQuality | undefined): void {
    clearTimeout(this.timer);
    const seq = ++this.seq;
    // An agreement to re-encode was for that list and its cost, not for another.
    if (this.reencode() && this.agreedFor && !samePaths(this.agreedFor, paths)) {
      this.agreedFor = null;
      this.reencode.set(false);
    }
    if (paths.length < 2) {
      this.checking.set(false);
      this.check.set(null);
      this.checkedPaths.set(null);
      this.error.set(null);
      this.emit();
      return;
    }
    this.checking.set(true);
    this.emit();
    this.timer = setTimeout(() => void this.run(seq, [...paths], quality), 400);
  }

  private async run(seq: number, paths: string[], quality: RenderQuality | undefined): Promise<void> {
    try {
      const check = await this.ipc.checkJoin(paths, quality);
      if (seq !== this.seq) return;
      this.check.set(check);
      this.checkedPaths.set(paths);
      this.error.set(null);
      // A list restored with its agreement (Back, a kept draft) keeps it.
      if (this.reencode() && !this.agreedFor) this.agreedFor = paths;
    } catch (err) {
      if (seq !== this.seq) return;
      this.check.set(null);
      this.checkedPaths.set(null);
      this.error.set(toAppError(err));
    } finally {
      if (seq === this.seq) {
        this.checking.set(false);
        this.emit();
      }
    }
  }
}
