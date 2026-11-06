import type { ElementRef } from '@angular/core';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { TranslatePipe } from '../../../core/i18n';
import { formatTimecode } from '../../../core/util/format';
import { StudioStore, type LineVm } from './studio.store';
import { VOICE_DRAG_TYPE } from './timeline.component';

type Filter = 'all' | 'problems' | 'changed' | 'locked';

const ROW_H = 54;
const OVERSCAN = 6;

function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/**
 * The line list: search (diacritic-insensitive, so "chao" finds "chào"),
 * problem filters, and a virtualized list — only the visible rows exist in
 * the DOM, so a feature-length video with thousands of lines scrolls freely.
 */
@Component({
  selector: 'vd-lines-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe],
  template: `
    <div class="head">
      <input
        type="search"
        [placeholder]="'studio.search-ph' | translate"
        [value]="query()"
        (input)="query.set($any($event.target).value)"
        [attr.aria-label]="'studio.search' | translate"
      />
      <div class="seg-control filters" role="radiogroup">
        @for (f of filters; track f) {
          <button
            type="button"
            role="radio"
            [class.active]="filter() === f"
            [attr.aria-checked]="filter() === f"
            (click)="filter.set(f)"
          >
            {{ filterKeys[f] | translate }}
            @if (f === 'problems' && store.problemCount() > 0) {
              <span class="count">{{ store.problemCount() }}</span>
            }
            @if (f === 'changed' && store.staleCount() > 0) {
              <span class="count">{{ store.staleCount() }}</span>
            }
          </button>
        }
      </div>
    </div>
    <div
      class="list"
      #list
      (scroll)="scrollTop.set($any($event.target).scrollTop)"
      role="listbox"
      [attr.aria-label]="'studio.lines' | translate"
      aria-multiselectable="true"
    >
      <div class="spacer" [style.height.px]="filtered().length * rowH">
        @for (r of windowed(); track r.line.seg.id) {
          <div
            class="line-row"
            role="option"
            [attr.aria-selected]="store.selection().has(r.line.seg.id)"
            [class.sel]="store.selection().has(r.line.seg.id)"
            [class.primary]="store.primaryId() === r.line.seg.id"
            [class.drop]="dropId() === r.line.seg.id"
            [style.transform]="'translateY(' + r.top + 'px)'"
            (click)="
              pick.emit({
                id: r.line.seg.id,
                mode: $event.shiftKey
                  ? 'range'
                  : $event.metaKey || $event.ctrlKey
                    ? 'toggle'
                    : 'replace',
              })
            "
            (dragover)="onDragOver($event, r.line.seg.id)"
            (dragleave)="dropId.set(null)"
            (drop)="onDrop($event, r.line.seg.id)"
          >
            <div class="meta">
              <span class="n mono">{{ r.line.n }}</span>
              <span class="t mono">{{ fmt(r.line.seg.startMs) }}</span>
              <span class="icons">
                @if (r.line.status === 'timing-conflict') {
                  <i class="dot bad" [title]="'editor.timing-conflict' | translate"></i>
                } @else if (r.line.status === 'needs-review') {
                  <i class="dot warn" [title]="'editor.needs-review' | translate"></i>
                }
                @if (r.line.untranslated) {
                  <i class="dot bad" [title]="'editor.untranslated' | translate"></i>
                }
                @if (r.line.long || r.line.fast) {
                  <i class="dot warn" [title]="'studio.reading-speed' | translate"></i>
                }
                @if (r.line.stale) {
                  <i class="dot info" [title]="'studio.stale' | translate"></i>
                }
                @if (r.line.locked) {
                  <i class="lock" [title]="'studio.locked' | translate">●</i>
                }
              </span>
            </div>
            <div class="tr">{{ r.line.text || ('studio.empty-line' | translate) }}</div>
            <div class="src">{{ r.line.seg.sourceText }}</div>
          </div>
        }
      </div>
      @if (filtered().length === 0) {
        <p class="none hint">{{ 'studio.no-matches' | translate }}</p>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        min-height: 0;
        background: var(--vd-surface);
      }
      .head {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: var(--vd-sp-2);
        border-bottom: 1px solid var(--vd-border);
      }
      .head input {
        padding: 5px 8px;
        font-size: 0.85rem;
      }
      .filters {
        display: flex;
      }
      .filters button {
        flex: 1 1 auto;
        padding: 3px 4px;
        font-size: 0.72rem;
        white-space: nowrap;
      }
      .count {
        margin-left: 3px;
        padding: 0 5px;
        border-radius: 999px;
        background: var(--vd-surface-3);
        font-size: 0.66rem;
      }
      .list {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        position: relative;
      }
      .spacer {
        position: relative;
      }
      .line-row {
        position: absolute;
        left: 0;
        right: 0;
        height: 54px; /* = ROW_H */
        padding: 4px var(--vd-sp-2) 4px var(--vd-sp-3);
        border-bottom: 1px solid var(--vd-border);
        border-left: 3px solid transparent;
        cursor: pointer;
        overflow: hidden;
        will-change: transform;
      }
      .line-row:hover {
        background: var(--vd-surface-2);
      }
      .line-row.sel {
        background: var(--vd-primary-soft);
      }
      .line-row.primary {
        border-left-color: var(--vd-selection);
      }
      .line-row.drop {
        outline: 2px dashed var(--vd-snap);
        outline-offset: -2px;
      }
      .meta {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 0.68rem;
        color: var(--vd-text-subtle);
      }
      .icons {
        display: inline-flex;
        gap: 3px;
        margin-left: auto;
        align-items: center;
      }
      .dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
      }
      .dot.bad {
        background: var(--vd-danger);
      }
      .dot.warn {
        background: var(--vd-warning);
      }
      .dot.info {
        background: var(--vd-info);
      }
      .lock {
        font-style: normal;
        font-size: 0.6rem;
        color: var(--vd-text-subtle);
      }
      .tr,
      .src {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: 0.82rem;
        line-height: 1.35;
      }
      .src {
        color: var(--vd-text-muted);
        font-size: 0.74rem;
      }
      .none {
        padding: var(--vd-sp-4);
        text-align: center;
      }
    `,
  ],
})
export class LinesPanelComponent {
  protected readonly store = inject(StudioStore);
  private readonly list = viewChild.required<ElementRef<HTMLDivElement>>('list');

  /** A line was clicked; the shell selects it, seeks, and reveals it on the timeline. */
  readonly pick = output<{ id: string; mode: 'replace' | 'toggle' | 'range' }>();

  protected readonly rowH = ROW_H;
  protected readonly filters: readonly Filter[] = ['all', 'problems', 'changed', 'locked'];
  protected readonly filterKeys: Record<Filter, string> = {
    all: 'studio.filter-all',
    problems: 'studio.filter-problems',
    changed: 'studio.filter-changed',
    locked: 'studio.filter-locked',
  };
  protected readonly filter = signal<Filter>('all');
  protected readonly query = signal('');
  protected readonly scrollTop = signal(0);
  protected readonly viewport = signal(600);
  protected readonly dropId = signal<string | null>(null);
  protected readonly fmt = formatTimecode;

  protected readonly filtered = computed<LineVm[]>(() => {
    const f = this.filter();
    const q = fold(this.query().trim());
    return this.store.lines().filter((l) => {
      if (f === 'problems' && !l.problem) return false;
      if (f === 'changed' && !l.stale) return false;
      if (f === 'locked' && !l.locked) return false;
      return !q || fold(l.text).includes(q) || fold(l.seg.sourceText).includes(q);
    });
  });

  protected readonly windowed = computed(() => {
    const rows = this.filtered();
    const first = Math.max(0, Math.floor(this.scrollTop() / ROW_H) - OVERSCAN);
    const last = Math.min(
      rows.length,
      Math.ceil((this.scrollTop() + this.viewport()) / ROW_H) + OVERSCAN,
    );
    const out: { line: LineVm; top: number }[] = [];
    for (let i = first; i < last; i++) out.push({ line: rows[i]!, top: i * ROW_H });
    return out;
  });

  constructor() {
    // Keep the primary line in view as the selection moves (arrow keys, timeline clicks).
    effect(() => {
      const id = this.store.primaryId();
      if (!id) return;
      const i = this.filtered().findIndex((l) => l.seg.id === id);
      if (i < 0) return;
      const el = this.list().nativeElement;
      const top = i * ROW_H;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + ROW_H > el.scrollTop + el.clientHeight)
        el.scrollTop = top + ROW_H - el.clientHeight;
    });
  }

  ngAfterViewInit(): void {
    const el = this.list().nativeElement;
    this.viewport.set(el.clientHeight || 600);
    new ResizeObserver(() => this.viewport.set(el.clientHeight)).observe(el);
  }

  protected onDragOver(e: DragEvent, id: string): void {
    if (!e.dataTransfer?.types.includes(VOICE_DRAG_TYPE)) return;
    e.preventDefault();
    this.dropId.set(id);
  }

  protected onDrop(e: DragEvent, id: string): void {
    const voice = e.dataTransfer?.getData(VOICE_DRAG_TYPE);
    this.dropId.set(null);
    if (!voice) return;
    e.preventDefault();
    const sel = this.store.selection();
    this.store.setVoice(sel.has(id) && sel.size > 1 ? [...sel] : [id], voice);
  }
}
