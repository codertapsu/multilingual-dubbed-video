import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  type OnDestroy,
  type OnInit,
} from '@angular/core';

import { environment } from '../../core/environment';
import { IpcService } from '../../core/ipc/ipc.service';
import type { AppError, EnginePackInfo, EnginePackRecommendation } from '../../core/models';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { ErrorBannerComponent } from '../error-banner/error-banner.component';

/** One recommendation, joined with its catalog entry for the name and size. */
interface Row {
  rec: EnginePackRecommendation;
  pack: EnginePackInfo;
}

/**
 * "Recommended for this computer": the optional engine packs that would make
 * dubbing faster or better on THIS machine's hardware, each with the reason in
 * the user's language, its download size, and an Install button.
 *
 * The recommendations always existed (GET /engines/recommended), but the app
 * showed them only as a bare "Recommended" badge deep in the Settings list, so a
 * user with an NVIDIA card had no way to learn that a GPU voice existed, what it
 * would buy them, or what it would cost to download. Nothing here installs on
 * its own: every pack is the user's choice, as the hardware principle requires
 * (recommend by measured fit, never restrict).
 *
 * Self-contained so the same panel can close the first-run wizard and head
 * Settings → Engines: it loads its own data, follows install progress on the
 * engine event stream, and reports finished installs through `changed`.
 */
@Component({
  selector: 'vd-recommended-engines',
  standalone: true,
  imports: [TranslatePipe, ErrorBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (loaded() && (rows().length > 0 || !hideWhenEmpty())) {
      <section class="rec" [class.compact]="compact()">
        <h3>{{ 'engines.rec.heading' | translate }}</h3>
        <p class="muted">{{ 'engines.rec.intro' | translate }}</p>

        @if (pending().length === 0) {
          <p class="hint test-ok">✓ {{ 'engines.rec.all-installed' | translate }}</p>
        }

        @for (row of rows(); track row.pack.id) {
          <div class="rec-row">
            <div class="rec-head">
              <strong>{{ row.pack.displayName }}</strong>
              <span class="chip">{{ sizeLabel(row.pack.approxSizeMb) }}</span>
              @if (isInstalled(row.pack.id)) {
                <span class="badge badge-completed">{{ 'engines.rec.installed' | translate }}</span>
              }
            </div>
            <p class="rec-why">{{ reasonOf(row.rec) }}</p>

            @if (progress()[row.pack.id]; as prog) {
              <div class="install-progress">
                <span class="hint">{{ prog.message }}</span>
                @if (prog.percent !== null) {
                  <progress [value]="prog.percent" max="100"></progress>
                } @else {
                  <progress></progress>
                }
              </div>
            } @else if (!isInstalled(row.pack.id)) {
              <button type="button" class="btn btn-sm" (click)="install(row.pack.id)">
                {{ 'engines.rec.install' | translate: { size: sizeLabel(row.pack.approxSizeMb) } }}
              </button>
            }

            @if (errors()[row.pack.id]; as err) {
              <vd-error-banner [error]="err" (dismiss)="clearError(row.pack.id)" />
            }
          </div>
        }

        <p class="hint">{{ 'engines.rec.later' | translate }}</p>
      </section>
    }
  `,
  styles: [
    `
      .rec {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .rec h3 {
        margin: 0;
      }
      .rec-row {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 10px 12px;
        border: 1px solid var(--vd-border);
        border-radius: var(--vd-radius, 8px);
        background: var(--vd-surface);
      }
      .rec-head {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .rec-why {
        margin: 0;
        line-height: 1.45;
      }
      .install-progress {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .install-progress progress {
        width: 100%;
      }
      .rec-row .btn {
        align-self: flex-start;
      }
      .compact .rec-row {
        padding: 8px 10px;
      }
    `,
  ],
})
export class RecommendedEnginesComponent implements OnInit, OnDestroy {
  private readonly ipc = inject(IpcService);

  /** Tighter spacing (the first-run wizard). */
  readonly compact = input(false);
  /** Render nothing when there is nothing to recommend (the wizard). */
  readonly hideWhenEmpty = input(false);
  /** Emitted when an install finishes, so a parent list can refresh. */
  readonly changed = output<string>();

  protected readonly loaded = signal(false);
  private readonly recs = signal<EnginePackRecommendation[]>([]);
  private readonly packs = signal<EnginePackInfo[]>([]);
  private readonly installed = signal<Set<string>>(new Set());
  protected readonly progress = signal<Record<string, { percent: number | null; message: string }>>(
    {},
  );
  protected readonly errors = signal<Record<string, AppError>>({});
  private events: EventSource | null = null;

  protected readonly rows = computed<Row[]>(() => {
    const byId = new Map(this.packs().map((p) => [p.id, p]));
    return this.recs()
      .map((rec) => ({ rec, pack: byId.get(rec.packId) }))
      .filter((r): r is Row => r.pack !== undefined);
  });
  protected readonly pending = computed(() =>
    this.rows().filter((r) => !this.installed().has(r.pack.id)),
  );

  private readonly translate = inject(TranslateService);

  ngOnInit(): void {
    void this.load();
  }

  ngOnDestroy(): void {
    this.events?.close();
    this.events = null;
  }

  private async load(): Promise<void> {
    try {
      const [rec, engines] = await Promise.all([
        this.ipc.getRecommendedEngines(),
        this.ipc.getEngines(),
      ]);
      this.recs.set(rec.recommendations ?? []);
      this.packs.set(engines.available ?? []);
      this.installed.set(new Set((engines.installed ?? []).map((i) => i.id)));
    } catch {
      // Backend offline: render nothing rather than an error; Settings shows
      // the backend state elsewhere.
      this.recs.set([]);
    } finally {
      this.loaded.set(true);
    }
  }

  protected isInstalled(packId: string): boolean {
    return this.installed().has(packId);
  }

  /** The reason in the user's language; the English sentence if the key is unknown. */
  protected reasonOf(rec: EnginePackRecommendation): string {
    const key = rec.reasonText?.key;
    if (!key) return rec.reason;
    // instant() reads the locale signal, so the text follows a language switch;
    // it returns the key itself on a miss (a newer backend), hence the fallback.
    const text = this.translate.instant(key, rec.reasonText.params);
    return text === key ? rec.reason : text;
  }

  protected sizeLabel(mb: number): string {
    return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`;
  }

  protected clearError(packId: string): void {
    this.errors.update((m) => {
      const next = { ...m };
      delete next[packId];
      return next;
    });
  }

  protected async install(packId: string): Promise<void> {
    this.clearError(packId);
    this.follow();
    this.progress.update((m) => ({ ...m, [packId]: { percent: null, message: '…' } }));
    try {
      await this.ipc.installEngine(packId);
    } catch (err) {
      this.done(packId);
      this.errors.update((m) => ({ ...m, [packId]: err as AppError }));
    }
  }

  private done(packId: string): void {
    this.progress.update((m) => {
      const next = { ...m };
      delete next[packId];
      return next;
    });
  }

  /** Follow /engines/events (once) for progress, completion and failures. */
  private follow(): void {
    if (this.events || !environment.orchestratorUrl) return;
    const es = new EventSource(`${environment.orchestratorUrl}/engines/events`);
    es.onmessage = (ev) => {
      try {
        const event = JSON.parse(ev.data) as
          | { type: 'progress'; packId: string; percent: number | null; message: string }
          | { type: 'done'; packId: string }
          | { type: 'error'; packId: string; error: AppError }
          | { type: 'log' };
        if (event.type === 'progress') {
          this.progress.update((m) => ({
            ...m,
            [event.packId]: { percent: event.percent, message: event.message },
          }));
        } else if (event.type === 'done') {
          this.done(event.packId);
          this.installed.update((s) => new Set([...s, event.packId]));
          this.changed.emit(event.packId);
        } else if (event.type === 'error') {
          this.done(event.packId);
          this.errors.update((m) => ({ ...m, [event.packId]: event.error }));
        }
      } catch {
        /* ignore a malformed frame */
      }
    };
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) {
        this.progress.set({});
        this.events = null;
      }
    };
    this.events = es;
  }
}
