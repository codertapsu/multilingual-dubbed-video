import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ActivityService } from '../../../core/activity/activity.service';
import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { IpcService } from '../../../core/ipc/ipc.service';
import type { AppError } from '../../../core/models';
import type { ArgosPair } from '../../../core/models/setup';
import { toAppError } from '../../../core/state/project.store';
import { BusyIndicatorComponent } from '../../../shared/busy-indicator/busy-indicator.component';
import { ConfirmService } from '../../../shared/confirm-dialog/confirm.service';
import { ErrorBannerComponent } from '../../../shared/error-banner/error-banner.component';
import { argosPackRows, argosPairKey, type ArgosPackRow } from '../argos-rows';
import { argosItem, downloadState, type DownloadState } from '../install-state';
import { SettingsStore } from '../settings.store';

/**
 * The Argos Translate language packs: the installed pairs, the full index on
 * demand, install and remove. The old page's "Translation packs" card, moved
 * onto the Argos card of Settings → Translation.
 *
 * Installs go through the setup installer, like the speech models, and are
 * followed by the app-wide activity service. They were one request held open
 * for the whole download, with a busy flag that lived and died with this
 * card: leaving the page and coming back showed "Install" again while the pack
 * was still downloading, and nothing in the top bar said so.
 */
@Component({
  selector: 'vd-argos-packs',
  standalone: true,
  imports: [FormsModule, TranslatePipe, BusyIndicatorComponent, ErrorBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: '../settings-shared.scss',
  styles: `
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--vd-sp-2);
    }
    .filter {
      flex: 1 1 auto;
      min-width: 0;
      max-width: 22rem;
    }
    .pairs {
      list-style: none;
      margin: 0;
      padding: 0;
    }
    .pair {
      display: flex;
      flex-direction: column;
      gap: var(--vd-sp-2);
      padding: var(--vd-sp-2) 0;
      border-top: 1px solid var(--vd-border);
    }
    .pair-line {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--vd-sp-2);
    }
    .pair-name {
      font-weight: 600;
    }
  `,
  template: `
    <div class="stack-sm">
      <div class="toolbar">
        <button type="button" class="btn btn-sm" (click)="loadArgosPackages(true)" [disabled]="argosRefreshing()">
          {{ (argosRefreshing() ? 'settings.argos.loading-index' : 'settings.argos.browse') | translate }}
        </button>
        @if (argosRows().length > 8 || argosFilter()) {
          <input
            type="search"
            class="filter"
            [placeholder]="'settings.argos.filter' | translate"
            [ngModel]="argosFilter()"
            (ngModelChange)="argosFilter.set($event)"
            [attr.aria-label]="'settings.argos.filter-aria' | translate"
          />
        }
      </div>

      @if (argosRows().length === 0) {
        @if (argosRefreshing()) {
          <p class="hint">{{ 'settings.argos.loading' | translate }}</p>
        } @else {
          <p class="hint">{{ 'settings.argos.empty' | translate }}</p>
        }
      }

      <ul class="pairs">
        @for (row of argosRows(); track row.key) {
          @let st = stateOf(row);
          <li class="pair">
            <div class="pair-line">
              <span class="card-head">
                <span class="pair-name">{{ row.fromName }} → {{ row.toName }}</span>
                <span class="chip mono">{{ row.from }}→{{ row.to }}</span>
                @if (st.kind === 'ready') {
                  <span class="badge badge-completed">{{ 'settings.argos.installed' | translate }}</span>
                }
              </span>
              <span class="row-actions">
                @if (st.kind === 'ready') {
                  <button type="button" class="btn btn-ghost btn-sm" (click)="removeArgosPair(row)" [disabled]="removing() !== null">
                    {{ (removing() === row.key ? 'settings.argos.removing' : 'settings.argos.remove') | translate }}
                  </button>
                } @else if (st.kind === 'downloading') {
                  <button type="button" class="btn btn-sm" disabled>{{ 'settings.argos.installing' | translate }}</button>
                  <vd-busy-indicator [active]="true" [label]="'settings.argos.downloading' | translate" />
                } @else {
                  <button type="button" class="btn btn-sm" [class.btn-primary]="st.kind === 'failed'" (click)="installArgosPair(row)">
                    {{ (st.kind === 'failed' ? 'settings.engines.retry' : 'settings.argos.install') | translate }}
                  </button>
                }
              </span>
            </div>
            @if (st.kind === 'failed') {
              <vd-error-banner [error]="st.error" (dismiss)="dismissFailure(row)" />
            }
            @if (removeError(); as failed) {
              @if (failed.key === row.key) {
                <vd-error-banner [error]="failed.error" (dismiss)="removeError.set(null)" />
              }
            }
          </li>
        }
      </ul>
    </div>
  `,
})
export class ArgosPacksComponent implements OnInit {
  private readonly store = inject(SettingsStore);
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly confirmSvc = inject(ConfirmService);
  private readonly activity = inject(ActivityService);

  protected readonly argosInstalled = signal<ArgosPair[]>([]);
  protected readonly argosAvailable = signal<ArgosPair[]>([]);
  protected readonly argosRefreshing = signal(false);
  protected readonly argosFilter = signal('');
  /** "from->to" of the pair being removed (removing is quick, and this page's own). */
  protected readonly removing = signal<string | null>(null);
  /** A remove that failed, shown under its row (the page's banner is far above this card). */
  protected readonly removeError = signal<{ key: string; error: AppError } | null>(null);

  /** Language names in the app's language: they were always English. */
  private readonly displayNames = computed(() => {
    try {
      return new Intl.DisplayNames([this.translate.locale()], { type: 'language' });
    } catch {
      return null;
    }
  });

  /** Installed ∪ available pairs as rows (argos-rows.ts), filtered by the search box. */
  protected readonly argosRows = computed<ArgosPackRow[]>(() =>
    argosPackRows(this.argosInstalled(), this.argosAvailable(), {
      filter: this.argosFilter(),
      nameOf: (code) => this.langName(code),
      locale: this.translate.locale(),
    }),
  );

  constructor() {
    // A download run ended (a pack from here, or one a project asked for):
    // what is installed may have changed, and with it what Argos can translate.
    let seen = this.activity.setupChanges();
    effect(() => {
      const n = this.activity.setupChanges();
      if (n === seen) return;
      seen = n;
      untracked(() => {
        void this.loadArgosPackages(false);
        void this.store.loadProcessingSetup();
      });
    });
  }

  ngOnInit(): void {
    void this.loadArgosPackages(); // installed-only (fast); index loads on demand
  }

  /** Human language name for a code ("zh" -> "Tiếng Trung"); falls back to the code. */
  protected langName(code: string): string {
    try {
      return this.displayNames()?.of(code) ?? code;
    } catch {
      return code;
    }
  }

  /** Installed, downloading (here or elsewhere, from the activity service), failed, or not yet. */
  protected stateOf(row: ArgosPackRow): DownloadState {
    return downloadState(this.activity.setupItem(argosItem(row)), row.installed);
  }

  /** Load installed pairs (fast); pass `refresh` to also fetch the full index. */
  protected async loadArgosPackages(refresh = false): Promise<void> {
    if (refresh) {
      this.argosRefreshing.set(true);
      this.store.error.set(null);
    }
    try {
      const res = await this.ipc.getArgosPackages(refresh);
      this.argosInstalled.set(res.installed);
      // Only a refresh returns the index; a plain reload (after install/remove)
      // must NOT wipe the browsed list.
      if (refresh) this.argosAvailable.set(res.available);
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      if (refresh) this.argosRefreshing.set(false);
    }
  }

  /**
   * Download a pack. Its row follows it (and so does the top bar), also after
   * the page was left; how it ends shows on the row, a failure with the reason
   * and Try again. The setup installer reports a pack the worker answered
   * `ok: false` for as a failure, which the old direct request ignored: the
   * row went back to "Install" without a word.
   */
  protected async installArgosPair(pair: ArgosPair): Promise<void> {
    const item = argosItem(pair);
    if (this.activity.setupItem(item)?.state === 'running') return;
    this.activity.markStarting('model', item);
    try {
      await this.ipc.setupInstallModels({ argosPairs: [{ from: pair.from, to: pair.to }] });
    } catch (err) {
      this.activity.markFailed('model', item, toAppError(err));
    }
  }

  /** Done with a failed download: off the row, and off the top bar's list. */
  protected dismissFailure(pair: ArgosPair): void {
    const task = this.activity.setupItem(argosItem(pair));
    if (task) this.activity.dismiss(task.id);
  }

  protected async removeArgosPair(pair: ArgosPair): Promise<void> {
    const key = argosPairKey(pair);
    if (this.removing()) return;
    const from = this.langName(pair.from);
    const to = this.langName(pair.to);
    const ok = await this.confirmSvc.confirm({
      title: this.translate.instant('confirm.remove-argos-title'),
      message: this.translate.instant('confirm.remove-argos-body', { from, to }),
      confirmLabel: this.translate.instant('confirm.remove'),
    });
    if (!ok) return;
    this.removing.set(key);
    this.removeError.set(null);
    try {
      const res = await this.ipc.removeArgosPackage({ from: pair.from, to: pair.to });
      // `ok: false` is the worker refusing, not "already gone" (that is
      // `removed: false`): it was ignored, and the pack simply stayed.
      if (!res.ok) {
        this.removeError.set({
          key,
          error: toAppError({ code: 'UNKNOWN', message: this.translate.instant('settings.argos.remove-failed', { from, to }) }),
        });
      }
      await this.loadArgosPackages(false);
    } catch (err) {
      this.removeError.set({ key, error: toAppError(err) });
    } finally {
      this.removing.set(null);
    }
  }
}
