import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { TranslatePipe } from '../../../core/i18n';
import { SettingsStore } from '../settings.store';

/**
 * Settings → Downloads: what video downloads do while a dub runs
 * (providers/download/downloadGate.ts — dubbing comes first). Signing in to a
 * site is on the Download screen, where it is used; this page links there.
 */
@Component({
  selector: 'vd-settings-downloads',
  standalone: true,
  imports: [FormsModule, RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../settings-shared.scss',
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--vd-sp-4);
    }
    h3 {
      margin: 0;
    }
  `,
  template: `
    <!-- Downloads while dubbing (providers/download/downloadGate.ts): dubbing comes first. -->
    <div class="card stack-sm">
      <div class="opt" id="downloads">
        <div class="opt-text">
          <label class="opt-title" for="downloads-while-dubbing">{{ 'settings.downloads.while-dubbing' | translate }}</label>
          <p class="hint">{{ 'settings.downloads.intro' | translate }}</p>
        </div>
        <div class="opt-control">
          <select
            id="downloads-while-dubbing"
            [ngModel]="store.downloadsChoice()"
            (ngModelChange)="store.setDownloadsChoice($event)"
            [disabled]="store.prefSaving()"
          >
            <option value="auto">{{ 'settings.downloads.opt-auto' | translate }}</option>
            <option value="pause-heavy">{{ 'settings.downloads.opt-pause-heavy' | translate }}</option>
            <option value="one-task">{{ 'settings.downloads.opt-one-task' | translate }}</option>
            <option value="no-limit">{{ 'settings.downloads.opt-no-limit' | translate }}</option>
          </select>
        </div>
      </div>
      <p class="hint">
        @switch (store.downloadsEffective()) {
          @case ('pause-heavy') {
            {{ 'settings.downloads.now-pause-heavy' | translate }}
          }
          @case ('one-task') {
            {{ 'settings.downloads.now-one-task' | translate }}
          }
          @case ('no-limit') {
            {{ 'settings.downloads.now-no-limit' | translate }}
          }
        }
      </p>
    </div>

    <div class="card stack-sm" id="download-logins">
      <h3>{{ 'settings.downloads.logins' | translate }}</h3>
      <p class="hint">{{ 'settings.downloads.login-hint' | translate }}</p>
      <div class="row-actions">
        <a routerLink="/download" class="btn btn-sm">{{ 'settings.downloads.open-download' | translate }}</a>
        <a routerLink="/settings/storage" fragment="downloaded-videos" class="btn btn-ghost btn-sm">{{ 'settings.downloads.space' | translate }}</a>
      </div>
    </div>
  `,
})
export class DownloadsSectionComponent {
  protected readonly store = inject(SettingsStore);
}
