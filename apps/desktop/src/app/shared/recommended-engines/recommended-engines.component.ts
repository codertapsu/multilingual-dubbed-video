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
  effect,
  untracked,
} from '@angular/core';

import { ActivityService } from '../../core/activity/activity.service';
import { IpcService } from '../../core/ipc/ipc.service';
import type { AppError, EnginePackInfo, EnginePackRecommendation } from '../../core/models';
import { TranslatePipe, TranslateService } from '../../core/i18n';
import { toAppError } from '../../core/state/project.store';
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
  /**
   * Install progress per pack, from the app-wide activity service: it keeps
   * showing after the user leaves and comes back (a stream of this panel's own
   * used to die with it).
   */
  protected readonly progress = computed<Record<string, { percent: number | null; message: string }>>(() => {
    const out: Record<string, { percent: number | null; message: string }> = {};
    for (const t of this.activity.running()) {
      if (t.kind === 'engine') out[t.id.slice('engine:'.length)] = { percent: t.percent, message: t.message };
    }
    return out;
  });
  protected readonly errors = computed<Record<string, AppError>>(() => {
    const out: Record<string, AppError> = {};
    for (const t of this.activity.failed()) {
      if (t.kind === 'engine' && t.error && !this.cleared().has(t.id)) out[t.id.slice('engine:'.length)] = t.error;
    }
    return out;
  });
  private readonly cleared = signal<Set<string>>(new Set());
  private readonly activity = inject(ActivityService);

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

  constructor() {
    // A pack finished installing (here or anywhere): mark it, tell the parent.
    const finished = new Set<string>();
    effect(() => {
      for (const t of this.activity.tasks()) {
        if (t.kind !== 'engine' || t.state !== 'done' || finished.has(t.id)) continue;
        finished.add(t.id);
        const packId = t.id.slice('engine:'.length);
        untracked(() => {
          this.installed.update((s) => new Set([...s, packId]));
          this.changed.emit(packId);
        });
      }
    });
  }

  ngOnDestroy(): void {
    /* the activity service keeps following installs */
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
    this.cleared.update((c) => new Set([...c, `engine:${packId}`]));
  }

  protected async install(packId: string): Promise<void> {
    this.cleared.update((c) => {
      const next = new Set(c);
      next.delete(`engine:${packId}`);
      return next;
    });
    this.activity.markStarting('engine', packId, this.packs().find((p) => p.id === packId)?.displayName);
    try {
      await this.ipc.installEngine(packId);
    } catch (err) {
      // Normalized: a network failure is no AppError, and `as` showed it as an
      // empty error badge with no message.
      this.activity.markFailed('engine', packId, toAppError(err));
    }
  }
}
