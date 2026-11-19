import { ChangeDetectionStrategy, Component, inject, signal, type OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { BrandAsset, BrandingSettings, GreetingPlacement, GreetingPlan } from '@videodubber/shared';

import { IpcService } from '../../../core/ipc/ipc.service';
import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { toAppError } from '../../../core/state/project.store';
import { BrandingFormComponent, formatClock, parseClock } from '../../../shared/branding/branding-form.component';
import { PlaybackService } from './playback.service';
import { StudioStore } from './studio.store';

/**
 * The editor's Logo & greeting block: the project's choice (applied at once,
 * like the speakers block), and where the greeting plays. Moving, adding or
 * removing a greeting is kept as the user left it until the greeting settings
 * change; Render remixes with it (the mix fingerprint sees the new plan).
 */
@Component({
  selector: 'vd-branding-panel',
  standalone: true,
  imports: [FormsModule, TranslatePipe, BrandingFormComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="panel-block stack">
      <h2>{{ 'branding.heading' | translate }}</h2>
      <vd-branding-form
        [value]="store.project()?.settings?.branding"
        [assets]="assets()"
        [disabled]="saving()"
        (changed)="save($event)"
      />

      @if (store.project()?.settings?.branding?.greeting) {
        <div class="stack-sm placements">
          <h3>{{ 'branding.placements' | translate }}</h3>
          <p class="hint muted">{{ 'branding.placements-hint' | translate }}</p>
          @if (plan(); as p) {
            @if (p.preview) {
              <p class="hint">{{ 'branding.placements-preview' | translate }}</p>
            }
            @if (p.openingSkipped) {
              <p class="hint warn-text">{{ 'branding.opening-skipped' | translate }}</p>
            }
            @if (p.found < p.requested) {
              <p class="hint warn-text">{{ 'branding.found-fewer' | translate: { found: p.found, requested: p.requested } }}</p>
            }
          }
          @if (rows().length === 0) {
            <p class="hint muted">{{ 'branding.placements-none' | translate }}</p>
          }
          @for (row of rows(); track $index) {
            <div class="row place">
              <span class="kind">
                {{ (row.kind === 'opening' ? 'branding.placement-opening' : 'branding.placement-repeat') | translate }}
              </span>
              <input type="text" class="time" [ngModel]="clock(row.atMs)" (change)="setTime($index, $any($event.target).value)" />
              <button type="button" class="btn btn-ghost btn-sm" (click)="seek(row.atMs)">▶</button>
              <button type="button" class="btn btn-ghost btn-sm" (click)="removeRow($index)">{{ 'branding.placement-remove' | translate }}</button>
            </div>
          }
          <div class="row">
            <button type="button" class="btn btn-sm" (click)="addAtPlayhead()">{{ 'branding.placement-add' | translate }}</button>
            <button type="button" class="btn btn-sm btn-primary" (click)="savePlan()" [disabled]="!dirty() || saving()">
              {{ 'branding.placement-save' | translate }}
            </button>
          </div>
          @if (notice(); as n) {
            <p class="hint">{{ n }}</p>
          }
        </div>
      }
    </section>
  `,
  styles: [
    `
      h3 {
        margin: 0;
        font-size: 0.9rem;
      }
      .place {
        align-items: center;
        gap: var(--vd-sp-2);
      }
      .kind {
        min-width: 70px;
        font-size: 0.85rem;
      }
      .time {
        width: 90px;
      }
      .hint {
        font-size: 0.8rem;
        margin: 0;
      }
    `,
  ],
})
export class BrandingPanelComponent implements OnInit {
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  protected readonly store = inject(StudioStore);
  private readonly playback = inject(PlaybackService);

  protected readonly assets = signal<BrandAsset[]>([]);
  protected readonly saving = signal(false);
  protected readonly plan = signal<(GreetingPlan & { preview?: boolean }) | null>(null);
  protected readonly rows = signal<GreetingPlacement[]>([]);
  protected readonly dirty = signal(false);
  protected readonly notice = signal<string | null>(null);

  ngOnInit(): void {
    void this.ipc.listBrandKit().then((a) => this.assets.set(a), () => undefined);
    void this.loadPlan();
  }

  protected clock(ms: number): string {
    return formatClock(ms);
  }

  private async loadPlan(): Promise<void> {
    try {
      const { plan } = await this.ipc.getGreetingPlan(this.store.projectId());
      this.plan.set(plan);
      this.rows.set(plan ? plan.placements.map((p) => ({ ...p })) : []);
      this.dirty.set(false);
    } catch {
      /* no plan yet */
    }
  }

  protected async save(branding: BrandingSettings | undefined): Promise<void> {
    this.saving.set(true);
    this.notice.set(null);
    try {
      const updated = await this.ipc.updateProjectSettings(this.store.projectId(), { branding: branding ?? ({} as BrandingSettings) });
      this.store.project.set(updated.project);
      await this.loadPlan();
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.saving.set(false);
    }
  }

  protected setTime(index: number, text: string): void {
    const ms = parseClock(text);
    if (!Number.isFinite(ms)) return;
    this.rows.update((rows) => rows.map((r, i) => (i === index ? { ...r, atMs: ms } : r)));
    this.dirty.set(true);
  }

  protected removeRow(index: number): void {
    this.rows.update((rows) => rows.filter((_, i) => i !== index));
    this.dirty.set(true);
  }

  protected addAtPlayhead(): void {
    const at = Math.round(this.playback.currentMs());
    this.rows.update((rows) => [...rows, { atMs: at, kind: 'repeat' as const }].sort((a, b) => a.atMs - b.atMs));
    this.dirty.set(true);
  }

  protected seek(ms: number): void {
    this.playback.seek(ms);
  }

  protected async savePlan(): Promise<void> {
    this.saving.set(true);
    this.notice.set(null);
    try {
      await this.ipc.saveGreetingPlan(this.store.projectId(), this.rows());
      await this.loadPlan();
      this.notice.set(this.translate.instant('branding.placement-saved'));
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.saving.set(false);
    }
  }
}
