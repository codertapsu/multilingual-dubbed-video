import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal, type OnDestroy } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import {
  DEFAULT_GREETING,
  DEFAULT_LOGO,
  type BrandAsset,
  type BrandingSettings,
  type GreetingSettings,
  type LogoCorner,
  type LogoSettings,
  type TimeSpan,
} from '@videodubber/shared';

import { IpcService } from '../../core/ipc/ipc.service';
import { TranslatePipe } from '../../core/i18n';

/** "1:05" or "1:02:03" → ms; NaN when it is not a time. Pure. */
export function parseClock(text: string): number {
  const parts = text.trim().split(':').map((p) => Number(p));
  if (parts.length === 0 || parts.length > 3 || parts.some((p) => !Number.isFinite(p) || p < 0)) return Number.NaN;
  return Math.round(parts.reduce((acc, p) => acc * 60 + p, 0) * 1000);
}

/** ms → "1:05" / "1:02:03". Pure. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** "0:00-0:10, 5:00-5:10" → spans (bad pieces left out). Pure. */
export function parsePeriods(text: string): TimeSpan[] {
  return text
    .split(/[,;\n]/)
    .map((piece) => piece.split(/[-–]/).map((t) => parseClock(t)))
    .filter((p): p is [number, number] => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1]! > p[0]!)
    .map(([startMs, endMs]) => ({ startMs, endMs }));
}

export function formatPeriods(spans: readonly TimeSpan[] | undefined): string {
  return (spans ?? []).map((p) => `${formatClock(p.startMs)}-${formatClock(p.endMs)}`).join(', ');
}

/**
 * A project's logo and spoken greeting (models/branding.ts), chosen from the
 * brand kit. Emits the whole branding value on every change (undefined = none).
 * New project, the editor and Export use it.
 */
@Component({
  selector: 'vd-branding-form',
  standalone: true,
  imports: [FormsModule, TranslatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="branding stack-sm">
      <div class="field">
        <label [for]="id + '-logo'">{{ 'branding.logo' | translate }}</label>
        <div class="row">
          <select class="grow" [id]="id + '-logo'" [ngModel]="logo()?.assetId ?? ''" (ngModelChange)="setLogo($event)" [disabled]="disabled()">
            <option value="">{{ 'branding.logo-none' | translate }}</option>
            @for (a of logos(); track a.id) {
              <option [value]="a.id">{{ a.name }}</option>
            }
          </select>
          @if (logo(); as l) {
            <img class="thumb" [src]="url(l.assetId)" alt="" />
          }
        </div>
        @if (logos().length === 0) {
          <span class="hint muted">{{ 'branding.kit-empty-logo' | translate }}</span>
        }
      </div>

      @if (logo(); as l) {
        <div class="grid">
          <label class="stack-xs">
            <span class="label">{{ 'branding.corner' | translate }}</span>
            <select [ngModel]="l.corner" (ngModelChange)="patchLogo({ corner: $event })" [disabled]="disabled()">
              <option value="top-right">{{ 'branding.corner-top-right' | translate }}</option>
              <option value="top-left">{{ 'branding.corner-top-left' | translate }}</option>
              <option value="bottom-right">{{ 'branding.corner-bottom-right' | translate }}</option>
              <option value="bottom-left">{{ 'branding.corner-bottom-left' | translate }}</option>
            </select>
          </label>
          <label class="stack-xs">
            <span class="label">{{ 'branding.size' | translate }}</span>
            <input type="number" min="2" max="50" [ngModel]="l.widthPct" (ngModelChange)="patchLogo({ widthPct: +$event })" [disabled]="disabled()" />
          </label>
          <label class="stack-xs">
            <span class="label">{{ 'branding.opacity' | translate }}</span>
            <input type="number" min="5" max="100" [ngModel]="pct(l.opacity)" (ngModelChange)="patchLogo({ opacity: +$event / 100 })" [disabled]="disabled()" />
          </label>
          <label class="stack-xs">
            <span class="label">{{ 'branding.show' | translate }}</span>
            <select [ngModel]="l.show" (ngModelChange)="patchLogo({ show: $event })" [disabled]="disabled()">
              <option value="always">{{ 'branding.show-always' | translate }}</option>
              <option value="periods">{{ 'branding.show-periods' | translate }}</option>
              <option value="interval">{{ 'branding.show-interval' | translate }}</option>
            </select>
          </label>
        </div>
        @if (l.show === 'periods') {
          <label class="stack-xs">
            <span class="label">{{ 'branding.periods' | translate }}</span>
            <input type="text" [ngModel]="periodsText()" (ngModelChange)="periodsText.set($event)" (blur)="commitPeriods()" [placeholder]="'0:00-0:10, 5:00-5:10'" [disabled]="disabled()" />
            <span class="hint muted">{{ 'branding.periods-hint' | translate }}</span>
          </label>
        }
        @if (l.show === 'interval') {
          <div class="grid">
            <label class="stack-xs">
              <span class="label">{{ 'branding.show-sec' | translate }}</span>
              <input type="number" min="1" max="600" [ngModel]="l.showSec ?? 10" (ngModelChange)="patchLogo({ showSec: +$event })" [disabled]="disabled()" />
            </label>
            <label class="stack-xs">
              <span class="label">{{ 'branding.every-min' | translate }}</span>
              <input type="number" min="1" max="120" [ngModel]="l.everyMin ?? 5" (ngModelChange)="patchLogo({ everyMin: +$event })" [disabled]="disabled()" />
            </label>
          </div>
        }
        <span class="hint muted">{{ 'branding.logo-hint' | translate }}</span>
        @if (l.corner === 'bottom-left' || l.corner === 'bottom-right') {
          <span class="hint warn-text">{{ 'branding.logo-bottom-warning' | translate }}</span>
        }
      }

      <div class="field">
        <label [for]="id + '-greeting'">{{ 'branding.greeting' | translate }}</label>
        <div class="row">
          <select class="grow" [id]="id + '-greeting'" [ngModel]="greeting()?.assetId ?? ''" (ngModelChange)="setGreeting($event)" [disabled]="disabled()">
            <option value="">{{ 'branding.greeting-none' | translate }}</option>
            @for (a of greetings(); track a.id) {
              <option [value]="a.id">{{ a.name }}</option>
            }
          </select>
          @if (greeting(); as g) {
            <button type="button" class="btn btn-sm" (click)="play(g.assetId)">
              {{ (playing() ? 'branding.stop' : 'branding.listen') | translate }}
            </button>
          }
        </div>
        @if (greetings().length === 0) {
          <span class="hint muted">{{ 'branding.kit-empty-greeting' | translate }}</span>
        }
      </div>

      @if (greeting(); as g) {
        <label class="check">
          <input type="checkbox" [ngModel]="g.atStart" (ngModelChange)="patchGreeting({ atStart: $event })" [disabled]="disabled()" />
          <span>{{ 'branding.at-start' | translate: { sec: g.startWindowSec } }}</span>
        </label>
        <div class="grid">
          <label class="stack-xs">
            <span class="label">{{ 'branding.repeat' | translate }}</span>
            <select [ngModel]="repeatValue(g)" (ngModelChange)="setRepeat($event)" [disabled]="disabled()">
              <option value="off">{{ 'branding.repeat-off' | translate }}</option>
              <option value="auto">{{ 'branding.repeat-auto' | translate }}</option>
              @for (n of counts; track n) {
                <option [value]="'' + n">{{ 'branding.repeat-n' | translate: { n: n } }}</option>
              }
            </select>
          </label>
          <label class="stack-xs">
            <span class="label">{{ 'branding.window' | translate }}</span>
            <input type="number" min="5" max="600" [ngModel]="g.startWindowSec" (ngModelChange)="patchGreeting({ startWindowSec: +$event })" [disabled]="disabled()" />
          </label>
          <label class="stack-xs">
            <span class="label">{{ 'branding.gain' | translate }}</span>
            <input type="number" min="-20" max="20" step="1" [ngModel]="g.gainDb" (ngModelChange)="patchGreeting({ gainDb: +$event })" [disabled]="disabled()" />
          </label>
        </div>
        <span class="hint muted">{{ 'branding.greeting-hint' | translate }}</span>
      }

      <a class="hint" routerLink="/settings" fragment="brand-kit">{{ 'branding.manage' | translate }}</a>
    </div>
  `,
  styles: [
    `
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
        gap: var(--vd-sp-2);
      }
      .thumb {
        height: 32px;
        max-width: 120px;
        object-fit: contain;
        background: repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 50% / 12px 12px;
        border: 1px solid var(--vd-border);
        border-radius: var(--vd-radius-sm);
      }
      .check {
        display: flex;
        align-items: center;
        gap: var(--vd-sp-2);
      }
      .stack-xs {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .hint {
        font-size: 0.8rem;
      }
    `,
  ],
})
export class BrandingFormComponent implements OnDestroy {
  private readonly ipc = inject(IpcService);

  readonly value = input<BrandingSettings | undefined>(undefined);
  readonly assets = input<BrandAsset[]>([]);
  readonly disabled = input(false);
  readonly changed = output<BrandingSettings | undefined>();

  /** Unique ids for the labels when the form appears twice on a page. */
  protected readonly id = `brand-${Math.random().toString(36).slice(2, 8)}`;
  protected readonly counts = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  protected readonly logos = computed(() => this.assets().filter((a) => a.kind === 'logo'));
  protected readonly greetings = computed(() => this.assets().filter((a) => a.kind === 'greeting'));
  protected readonly logo = computed(() => this.value()?.logo);
  protected readonly greeting = computed(() => this.value()?.greeting);
  protected readonly periodsText = signal('');
  protected readonly playing = signal(false);
  private audio: HTMLAudioElement | null = null;

  constructor() {
    // The periods field follows the value, except while the user types in it.
    effect(() => this.periodsText.set(formatPeriods(this.logo()?.periods)));
  }

  ngOnDestroy(): void {
    this.audio?.pause();
  }

  protected url(id: string): string {
    return this.ipc.brandAssetUrl(id);
  }

  protected pct(opacity: number): number {
    return Math.round(opacity * 100);
  }

  protected repeatValue(g: GreetingSettings): string {
    return typeof g.repeat === 'number' ? String(g.repeat) : g.repeat;
  }

  protected setLogo(assetId: string): void {
    const current = this.value();
    this.emit({ ...current, logo: assetId ? { ...DEFAULT_LOGO, ...(current?.logo ?? {}), assetId } : undefined });
  }

  protected patchLogo(patch: Partial<LogoSettings>): void {
    const logo = this.logo();
    if (!logo) return;
    const next: LogoSettings = { ...logo, ...patch };
    if (patch.corner) next.corner = patch.corner as LogoCorner;
    this.emit({ ...this.value(), logo: next });
  }

  protected commitPeriods(): void {
    this.patchLogo({ periods: parsePeriods(this.periodsText()) });
  }

  protected setGreeting(assetId: string): void {
    const current = this.value();
    this.emit({ ...current, greeting: assetId ? { ...DEFAULT_GREETING, ...(current?.greeting ?? {}), assetId } : undefined });
  }

  protected patchGreeting(patch: Partial<GreetingSettings>): void {
    const greeting = this.greeting();
    if (!greeting) return;
    this.emit({ ...this.value(), greeting: { ...greeting, ...patch } });
  }

  protected setRepeat(value: string): void {
    this.patchGreeting({ repeat: value === 'off' || value === 'auto' ? value : Number(value) });
  }

  protected play(assetId: string): void {
    if (this.playing()) {
      this.audio?.pause();
      this.playing.set(false);
      return;
    }
    this.audio = new Audio(this.url(assetId));
    this.audio.onended = () => this.playing.set(false);
    this.playing.set(true);
    void this.audio.play().catch(() => this.playing.set(false));
  }

  private emit(next: BrandingSettings | undefined): void {
    const clean: BrandingSettings = {};
    if (next?.logo) clean.logo = next.logo;
    if (next?.greeting) clean.greeting = next.greeting;
    this.changed.emit(clean.logo || clean.greeting ? clean : undefined);
  }
}
