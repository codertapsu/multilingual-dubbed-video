import { ChangeDetectionStrategy, Component, inject, signal, type OnInit } from '@angular/core';

import { IpcService } from '../../core/ipc/ipc.service';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import type { AppError } from '../../core/models';
import { toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../error-banner/error-banner.component';

/** GET /diagnostics/summary (node-orchestrator diagnostics/diagnosticsService.ts). */
export interface DiagnosticsSummaryView {
  generatedAt: string;
  health: {
    version: string;
    commit?: string;
    uptimeSec: number;
    heapLimitMb: number;
    latest?: { rssMb: number; heapUsedMb: number; lagP99Ms: number; lagMaxMs: number; freeRamShare: number };
    peak: { rssMb: number; heapUsedMb: number; lagMaxMs: number };
    recoveredFrom?: { at: string; codeHex?: string; meaning?: string; uptimeSec?: number };
  };
  gpu: { name: string; memoryUsedMb: number; memoryTotalMb: number; utilizationPct: number }[] | null;
  laneOwner?: string;
  queue: { running: { projectId: string; name: string; step?: string; progressPercent?: number; etaSec?: number }[]; entries: { name: string; reason: string; message: string }[] } | null;
  engines: { running: string[]; unusable: string[]; lastOutput: Record<string, string> };
  disk: { freeBytes?: number; projectsDir: string; projects: { id: string; name: string; bytes: number }[] };
  recent: { warnings: { t?: string; msg: string; projectId?: string }[]; errors: { t?: string; msg: string; projectId?: string; mcpRequestId?: string }[] };
  crashes: { file: string; at: string; kind: string }[];
}

/**
 * The app's own health and evidence (Phase 7 of the production-hardening
 * plan): what the backend, the GPU, the queue and the engines are doing, what
 * the disk holds, the recent warnings and errors, crash reports, and a support
 * bundle to send. Shown on Help and in Settings → Diagnostics.
 *
 * In two layers. The facts a user can act on come first, in plain words: is
 * the app running, what is dubbing, how much room is left, did anything go
 * wrong. The numbers only support reads (memory and heap limit, event-loop
 * lag, who holds the GPU lane, engine ids and output, the log lines
 * themselves) are folded under Technical details: they led the panel, and read
 * like telemetry to the people it is for (UX audit, 2026-11).
 */
@Component({
  selector: 'vd-diagnostics-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TranslatePipe, ErrorBannerComponent],
  template: `
    <div class="stack">
      <div class="row">
        <button type="button" class="btn" (click)="load()" [disabled]="loading()">{{ (loading() ? 'diagnostics.loading' : 'diagnostics.refresh') | translate }}</button>
        <button type="button" class="btn btn-primary" (click)="exportBundle()" [disabled]="bundling()">
          {{ (bundling() ? 'diagnostics.bundling' : 'diagnostics.bundle') | translate }}
        </button>
      </div>
      <p class="hint muted">{{ 'diagnostics.bundle-hint' | translate }}</p>
      @if (bundlePath(); as p) {
        <p class="hint">
          {{ 'diagnostics.bundle-done' | translate }} <span class="mono">{{ p }}</span>
          <button type="button" class="btn btn-sm" (click)="reveal(p)">{{ 'diagnostics.open-folder' | translate }}</button>
        </p>
      }
      @if (error(); as e) {
        <vd-error-banner [error]="e" (dismiss)="error.set(null)" />
      }
      @if (summary(); as s) {
        <dl class="facts">
          <dt>{{ 'diagnostics.app' | translate }}</dt>
          <dd>
            {{ 'diagnostics.app-running' | translate: { version: s.health.version, time: duration(s.health.uptimeSec) } }}
            @if (s.health.recoveredFrom; as c) {
              <div class="warn-text">{{ 'diagnostics.recovered-plain' | translate: { time: time(c.at) } }}</div>
            }
          </dd>
          <dt>{{ 'diagnostics.queue' | translate }}</dt>
          <dd>
            @if (s.queue; as q) {
              @for (r of q.running; track r.projectId) {
                <div>
                  ▶ {{ r.name }}{{ r.step ? ' · ' + stepName(r.step) : '' }}{{ r.progressPercent !== undefined ? ' · ' + r.progressPercent + '%' : '' }}
                  @if (r.etaSec !== undefined) { · {{ 'diagnostics.eta' | translate: { time: duration(r.etaSec) } }} }
                </div>
              }
              @for (e of q.entries; track $index) {
                <div class="muted">⏸ {{ e.name }}: {{ e.message }}</div>
              }
              @if (q.running.length === 0 && q.entries.length === 0) {
                {{ 'diagnostics.queue-empty' | translate }}
              }
            }
          </dd>
          <dt>{{ 'diagnostics.gpu' | translate }}</dt>
          <dd>
            @if (s.gpu) {
              @for (g of s.gpu; track g.name) {
                <div>{{ g.name }}</div>
              }
              <div class="muted">{{ (s.laneOwner ? 'diagnostics.gpu-busy' : 'diagnostics.lane-free') | translate }}</div>
            } @else {
              {{ 'diagnostics.gpu-none' | translate }}
            }
          </dd>
          @if (s.engines.unusable.length) {
            <dt>{{ 'diagnostics.engines' | translate }}</dt>
            <dd class="warn-text">{{ 'diagnostics.engines-failed' | translate: { list: s.engines.unusable.join(', ') } }}</dd>
          }
          <dt>{{ 'diagnostics.disk' | translate }}</dt>
          <dd>
            {{ s.disk.freeBytes !== undefined ? ('diagnostics.disk-free' | translate: { gb: gb(s.disk.freeBytes) }) : '' }}
            @for (p of s.disk.projects.slice(0, 6); track p.id) {
              <div class="muted">{{ p.name }}: {{ gb(p.bytes) }} GB</div>
            }
          </dd>
          <dt>{{ 'diagnostics.recent' | translate }}</dt>
          <dd>
            @if (s.recent.errors.length === 0 && s.recent.warnings.length === 0) {
              {{ 'diagnostics.recent-none' | translate }}
            } @else {
              <span [class.test-fail]="s.recent.errors.length > 0" [class.warn-text]="s.recent.errors.length === 0">
                {{ 'diagnostics.recent-count' | translate: { errors: s.recent.errors.length, warnings: s.recent.warnings.length } }}
              </span>
            }
          </dd>
          <dt>{{ 'diagnostics.crashes' | translate }}</dt>
          <dd>
            {{ s.crashes.length === 0 ? ('diagnostics.crashes-none' | translate) : ('diagnostics.crashes-count' | translate: { n: s.crashes.length }) }}
          </dd>
        </dl>

        <!-- For support: kept whole, one click away. -->
        <details class="tech">
          <summary>{{ 'diagnostics.technical' | translate }}</summary>
          <dl class="facts small">
            <dt>{{ 'diagnostics.backend' | translate }}</dt>
            <dd>
              {{ s.health.version }}{{ s.health.commit ? ' (' + s.health.commit + ')' : '' }} ·
              {{ 'diagnostics.uptime' | translate: { time: duration(s.health.uptimeSec) } }}
              @if (s.health.latest; as l) {
                · {{ 'diagnostics.memory' | translate: { mb: round(l.rssMb), peak: round(s.health.peak.rssMb), limit: s.health.heapLimitMb } }}
                · {{ 'diagnostics.lag' | translate: { p99: round(l.lagP99Ms), worst: round(s.health.peak.lagMaxMs) } }}
                · {{ 'diagnostics.free-ram' | translate: { pct: round(l.freeRamShare * 100) } }}
              }
            </dd>
            @if (s.health.recoveredFrom; as c) {
              <dt>{{ 'diagnostics.recovered' | translate }}</dt>
              <dd class="warn-text">{{ 'diagnostics.recovered-at' | translate: { time: time(c.at), code: c.codeHex ?? '?' } }} {{ c.meaning }}</dd>
            }
            <dt>{{ 'diagnostics.gpu' | translate }}</dt>
            <dd>
              @for (g of s.gpu ?? []; track g.name) {
                <div>{{ g.name }}: {{ 'diagnostics.gpu-use' | translate: { used: g.memoryUsedMb, total: g.memoryTotalMb, busy: g.utilizationPct } }}</div>
              }
              <div class="muted">{{ s.laneOwner ? ('diagnostics.lane-held' | translate: { owner: s.laneOwner }) : ('diagnostics.lane-free' | translate) }}</div>
            </dd>
            <dt>{{ 'diagnostics.engines' | translate }}</dt>
            <dd>
              {{ s.engines.running.length ? s.engines.running.join(', ') : ('diagnostics.engines-none' | translate) }}
              @if (s.engines.unusable.length) {
                <div class="warn-text">{{ 'diagnostics.engines-failed' | translate: { list: s.engines.unusable.join(', ') } }}</div>
              }
              @for (id of outputIds(s); track id) {
                <details>
                  <summary>{{ 'diagnostics.engine-output' | translate: { id } }}</summary>
                  <pre class="mono small">{{ s.engines.lastOutput[id] }}</pre>
                </details>
              }
            </dd>
            <dt>{{ 'diagnostics.recent' | translate }}</dt>
            <dd>
              @for (r of s.recent.errors.slice(-8); track $index) {
                <div class="test-fail">{{ time(r.t) }} {{ r.msg }}{{ r.mcpRequestId ? ' (' + r.mcpRequestId + ')' : '' }}</div>
              }
              @for (r of s.recent.warnings.slice(-8); track $index) {
                <div class="warn-text">{{ time(r.t) }} {{ r.msg }}</div>
              }
              @if (s.recent.errors.length === 0 && s.recent.warnings.length === 0) {
                {{ 'diagnostics.recent-none' | translate }}
              }
            </dd>
            <dt>{{ 'diagnostics.crashes' | translate }}</dt>
            <dd>
              @for (c of s.crashes.slice(0, 5); track c.file) {
                <div>{{ time(c.at) }} {{ c.kind }}</div>
              }
              @if (s.crashes.length === 0) {
                {{ 'diagnostics.crashes-none' | translate }}
              }
            </dd>
          </dl>
        </details>
      }
    </div>
  `,
  styles: [
    `
      .facts {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: var(--vd-sp-2) var(--vd-sp-4);
        margin: 0;
      }
      .facts dt {
        font-weight: 600;
      }
      .facts dd {
        margin: 0;
        overflow-wrap: anywhere;
      }
      pre {
        white-space: pre-wrap;
        max-height: 14rem;
        overflow: auto;
      }
      .small {
        font-size: 0.85rem;
      }
      .warn-text {
        color: var(--vd-warning);
      }
      .test-fail {
        color: var(--vd-danger);
      }
      .tech > summary {
        cursor: pointer;
        font-size: 0.85rem;
        color: var(--vd-text-muted);
        margin-bottom: var(--vd-sp-2);
      }
    `,
  ],
})
export class DiagnosticsPanelComponent implements OnInit {
  private readonly ipc = inject(IpcService);
  private readonly i18n = inject(TranslateService);
  protected readonly summary = signal<DiagnosticsSummaryView | null>(null);
  protected readonly loading = signal(false);
  protected readonly bundling = signal(false);
  protected readonly bundlePath = signal<string | null>(null);
  protected readonly error = signal<AppError | null>(null);

  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    try {
      this.summary.set(await this.ipc.diagnosticsSummary());
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.loading.set(false);
    }
  }

  protected async exportBundle(): Promise<void> {
    this.bundling.set(true);
    this.error.set(null);
    try {
      this.bundlePath.set((await this.ipc.diagnosticsBundle()).path);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.bundling.set(false);
    }
  }

  protected async reveal(file: string): Promise<void> {
    await this.ipc.openManagedFolder(file.replace(/[\\/][^\\/]+$/, '')).catch((err: unknown) => this.error.set(toAppError(err)));
  }

  /** A pipeline step's name ("Translate"), or its id for a step this build has no name for. */
  protected stepName(step: string): string {
    const key = `opt.step.${step}`;
    const name = this.i18n.instant(key);
    return name === key ? step : name;
  }

  protected outputIds(s: DiagnosticsSummaryView): string[] {
    return Object.keys(s.engines.lastOutput).filter((id) => s.engines.lastOutput[id]?.trim());
  }

  protected duration(sec: number): string {
    return sec >= 3600 ? `${Math.floor(sec / 3600)} h ${String(Math.round((sec % 3600) / 60)).padStart(2, '0')}` : `${Math.round(sec / 60)} min`;
  }

  protected round(n: number): number {
    return Math.round(n);
  }

  protected gb(bytes: number): string {
    return (bytes / 1024 ** 3).toFixed(1);
  }

  protected time(iso?: string): string {
    return iso ? new Date(iso).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
  }
}
