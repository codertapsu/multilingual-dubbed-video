import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { chosenOutputBaseName, projectOutputVideoPath } from '@videodubber/shared';

import { TranslatePipe, TranslateService } from '../../core/i18n';
import { IpcService } from '../../core/ipc/ipc.service';
import type { AppError, Project } from '../../core/models';
import { toAppError } from '../../core/state/project.store';
import { ErrorBannerComponent } from '../error-banner/error-banner.component';

/**
 * "Save to": where one project saves its finished video and subtitles, with
 * the buttons to change it. The wizard, the editor and the export screen all
 * show this one, so a project's folder reads and changes the same way
 * everywhere.
 *
 * The app used to pick the folder itself (the project's render/ folder deep
 * in its data), and the wizard's free-text field for it was ignored by the
 * render: a user could not tell where the video went, let alone choose.
 *
 * In the desktop app "Choose folder…" opens the system's folder picker; the
 * browser has none, so there it opens a field for a typed path.
 */
@Component({
  selector: 'vd-output-folder',
  standalone: true,
  imports: [FormsModule, TranslatePipe, ErrorBannerComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    .of-file {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      align-items: baseline;
    }
    .of-file .label {
      font-weight: 650;
      color: var(--vd-text-muted);
    }
    .of-file .mono {
      overflow-wrap: anywhere;
    }
    .of-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
    }
    .of-typed {
      display: flex;
      flex-wrap: wrap;
      gap: 0.5rem;
      align-items: center;
    }
    .of-typed input {
      flex: 1;
      min-width: 16rem;
    }
    details > summary {
      cursor: pointer;
    }
    p {
      margin: 0;
    }
  `,
  template: `
    <div class="stack">
      <vd-error-banner [error]="error()" (dismiss)="error.set(null)" />

      <div class="of-file">
        <span class="label">{{ 'output-folder.file-label' | translate }}</span>
        <span class="mono">{{ videoPath() }}</span>
      </div>
      <p class="hint">
        {{ (isDefault() ? 'output-folder.default-place' : 'output-folder.chosen-place') | translate }}
      </p>

      @if (typing()) {
        <div class="of-typed">
          <label class="visually-hidden" for="of-typed-path">{{ 'output-folder.path-label' | translate }}</label>
          <input
            id="of-typed-path"
            type="text"
            [ngModelOptions]="{ standalone: true }" [ngModel]="typed()"
            (ngModelChange)="typed.set($event)"
            (keydown.enter)="applyTyped()"
            [placeholder]="'output-folder.path-ph' | translate"
            [disabled]="busy()"
          />
          <button type="button" class="btn btn-sm btn-primary" (click)="applyTyped()" [disabled]="busy() || !typed().trim()">
            {{ 'output-folder.apply' | translate }}
          </button>
          <button type="button" class="btn btn-sm" (click)="typing.set(false)" [disabled]="busy()">
            {{ 'common.cancel' | translate }}
          </button>
        </div>
        <p class="hint">{{ 'output-folder.browser-hint' | translate }}</p>
      }

      <div class="of-actions">
        <button type="button" class="btn btn-sm" (click)="choose()" [disabled]="busy() || locked()">
          {{ (busy() ? 'output-folder.saving' : isDefault() ? 'output-folder.choose' : 'output-folder.change') | translate }}
        </button>
        @if (!isDefault()) {
          <button type="button" class="btn btn-sm" (click)="useDefault()" [disabled]="busy() || locked()">
            {{ 'output-folder.use-default' | translate }}
          </button>
        }
        <button type="button" class="btn btn-sm" (click)="open()" [disabled]="opening()">
          {{ 'output-folder.open' | translate }}
        </button>
      </div>
      @if (locked()) {
        <p class="hint">{{ 'output-folder.locked' | translate }}</p>
      }

      <p class="hint">{{ 'output-folder.hint' | translate }}</p>
      <details>
        <summary class="hint">{{ 'output-folder.more' | translate }}</summary>
        <p class="hint">{{ 'output-folder.naming-hint' | translate: { example: exampleName() } }}</p>
        <p class="hint">{{ 'output-folder.moved-hint' | translate }}</p>
      </details>
    </div>
  `,
})
export class OutputFolderComponent {
  readonly project = input.required<Project>();
  /** The project is processing: its folder can change once it stops. */
  readonly locked = input(false);
  /** After every change, with the project as saved. */
  readonly changed = output<Project>();

  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);

  protected readonly busy = signal(false);
  protected readonly opening = signal(false);
  protected readonly error = signal<AppError | null>(null);
  /** Browser only: the typed-path field is open. */
  protected readonly typing = signal(false);
  protected readonly typed = signal('');

  protected readonly videoPath = computed(() => projectOutputVideoPath(this.project()));
  /** No folder chosen: the project's own folder in VideoDubber's data. */
  protected readonly isDefault = computed(() => !this.project().outputFileName);
  /** What the video is called in a folder the user chooses. */
  protected readonly exampleName = computed(() => {
    const p = this.project();
    return `${chosenOutputBaseName(p.name, p.settings.targetLanguage, () => false)}.mp4`;
  });

  protected async choose(): Promise<void> {
    if (this.busy() || this.locked()) return;
    if (!this.ipc.inTauri) {
      this.typed.set(this.isDefault() ? '' : this.project().outputDir);
      this.typing.set(true);
      return;
    }
    this.error.set(null);
    let picked: string | null;
    try {
      picked = await this.ipc.pickFolder(this.translate.instant('output-folder.dialog-title'), this.project().outputDir);
    } catch (err) {
      this.error.set(toAppError(err));
      return;
    }
    if (picked) await this.apply(picked);
  }

  protected async applyTyped(): Promise<void> {
    const dir = this.typed().trim();
    if (!dir) return;
    if (await this.apply(dir)) this.typing.set(false);
  }

  protected async useDefault(): Promise<void> {
    if (this.locked()) return;
    await this.apply(null);
  }

  protected async open(): Promise<void> {
    if (this.opening()) return;
    this.opening.set(true);
    this.error.set(null);
    try {
      await this.ipc.openOutputFolder(this.project().outputDir);
    } catch (err) {
      this.error.set(toAppError(err));
    } finally {
      this.opening.set(false);
    }
  }

  private async apply(dir: string | null): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    this.error.set(null);
    try {
      this.changed.emit(await this.ipc.setProjectOutputDir(this.project().id, dir));
      return true;
    } catch (err) {
      this.error.set(this.explain(toAppError(err)));
      return false;
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * A folder that cannot be used, headlined in the user's language. The
   * orchestrator's own sentence (which folder, which file, the system's
   * reason) stays as the cause: it is the part that tells them what to fix.
   */
  private explain(err: AppError): AppError {
    if (err.code !== 'OUTPUT_NOT_WRITABLE') return err;
    return {
      ...err,
      message: this.translate.instant('output-folder.change-failed'),
      cause: err.cause ? `${err.message} (${err.cause})` : err.message,
      remediation: this.translate.instant('output-folder.change-failed-fix'),
    };
  }
}
