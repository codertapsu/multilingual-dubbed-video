import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnDestroy, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { BrandAsset } from '@videodubber/shared';

import { IpcService } from '../../core/ipc/ipc.service';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { toAppError } from '../../core/state/project.store';
import type { AppError } from '../../core/models';
import { ConfirmService } from '../confirm-dialog/confirm.service';
import { ErrorBannerComponent } from '../error-banner/error-banner.component';

/**
 * Settings → Logo & greeting: the brand kit. Logos from a picture, greetings
 * from a sound file or said by one of the installed voices. A project keeps
 * its own copy of what it uses, so deleting here never changes a project.
 */
@Component({
  selector: 'vd-brand-kit',
  standalone: true,
  imports: [FormsModule, TranslatePipe, ErrorBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack-sm">
      <vd-error-banner [error]="error()" (dismiss)="error.set(null)" />

      <h3>{{ 'branding.kit-logos' | translate }}</h3>
      @if (logos().length === 0) {
        <p class="hint muted">{{ 'branding.kit-no-logos' | translate }}</p>
      }
      <ul class="assets">
        @for (a of logos(); track a.id) {
          <li class="asset">
            <img class="thumb" [src]="url(a.id)" alt="" />
            <span class="grow">{{ a.name }} <span class="muted">{{ a.width }}×{{ a.height }}</span></span>
            <button type="button" class="btn btn-ghost btn-sm" (click)="remove(a)">{{ 'branding.delete' | translate }}</button>
          </li>
        }
      </ul>
      <div class="row add">
        <input class="grow" type="text" [placeholder]="'branding.name-ph' | translate" [(ngModel)]="logoName" />
        <input class="grow" type="text" [placeholder]="'branding.path-ph' | translate" [(ngModel)]="logoPath" />
        <button type="button" class="btn btn-sm" (click)="browse('image')">{{ 'branding.browse' | translate }}</button>
        <button type="button" class="btn btn-sm btn-primary" (click)="addLogo()" [disabled]="busy() || !logoPath.trim()">
          {{ 'branding.add-logo' | translate }}
        </button>
      </div>
      <p class="hint muted">{{ 'branding.logo-file-hint' | translate }}</p>

      <h3>{{ 'branding.kit-greetings' | translate }}</h3>
      @if (greetings().length === 0) {
        <p class="hint muted">{{ 'branding.kit-no-greetings' | translate }}</p>
      }
      <ul class="assets">
        @for (a of greetings(); track a.id) {
          <li class="asset">
            <button type="button" class="btn btn-sm" (click)="play(a)">
              {{ (playingId() === a.id ? 'branding.stop' : 'branding.listen') | translate }}
            </button>
            <span class="grow">
              {{ a.name }} <span class="muted">{{ seconds(a.durationMs) }} s</span>
              @if (a.text) {
                <span class="muted"> · “{{ a.text }}”</span>
              }
            </span>
            <button type="button" class="btn btn-ghost btn-sm" (click)="remove(a)">{{ 'branding.delete' | translate }}</button>
          </li>
        }
      </ul>

      <div class="row add">
        <input class="grow" type="text" [placeholder]="'branding.name-ph' | translate" [(ngModel)]="greetingName" />
        <input class="grow" type="text" [placeholder]="'branding.path-ph' | translate" [(ngModel)]="greetingPath" />
        <button type="button" class="btn btn-sm" (click)="browse('audio')">{{ 'branding.browse' | translate }}</button>
        <button type="button" class="btn btn-sm btn-primary" (click)="addGreetingFile()" [disabled]="busy() || !greetingPath.trim()">
          {{ 'branding.add-greeting-file' | translate }}
        </button>
      </div>

      <div class="stack-xs spoken">
        <span class="label">{{ 'branding.spoken' | translate }}</span>
        <textarea rows="2" maxlength="300" [placeholder]="'branding.spoken-ph' | translate" [(ngModel)]="spokenText"></textarea>
        <div class="row add">
          <select class="grow" [attr.aria-label]="'branding.voice' | translate" [(ngModel)]="spokenVoice">
            <option value="">{{ 'branding.voice' | translate }}</option>
            @for (v of voices(); track v.id) {
              <option [value]="v.id">{{ v.name }} ({{ v.languages.join(', ') }})</option>
            }
          </select>
          <button
            type="button"
            class="btn btn-sm btn-primary"
            (click)="addSpoken()"
            [disabled]="busy() || !spokenText.trim() || !spokenVoice"
          >
            {{ (busy() ? 'branding.making' : 'branding.add-spoken') | translate }}
          </button>
        </div>
        <span class="hint muted">{{ 'branding.greeting-file-hint' | translate }}</span>
      </div>
    </div>
  `,
  styles: [
    `
      h3 {
        margin: var(--vd-sp-2) 0 0;
        font-size: 0.95rem;
      }
      .assets {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: var(--vd-sp-2);
      }
      .asset {
        display: flex;
        align-items: center;
        gap: var(--vd-sp-2);
      }
      .grow {
        flex: 1;
        min-width: 160px;
      }
      .add {
        flex-wrap: wrap;
        gap: var(--vd-sp-2);
      }
      .thumb {
        height: 36px;
        width: 72px;
        object-fit: contain;
        background: repeating-conic-gradient(#ddd 0% 25%, #fff 0% 50%) 50% / 12px 12px;
        border: 1px solid var(--vd-border);
        border-radius: var(--vd-radius-sm);
      }
      .hint {
        font-size: 0.8rem;
        margin: 0;
      }
      .stack-xs {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
    `,
  ],
})
export class BrandKitComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly confirm = inject(ConfirmService);

  protected readonly assets = signal<BrandAsset[]>([]);
  protected readonly logos = computed(() => this.assets().filter((a) => a.kind === 'logo'));
  protected readonly greetings = computed(() => this.assets().filter((a) => a.kind === 'greeting'));
  protected readonly voices = signal<{ id: string; name: string; languages: string[] }[]>([]);
  protected readonly busy = signal(false);
  protected readonly error = signal<AppError | null>(null);
  protected readonly playingId = signal<string | null>(null);
  protected logoName = '';
  protected logoPath = '';
  protected greetingName = '';
  protected greetingPath = '';
  protected spokenText = '';
  protected spokenVoice = '';
  private audio: HTMLAudioElement | null = null;

  ngOnInit(): void {
    void this.load();
    void this.ipc
      .voiceLibrary()
      .then((lib) => this.voices.set(lib.voices.filter((v) => v.installed).map((v) => ({ id: v.id, name: v.name, languages: v.languages }))))
      .catch(() => undefined);
  }

  ngOnDestroy(): void {
    this.audio?.pause();
  }

  private async load(): Promise<void> {
    try {
      this.assets.set(await this.ipc.listBrandKit());
    } catch (err) {
      this.error.set(toAppError(err));
    }
  }

  protected url(id: string): string {
    return this.ipc.brandAssetUrl(id);
  }

  protected seconds(ms?: number): string {
    return ((ms ?? 0) / 1000).toFixed(1);
  }

  protected async browse(kind: 'image' | 'audio'): Promise<void> {
    const title = this.translate.instant(kind === 'image' ? 'branding.pick-logo' : 'branding.pick-greeting');
    const picked = await this.ipc.pickMediaFile(kind, title);
    if (!picked) return;
    if (kind === 'image') this.logoPath = picked;
    else this.greetingPath = picked;
  }

  protected addLogo(): Promise<void> {
    return this.run(async () => {
      await this.ipc.addLogo(this.logoName.trim(), this.logoPath.trim());
      this.logoName = '';
      this.logoPath = '';
    });
  }

  protected addGreetingFile(): Promise<void> {
    return this.run(async () => {
      await this.ipc.addGreeting({ name: this.greetingName.trim(), path: this.greetingPath.trim() });
      this.greetingName = '';
      this.greetingPath = '';
    });
  }

  protected addSpoken(): Promise<void> {
    const voice = this.voices().find((v) => v.id === this.spokenVoice);
    return this.run(async () => {
      await this.ipc.addGreeting({
        name: this.greetingName.trim(),
        text: this.spokenText.trim(),
        voiceId: this.spokenVoice,
        ...(voice?.languages[0] ? { language: voice.languages[0] } : {}),
      });
      this.spokenText = '';
      this.greetingName = '';
    });
  }

  protected async remove(asset: BrandAsset): Promise<void> {
    const ok = await this.confirm.confirm({
      title: this.translate.instant('branding.delete-title', { name: asset.name }),
      message: this.translate.instant('branding.delete-body'),
      confirmLabel: this.translate.instant('branding.delete'),
    });
    if (ok) await this.run(() => this.ipc.deleteBrandAsset(asset.id));
  }

  protected play(asset: BrandAsset): void {
    if (this.playingId() === asset.id) {
      this.audio?.pause();
      this.playingId.set(null);
      return;
    }
    this.audio?.pause();
    this.audio = new Audio(this.url(asset.id));
    this.audio.onended = () => this.playingId.set(null);
    this.playingId.set(asset.id);
    void this.audio.play().catch(() => this.playingId.set(null));
  }

  private async run(fn: () => Promise<unknown>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await fn();
      await this.load();
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
