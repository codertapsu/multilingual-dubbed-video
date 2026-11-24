import { ChangeDetectionStrategy, Component, computed, input, output, signal, viewChild, type ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PictureFrame, SubtitleStyle } from '@videodubber/shared';

import { TranslatePipe } from '../../core/i18n';
import { formatClock } from '../branding/branding-form.component';
import {
  coverModeOf,
  defaultBand,
  dragBandEdge,
  keyDelta,
  moveBand,
  moveBox,
  newBox,
  percent,
  resizeBox,
  shownBand,
  withCoverMode,
  type Band,
  type Box,
  type EditorRegion,
} from './picture-geometry';

type DragKind = 'box' | 'box-resize' | 'band' | 'band-top' | 'band-bottom';

interface Drag {
  kind: DragKind;
  index: number;
  x0: number;
  y0: number;
  width: number;
  height: number;
  origin: Box | Band;
  current: Box | Band;
}

/**
 * A frame of the video with the boxes to hide (red) and the band over the
 * source's own subtitles (yellow) drawn on it: drag to move, the corner or
 * the band's edges to resize, arrows on a focused box (Alt+arrows resize,
 * Delete removes). Below it, each box's way of hiding and strength, and the
 * band's. Presentational: it emits every change and the host keeps the draft
 * (the editor's picture panel, New project's More options).
 */
@Component({
  selector: 'vd-picture-editor',
  standalone: true,
  imports: [FormsModule, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="picture-editor stack-sm">
      @if (frame(); as f) {
        <div class="frame-wrap">
          <div
            #frameEl
            class="frame"
            (pointermove)="onMove($event)"
            (pointerup)="onUp()"
            (pointercancel)="onUp()"
          >
            <img [src]="f.image" [attr.width]="f.width" [attr.height]="f.height" [alt]="'picture.frame-alt' | translate" draggable="false" />
            @if (band(); as b) {
              <div
                class="band"
                [class.solid]="mode() === 'solid'"
                [class.placed]="!!style()?.coverBand"
                [style.top.%]="b.y * 100"
                [style.height.%]="b.h * 100"
                tabindex="0"
                role="group"
                [attr.aria-label]="'picture.band-aria' | translate: { from: pct(b.y), to: pct(b.y + b.h) }"
                (pointerdown)="startBand($event, 'band')"
                (keydown)="onBandKey($event)"
              >
                <span class="edge top" (pointerdown)="startBand($event, 'band-top')"></span>
                <span class="tag">{{ 'picture.band-tag' | translate }}</span>
                <span class="edge bottom" (pointerdown)="startBand($event, 'band-bottom')"></span>
              </div>
            }
            @for (r of shownRegions(); track $index) {
              <div
                class="box"
                [class.selected]="selected() === $index"
                [style.left.%]="r.x * 100"
                [style.top.%]="r.y * 100"
                [style.width.%]="r.w * 100"
                [style.height.%]="r.h * 100"
                tabindex="0"
                [attr.aria-label]="'picture.box-aria' | translate: { n: $index + 1 }"
                (pointerdown)="startBox($event, $index, 'box')"
                (focus)="selected.set($index)"
                (keydown)="onBoxKey($event, $index)"
              >
                <span class="tag">{{ $index + 1 }}</span>
                <span class="handle" (pointerdown)="startBox($event, $index, 'box-resize')"></span>
              </div>
            }
          </div>
        </div>
        <p class="hint muted">{{ 'picture.frame-hint' | translate }}</p>
      }

      <div class="part stack-sm">
        <h4>{{ 'picture.boxes' | translate }}</h4>
        <p class="hint muted">{{ 'picture.boxes-hint' | translate }}</p>
        @for (r of regions(); track $index) {
          <div class="box-row" [class.selected]="selected() === $index" (click)="selected.set($index)">
            <span class="name">{{ 'picture.box-n' | translate: { n: $index + 1 } }}</span>
            @if (r.confidence !== undefined) {
              <span class="badge" [class.badge-warning]="r.confidence < 0.5" [title]="'picture.confidence-hint' | translate">
                {{ 'picture.confidence' | translate: { n: pct(r.confidence) } }}
              </span>
            }
            <select
              [ngModel]="r.mode"
              [ngModelOptions]="standalone"
              (ngModelChange)="setMode($index, $event)"
              [disabled]="disabled()"
              [attr.aria-label]="'picture.mode' | translate"
            >
              <option value="blur">{{ 'picture.mode-blur' | translate }}</option>
              <option value="pixelate">{{ 'picture.mode-pixelate' | translate }}</option>
              <option value="delogo">{{ 'picture.mode-delogo' | translate }}</option>
            </select>
            @if (r.mode !== 'delogo') {
              <label class="strength">
                <span>{{ 'picture.strength' | translate }}</span>
                <input
                  type="range"
                  min="1"
                  max="10"
                  step="1"
                  [ngModel]="r.strength ?? 5"
                  [ngModelOptions]="standalone"
                  (ngModelChange)="setStrength($index, $event)"
                  [disabled]="disabled()"
                />
                <span class="mono">{{ r.strength ?? 5 }}</span>
              </label>
            }
            <span class="muted small when">{{ whenOf(r) }}</span>
            <button type="button" class="btn btn-ghost btn-sm" (click)="remove($index)" [disabled]="disabled()">
              {{ 'picture.remove-box' | translate }}
            </button>
          </div>
        }
        <p class="hint muted">{{ 'picture.modes-hint' | translate }}</p>
        <div class="row">
          <button type="button" class="btn btn-sm" (click)="add()" [disabled]="disabled() || !frame()">{{ 'picture.add-box' | translate }}</button>
          <span class="hint muted">{{ 'picture.add-box-hint' | translate }}</span>
        </div>
      </div>

      <div class="part stack-sm">
        <h4>{{ 'picture.band' | translate }}</h4>
        <label class="field">
          <span>{{ 'picture.band-mode' | translate }}</span>
          <select [ngModel]="mode()" [ngModelOptions]="standalone" (ngModelChange)="setCoverMode($event)" [disabled]="disabled()">
            <option value="off">{{ 'picture.band-off' | translate }}</option>
            <option value="blur">{{ 'picture.band-blur' | translate }}</option>
            <option value="solid">{{ 'picture.band-solid' | translate }}</option>
          </select>
        </label>
        <p class="hint muted">{{ 'picture.band-hint' | translate }}</p>
        @if (mode() === 'solid' && !burnedIn()) {
          <p class="hint warn-text">{{ 'picture.band-solid-needs-burn' | translate }}</p>
        }
        @if (mode() !== 'off') {
          <div class="row">
            <span>{{ 'picture.band-where' | translate }}</span>
            @if (style()?.coverBand; as b) {
              <span class="mono">{{ 'picture.band-at' | translate: { from: pct(b.y), to: pct(b.y + b.h) } }}</span>
              <button type="button" class="btn btn-ghost btn-sm" (click)="resetBand()" [disabled]="disabled()">{{ 'picture.band-reset' | translate }}</button>
            } @else {
              <span>{{ 'picture.band-bottom' | translate }}</span>
              <button type="button" class="btn btn-ghost btn-sm" (click)="placeBand()" [disabled]="disabled()">{{ 'picture.band-place' | translate }}</button>
            }
          </div>
          @if (mode() === 'blur') {
            <label class="strength">
              <span>{{ 'picture.strength' | translate }}</span>
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                [ngModel]="style()?.coverStrength ?? 5"
                [ngModelOptions]="standalone"
                (ngModelChange)="setBandStrength($event)"
                [disabled]="disabled()"
              />
              <span class="mono">{{ style()?.coverStrength ?? 5 }}</span>
            </label>
            <p class="hint muted">{{ 'picture.band-strength-hint' | translate }}</p>
          }
          <label class="check-row">
            <input
              type="checkbox"
              [ngModel]="style()?.subtitlesInBand === true"
              [ngModelOptions]="standalone"
              (ngModelChange)="setInBand($event)"
              [disabled]="disabled() || !burnedIn()"
            />
            <span>{{ 'picture.in-band' | translate }}</span>
          </label>
          <p class="hint muted">{{ (burnedIn() ? 'picture.in-band-hint' : 'picture.in-band-needs-burn') | translate }}</p>
        }
      </div>
    </div>
  `,
  styles: [
    `
      h4 {
        margin: 0;
        font-size: 0.85rem;
      }
      .hint {
        font-size: 0.8rem;
        margin: 0;
      }
      .frame-wrap {
        display: flex;
        justify-content: center;
      }
      .frame {
        position: relative;
        display: inline-block;
        touch-action: none;
        user-select: none;
        line-height: 0;
      }
      .frame img {
        display: block;
        max-width: 100%;
        max-height: 420px;
        width: auto;
        height: auto;
        border-radius: 4px;
      }
      .box,
      .band {
        position: absolute;
        box-sizing: border-box;
        cursor: move;
        touch-action: none;
      }
      .box {
        border: 2px solid rgba(239, 68, 68, 0.95);
        background: rgba(239, 68, 68, 0.15);
      }
      .box.selected,
      .box:focus-visible {
        outline: 2px solid #fff;
        outline-offset: 1px;
      }
      .band {
        left: 0;
        right: 0;
        border: 2px dashed rgba(250, 204, 21, 0.95);
        background: rgba(250, 204, 21, 0.12);
      }
      .band.placed {
        border-style: solid;
      }
      .band.solid {
        background: rgba(0, 0, 0, 0.55);
      }
      .band:focus-visible {
        outline: 2px solid #fff;
      }
      .tag {
        position: absolute;
        left: 2px;
        top: 2px;
        font-size: 11px;
        line-height: 14px;
        padding: 0 3px;
        border-radius: 3px;
        color: #111;
        background: rgba(255, 255, 255, 0.85);
        pointer-events: none;
        white-space: nowrap;
      }
      .handle {
        position: absolute;
        right: -6px;
        bottom: -6px;
        width: 12px;
        height: 12px;
        background: #fff;
        border: 2px solid rgba(239, 68, 68, 0.95);
        border-radius: 2px;
        cursor: nwse-resize;
      }
      .edge {
        position: absolute;
        left: 0;
        right: 0;
        height: 8px;
        cursor: ns-resize;
      }
      .edge.top {
        top: -5px;
      }
      .edge.bottom {
        bottom: -5px;
      }
      .box-row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--vd-sp-2);
        padding: 2px 4px;
        border-radius: 4px;
      }
      .box-row.selected {
        background: var(--vd-surface-2, rgba(127, 127, 127, 0.12));
      }
      .box-row select {
        width: auto;
      }
      .name {
        min-width: 44px;
        font-weight: 600;
        font-size: 0.85rem;
      }
      .strength {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        font-size: 0.85rem;
      }
      .strength input {
        width: 110px;
      }
      .when {
        flex: 1 1 auto;
      }
      .row {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--vd-sp-2);
      }
    `,
  ],
})
export class PictureEditorComponent {
  /** The frame to draw on (a data: URL); without one only the lists show. */
  readonly frame = input<PictureFrame | null>(null);
  readonly regions = input<readonly EditorRegion[]>([]);
  /** The project's burned-in subtitle style: the band lives there (coverOriginal, coverBand, …). */
  readonly style = input<SubtitleStyle | undefined>(undefined);
  /** Subtitles are burned into the video (the solid band and "inside the band" need it). */
  readonly burnedIn = input(false);
  readonly disabled = input(false);
  readonly regionsChange = output<EditorRegion[]>();
  readonly styleChange = output<SubtitleStyle>();

  /** The controls here are this editor's, not fields of a form around it (New project's). */
  protected readonly standalone = { standalone: true };
  private readonly frameEl = viewChild<ElementRef<HTMLElement>>('frameEl');
  private readonly drag = signal<Drag | null>(null);
  protected readonly selected = signal(-1);

  protected readonly mode = computed(() => coverModeOf(this.style()));

  /** The regions as drawn: the one being dragged where the pointer has it. */
  protected readonly shownRegions = computed<Box[]>(() => {
    const d = this.drag();
    return this.regions().map((r, i) => (d && (d.kind === 'box' || d.kind === 'box-resize') && d.index === i ? (d.current as Box) : r));
  });

  /** The band as drawn (while dragged, where the pointer has it). */
  protected readonly band = computed<Band | undefined>(() => {
    const d = this.drag();
    if (d && d.kind.startsWith('band')) return d.current as Band;
    return shownBand(this.style());
  });

  protected pct(n: number): number {
    return percent(n);
  }

  protected whenOf(r: EditorRegion): string {
    const range = r.startMs !== undefined || r.endMs !== undefined ? `${formatClock(r.startMs ?? 0)}–${r.endMs !== undefined ? formatClock(r.endMs) : '…'}` : '';
    return [range, r.fileName ?? ''].filter(Boolean).join(' · ');
  }

  // ------------------------------------------------------------- dragging

  protected startBox(ev: PointerEvent, index: number, kind: 'box' | 'box-resize'): void {
    const r = this.regions()[index];
    if (!r) return;
    this.selected.set(index);
    this.start(ev, kind, index, { x: r.x, y: r.y, w: r.w, h: r.h });
  }

  protected startBand(ev: PointerEvent, kind: 'band' | 'band-top' | 'band-bottom'): void {
    const b = this.band();
    if (b) this.start(ev, kind, -1, b);
  }

  private start(ev: PointerEvent, kind: DragKind, index: number, origin: Box | Band): void {
    if (this.disabled() || ev.button !== 0) return;
    const rect = this.frameEl()?.nativeElement.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    this.drag.set({ kind, index, x0: ev.clientX, y0: ev.clientY, width: rect.width, height: rect.height, origin, current: origin });
    try {
      // Keeps the moves coming when the pointer leaves the box; a pointer
      // that is already gone (a pen lifted, a synthetic event) refuses it.
      (ev.currentTarget as Element | null)?.setPointerCapture?.(ev.pointerId);
    } catch {
      /* the frame still gets the moves while the pointer is over it */
    }
  }

  protected onMove(ev: PointerEvent): void {
    const d = this.drag();
    if (!d) return;
    const dx = (ev.clientX - d.x0) / d.width;
    const dy = (ev.clientY - d.y0) / d.height;
    this.drag.set({ ...d, current: this.moved(d.kind, d.origin, dx, dy) });
  }

  protected onUp(): void {
    const d = this.drag();
    if (!d) return;
    this.drag.set(null);
    if (d.current === d.origin) return;
    if (d.kind === 'box' || d.kind === 'box-resize') this.replaceBox(d.index, d.current as Box);
    else this.emitStyle({ coverBand: d.current as Band });
  }

  private moved(kind: DragKind, origin: Box | Band, dx: number, dy: number): Box | Band {
    switch (kind) {
      case 'box':
        return moveBox(origin as Box, dx, dy);
      case 'box-resize':
        return resizeBox(origin as Box, dx, dy);
      case 'band':
        return moveBand(origin as Band, dy);
      case 'band-top':
        return dragBandEdge(origin as Band, 'top', dy);
      case 'band-bottom':
        return dragBandEdge(origin as Band, 'bottom', dy);
    }
  }

  protected onBoxKey(ev: KeyboardEvent, index: number): void {
    if (this.disabled()) return;
    const r = this.regions()[index];
    if (!r) return;
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      this.remove(index);
      return;
    }
    const delta = keyDelta(ev.key, ev.shiftKey);
    if (!delta) return;
    ev.preventDefault();
    this.replaceBox(index, ev.altKey ? resizeBox(r, delta.dx, delta.dy) : moveBox(r, delta.dx, delta.dy));
  }

  protected onBandKey(ev: KeyboardEvent): void {
    const b = this.band();
    const delta = keyDelta(ev.key, ev.shiftKey);
    if (this.disabled() || !b || !delta || delta.dy === 0) return;
    ev.preventDefault();
    this.emitStyle({ coverBand: ev.altKey ? dragBandEdge(b, 'bottom', delta.dy) : moveBand(b, delta.dy) });
  }

  // ------------------------------------------------------------- the lists

  private replaceBox(index: number, box: Box): void {
    this.regionsChange.emit(this.regions().map((r, i) => (i === index ? { ...r, ...box } : r)));
  }

  protected setMode(index: number, mode: EditorRegion['mode']): void {
    this.regionsChange.emit(this.regions().map((r, i) => (i === index ? { ...r, mode } : r)));
  }

  protected setStrength(index: number, value: unknown): void {
    const strength = Math.round(Math.min(10, Math.max(1, Number(value) || 5)));
    this.regionsChange.emit(this.regions().map((r, i) => (i === index ? { ...r, strength } : r)));
  }

  protected remove(index: number): void {
    this.selected.set(-1);
    this.regionsChange.emit(this.regions().filter((_, i) => i !== index));
  }

  protected add(): void {
    this.selected.set(this.regions().length);
    this.regionsChange.emit([...this.regions(), newBox()]);
  }

  private emitStyle(patch: Partial<SubtitleStyle>): void {
    this.styleChange.emit({ ...this.style(), ...patch });
  }

  protected setCoverMode(mode: 'off' | 'solid' | 'blur'): void {
    this.styleChange.emit(withCoverMode(this.style(), mode));
  }

  protected setBandStrength(value: unknown): void {
    this.emitStyle({ coverStrength: Math.round(Math.min(10, Math.max(1, Number(value) || 5))) });
  }

  protected setInBand(on: boolean): void {
    this.emitStyle({ subtitlesInBand: on });
  }

  protected placeBand(): void {
    this.emitStyle({ coverBand: defaultBand() });
  }

  protected resetBand(): void {
    const { coverBand: _drop, ...rest } = { ...this.style() };
    this.styleChange.emit(rest);
  }
}
