import { ChangeDetectionStrategy, Component, computed, inject, signal, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { IpcService } from '../../../core/ipc/ipc.service';
import type { ArgosPair } from '../../../core/models/setup';
import { toAppError } from '../../../core/state/project.store';
import { BusyIndicatorComponent } from '../../../shared/busy-indicator/busy-indicator.component';
import { ConfirmService } from '../../../shared/confirm-dialog/confirm.service';
import { SettingsStore } from '../settings.store';

/** One row in the Translation-packs manager (a pair + resolved names + state). */
interface ArgosPackRow extends ArgosPair {
  key: string;
  installed: boolean;
  fromName: string;
  toName: string;
}

/**
 * The Argos Translate language packs: the installed pairs, the full index on
 * demand, install and remove. The old page's "Translation packs" card, moved
 * onto the Argos card of Settings → Translation.
 */
@Component({
  selector: 'vd-argos-packs',
  standalone: true,
  imports: [FormsModule, TranslatePipe, BusyIndicatorComponent],
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
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--vd-sp-2);
      padding: var(--vd-sp-2) 0;
      border-top: 1px solid var(--vd-border);
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
        @if (argosRows().length > 8) {
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
          <li class="pair">
            <span class="card-head">
              <span class="pair-name">{{ row.fromName }} → {{ row.toName }}</span>
              <span class="chip mono">{{ row.from }}→{{ row.to }}</span>
              @if (row.installed) {
                <span class="badge badge-completed">{{ 'settings.argos.installed' | translate }}</span>
              }
            </span>
            <span class="row-actions">
              @if (row.installed) {
                <button type="button" class="btn btn-ghost btn-sm" (click)="removeArgosPair(row)" [disabled]="argosBusy() !== null">
                  {{ (argosBusy() === row.key ? 'settings.argos.removing' : 'settings.argos.remove') | translate }}
                </button>
              } @else {
                <button type="button" class="btn btn-sm" (click)="installArgosPair(row)" [disabled]="argosBusy() !== null">
                  {{ (argosBusy() === row.key ? 'settings.argos.installing' : 'settings.argos.install') | translate }}
                </button>
                <vd-busy-indicator [active]="argosBusy() === row.key" [label]="'settings.argos.downloading' | translate" />
              }
            </span>
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

  protected readonly argosInstalled = signal<ArgosPair[]>([]);
  protected readonly argosAvailable = signal<ArgosPair[]>([]);
  protected readonly argosRefreshing = signal(false);
  /** "from->to" key of the pair currently installing/removing (per-row spinner). */
  protected readonly argosBusy = signal<string | null>(null);
  protected readonly argosFilter = signal('');

  private static readonly langDisplay = (() => {
    try {
      return new Intl.DisplayNames(['en'], { type: 'language' });
    } catch {
      return null;
    }
  })();

  ngOnInit(): void {
    void this.loadArgosPackages(); // installed-only (fast); index loads on demand
  }

  /** Human language name for a code (e.g. "zh" -> "Chinese"); falls back to the code. */
  protected langName(code: string): string {
    try {
      return ArgosPacksComponent.langDisplay?.of(code) ?? code;
    } catch {
      return code;
    }
  }

  private pairKey(p: ArgosPair): string {
    return `${p.from}->${p.to}`;
  }

  /** Installed ∪ available pairs as display rows (installed first, then by name),
   * filtered by the search box. Pure read — safe inside a computed. */
  protected readonly argosRows = computed<ArgosPackRow[]>(() => {
    const installedKeys = new Set(this.argosInstalled().map((p) => this.pairKey(p)));
    const byKey = new Map<string, ArgosPair>();
    for (const p of this.argosInstalled()) byKey.set(this.pairKey(p), p);
    for (const p of this.argosAvailable()) byKey.set(this.pairKey(p), p);

    const q = this.argosFilter().trim().toLowerCase();
    const rows: ArgosPackRow[] = [...byKey.values()].map((p) => ({
      ...p,
      key: this.pairKey(p),
      installed: installedKeys.has(this.pairKey(p)),
      fromName: this.langName(p.from),
      toName: this.langName(p.to),
    }));
    const filtered = q ? rows.filter((r) => `${r.fromName} ${r.toName} ${r.from} ${r.to}`.toLowerCase().includes(q)) : rows;
    return filtered.sort(
      (a, b) => Number(b.installed) - Number(a.installed) || a.fromName.localeCompare(b.fromName) || a.toName.localeCompare(b.toName),
    );
  });

  /** Load installed pairs (fast); pass `refresh` to also fetch the full index. */
  protected async loadArgosPackages(refresh = false): Promise<void> {
    if (refresh) this.argosRefreshing.set(true);
    this.store.error.set(null);
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

  protected async installArgosPair(pair: ArgosPair): Promise<void> {
    const key = this.pairKey(pair);
    if (this.argosBusy()) return;
    this.argosBusy.set(key);
    this.store.error.set(null);
    try {
      await this.ipc.ensureArgosPackage({ from: pair.from, to: pair.to });
      await this.loadArgosPackages(false);
      void this.store.loadProcessingSetup(); // a newly-installed pair can flip availability
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.argosBusy.set(null);
    }
  }

  protected async removeArgosPair(pair: ArgosPair): Promise<void> {
    const key = this.pairKey(pair);
    if (this.argosBusy()) return;
    const ok = await this.confirmSvc.confirm({
      title: this.translate.instant('confirm.remove-argos-title'),
      message: this.translate.instant('confirm.remove-argos-body', {
        from: this.langName(pair.from),
        to: this.langName(pair.to),
      }),
      confirmLabel: this.translate.instant('confirm.remove'),
    });
    if (!ok) return;
    this.argosBusy.set(key);
    this.store.error.set(null);
    try {
      await this.ipc.removeArgosPackage({ from: pair.from, to: pair.to });
      await this.loadArgosPackages(false);
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.argosBusy.set(null);
    }
  }
}
