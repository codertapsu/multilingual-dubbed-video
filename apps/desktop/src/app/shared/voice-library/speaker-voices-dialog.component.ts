import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal, type OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { speakerNumber, type SpeakerSummary } from '@videodubber/shared';

import { TranslatePipe, TranslateService } from '../../core/i18n';
import { IpcService } from '../../core/ipc/ipc.service';
import type { AppError, VoiceConsentStatements, VoiceProfile } from '../../core/models';
import { toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../error-banner/error-banner.component';

export interface SpeakerVoicesOutcome {
  made: { speakerId: string; profile: VoiceProfile }[];
  skipped: { speakerId: string; reason: 'too-short' | 'failed'; speechMs?: number; message?: string }[];
}

/**
 * "Make a voice for every speaker": one statement about the video's voices,
 * then the app makes each chosen speaker's voice from their clearest lines and
 * gives it to them (POST /projects/:id/voices/speakers). Speakers with too
 * little clear speech are reported, not guessed at.
 */
@Component({
  selector: 'vd-speaker-voices-dialog',
  standalone: true,
  imports: [TranslatePipe, ErrorBannerComponent, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="backdrop" (click)="busy() ? null : closed.emit()"></div>
    <div class="dialog card stack" role="dialog" aria-modal="true" [attr.aria-label]="'speaker-voices.title' | translate">
      <div class="row-between">
        <h2>{{ 'speaker-voices.title' | translate }}</h2>
        <button type="button" class="btn btn-ghost btn-sm" [disabled]="busy()" (click)="closed.emit()" [attr.aria-label]="'voice-clone.close' | translate">✕</button>
      </div>
      <vd-error-banner [error]="error()" (dismiss)="error.set(null)" />

      @if (outcome(); as o) {
        @if (o.made.length > 0) {
          <p>{{ 'speaker-voices.made' | translate: { n: o.made.length } }}</p>
          <ul class="results">
            @for (m of o.made; track m.speakerId) {
              <li class="ok">✓ {{ m.profile.name }}</li>
            }
          </ul>
        }
        @if (o.skipped.length > 0) {
          <ul class="results">
            @for (s of o.skipped; track s.speakerId) {
              <li class="warn">
                <strong>{{ 'studio.speaker-n' | translate: { n: n(s.speakerId) } }}</strong>
                @if (s.reason === 'too-short') {
                  {{ 'speaker-voices.too-short' | translate: { s: ((s.speechMs ?? 0) / 1000).toFixed(1) } }}
                } @else {
                  {{ 'speaker-voices.failed' | translate: { why: s.message ?? '' } }}
                }
              </li>
            }
          </ul>
        }
        <p class="hint">{{ (voiced() ? 'speaker-voices.next' : 'speaker-voices.next-before-dub') | translate }}</p>
        <div class="row">
          <button type="button" class="btn btn-primary" (click)="closed.emit()">{{ 'voice-clone.finish' | translate }}</button>
        </div>
      } @else if (engineMissing()) {
        <p>{{ 'speaker-voices.engine-needed' | translate }}</p>
        <div class="row">
          <a class="btn btn-primary" routerLink="/voices" (click)="closed.emit()">{{ 'speaker-voices.open-voices' | translate }}</a>
        </div>
      } @else {
        <p>{{ 'speaker-voices.intro' | translate }}</p>
        <fieldset class="stack-sm">
          <legend>{{ 'speaker-voices.which' | translate }}</legend>
          @for (s of speakers(); track s.speakerId) {
            <label class="choice">
              <input type="checkbox" [checked]="chosen().has(s.speakerId)" [disabled]="busy()" (change)="toggle(s.speakerId)" />
              {{ 'studio.speaker-n' | translate: { n: n(s.speakerId) } }}
              <span class="muted small">{{ 'editor.speaker-stats' | translate: { lines: s.lines, s: (s.speechMs / 1000).toFixed(0) } }}</span>
              @if (hasVoice().has(s.speakerId)) {
                <span class="muted small">· {{ 'speaker-voices.has-voice' | translate }}</span>
              }
            </label>
          }
        </fieldset>
        <p class="hint">{{ 'speaker-voices.stay' | translate }}</p>
        <blockquote class="statement">{{ consent()?.statements?.['source-video'] ?? '' }}</blockquote>
        <label class="choice">
          <input type="checkbox" [checked]="accepted()" [disabled]="busy()" (change)="accepted.set(!accepted())" />
          {{ 'voice-clone.agree' | translate }}
        </label>
        <p class="hint">{{ 'voice-clone.rights-honest' | translate }}</p>
        <div class="row">
          <button type="button" class="btn btn-primary" [disabled]="!accepted() || chosen().size === 0 || busy() || !consent()" (click)="make()">
            {{ (busy() ? 'speaker-voices.making' : 'speaker-voices.make') | translate: { n: chosen().size } }}
          </button>
        </div>
        @if (busy()) {
          <p class="muted" role="status">{{ 'speaker-voices.making-help' | translate: { s: chosen().size * 10 } }}</p>
        }
      }
    </div>
  `,
  styles: [
    `
      :host {
        position: fixed;
        inset: 0;
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .backdrop {
        position: absolute;
        inset: 0;
        background: var(--vd-overlay);
      }
      .dialog {
        position: relative;
        width: min(36rem, calc(100vw - 2rem));
        max-height: calc(100vh - 2rem);
        overflow: auto;
      }
      .row-between {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.75rem;
      }
      h2 {
        margin: 0;
      }
      fieldset {
        border: 0;
        padding: 0;
        margin: 0;
      }
      .choice {
        display: flex;
        align-items: baseline;
        gap: 0.5rem;
      }
      .statement {
        margin: 0;
        padding: 0.75rem 1rem;
        border-left: 3px solid var(--vd-primary);
        background: var(--vd-surface-2);
        border-radius: var(--vd-radius-sm);
      }
      .results {
        margin: 0;
        padding-left: 1.1rem;
      }
      .results .ok {
        color: var(--vd-success, inherit);
      }
      .results .warn {
        color: var(--vd-warning, inherit);
      }
    `,
  ],
})
export class SpeakerVoicesDialogComponent implements OnInit {
  private readonly ipc = inject(IpcService);
  private readonly i18n = inject(TranslateService);

  readonly projectId = input.required<string>();
  readonly speakers = input.required<readonly SpeakerSummary[]>();
  /** Speakers that already have a voice: unticked at first. */
  readonly hasVoice = input<ReadonlySet<string>>(new Set());
  /** The dub already has voices (lines get marked for re-voicing). */
  readonly voiced = input(false);
  readonly done = output<SpeakerVoicesOutcome>();
  readonly closed = output<void>();

  protected readonly consent = signal<VoiceConsentStatements | null>(null);
  protected readonly engineMissing = signal(false);
  protected readonly accepted = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<AppError | null>(null);
  protected readonly outcome = signal<SpeakerVoicesOutcome | null>(null);
  protected readonly picked = signal<ReadonlySet<string> | null>(null);
  protected readonly chosen = computed(
    () => this.picked() ?? new Set(this.speakers().filter((s) => !this.hasVoice().has(s.speakerId)).map((s) => s.speakerId)),
  );
  protected readonly n = speakerNumber;

  async ngOnInit(): Promise<void> {
    try {
      const [engines, consent] = await Promise.all([this.ipc.voiceEngines(), this.ipc.voiceConsent(this.i18n.locale())]);
      this.engineMissing.set(!engines.find((e) => e.id === 'vieneu')?.installed);
      this.consent.set(consent);
    } catch (err) {
      this.error.set(toAppError(err));
    }
  }

  protected toggle(speakerId: string): void {
    const next = new Set(this.chosen());
    if (next.has(speakerId)) next.delete(speakerId);
    else next.add(speakerId);
    this.picked.set(next);
  }

  protected async make(): Promise<void> {
    const consent = this.consent();
    if (!consent || !this.accepted() || this.chosen().size === 0) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const speakerIds = [...this.chosen()];
      const names = Object.fromEntries(speakerIds.map((id) => [id, this.i18n.instant('studio.speaker-n', { n: speakerNumber(id) })]));
      const outcome = await this.ipc.makeSpeakerVoices(this.projectId(), {
        consent: { relation: 'source-video', statementVersion: consent.version, locale: this.i18n.locale(), accepted: true },
        speakerIds,
        names,
      });
      this.outcome.set(outcome);
      this.done.emit(outcome);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.busy.set(false);
    }
  }
}
