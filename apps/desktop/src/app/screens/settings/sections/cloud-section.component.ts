import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { MOTHER_CLAUDE_DOWNLOAD_URL } from '../../../core/claude/claude-view';
import { TranslatePipe, TranslateService } from '../../../core/i18n';
import { IpcService } from '../../../core/ipc/ipc.service';
import type {
  ClaudeConnection,
  CloudServiceId,
  CredentialTestResult,
  MotherClaudeStatus,
  SaveCredentialRequest,
} from '../../../core/models/setup';
import { MOTHER_CLAUDE_DEFAULT_URL } from '../../../core/models/setup';
import { toAppError } from '../../../core/state/project.store';
import { ConfirmService } from '../../../shared/confirm-dialog/confirm.service';
import { SettingsStore } from '../settings.store';

/** Mirrors DEFAULT_CLAUDE_MODEL in the orchestrator (providers/cloud/claudeMessages.ts). */
const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

/** Display metadata per cloud service. */
const SERVICE_META: Record<CloudServiceId, { label: string; keyHint: string; usedFor: string }> = {
  // Product names stay as they are; the hints are keys.
  openai: { label: 'OpenAI (ChatGPT)', keyHint: 'svc.openai-hint', usedFor: 'settings.cloud.openai-uses' },
  anthropic: { label: 'Anthropic (Claude)', keyHint: 'svc.anthropic-hint', usedFor: 'settings.cloud.anthropic-uses' },
  gemini: { label: 'Google Gemini', keyHint: 'svc.gemini-hint', usedFor: 'settings.cloud.gemini-uses' },
};

/**
 * Settings → Cloud services & keys: the API keys (masked; full keys never
 * leave the orchestrator), how Claude is reached (an API key, or the user's
 * Claude plan through Mother Claude), and Claude's model. The old page's
 * "Cloud API keys" card, moved: each service is a card of its own now, says
 * what it is used for, and Mother Claude's address and key — needed only when
 * changed on Mother Claude's side — sit under "Advanced" unless they matter.
 */
@Component({
  selector: 'vd-settings-cloud',
  standalone: true,
  imports: [NgTemplateOutlet, FormsModule, RouterLink, TranslatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cloud-section.component.html',
  styleUrls: ['../settings-shared.scss', './cloud-section.component.scss'],
})
export class CloudSectionComponent {
  protected readonly store = inject(SettingsStore);
  private readonly ipc = inject(IpcService);
  private readonly translate = inject(TranslateService);
  private readonly confirmSvc = inject(ConfirmService);

  protected readonly serviceMeta = SERVICE_META;
  protected readonly services: readonly CloudServiceId[] = ['openai', 'anthropic', 'gemini'];

  // Per-service key editing state.
  protected readonly keyInputs = signal<Partial<Record<CloudServiceId, string>>>({});
  protected readonly credBusy = signal<CloudServiceId | null>(null);
  protected readonly testResults = signal<Partial<Record<CloudServiceId, CredentialTestResult>>>({});
  /** The service whose Test is in flight (a save also sets credBusy). */
  protected readonly testing = signal<CloudServiceId | null>(null);

  // Claude through Mother Claude: its HTTP API as last checked (null = not yet).
  protected readonly motherClaudeStatus = signal<MotherClaudeStatus | null>(null);
  protected readonly motherClaudeChecking = signal(false);
  /** The address being typed; null shows the saved one. */
  protected readonly motherClaudeUrlInput = signal<string | null>(null);
  protected readonly motherClaudeKeyInput = signal('');
  protected readonly defaultMotherClaudeUrl = MOTHER_CLAUDE_DEFAULT_URL;

  /**
   * Mother Claude's address and key are rarely touched (only after changing
   * its port or setting a key there), so they fold away — but open by
   * themselves whenever they are what is wrong or not the default.
   */
  protected readonly mcAdvancedOpen = computed(
    () =>
      this.motherClaudeUrl() !== MOTHER_CLAUDE_DEFAULT_URL ||
      this.motherClaudeKeySet() ||
      this.motherClaudeStatus()?.keyRejected === true ||
      this.motherClaudeUrlInput() !== null,
  );

  constructor() {
    // Mother Claude's status is checked once the credentials say it is in use
    // (the old page did this right after loading them).
    let checked = false;
    effect(() => {
      if (checked || this.store.credentials().length === 0) return;
      checked = true;
      untracked(() => {
        if (this.claudeVia() === 'mother-claude') void this.checkMotherClaude();
      });
    });
  }

  /** The template's service variable, typed (ng-template contexts are untyped). */
  protected asService(value: unknown): CloudServiceId {
    return value as CloudServiceId;
  }

  protected credentialFor(service: CloudServiceId) {
    return this.store.credentialFor(service);
  }

  /**
   * The Claude model used for translation and review. It could only be changed
   * by hand-editing credentials.json, so every Claude user ran the old default
   * (Claude Haiku 4.5). A model saved by hand stays selectable as "other".
   */
  protected claudeModel(): string {
    return this.credentialFor('anthropic')?.model ?? DEFAULT_CLAUDE_MODEL;
  }

  /** `label` is a TRANSLATION KEY; `{id}` fills in a hand-set model's name. */
  protected claudeModels(): { id: string; label: string }[] {
    const choices = [
      { id: 'claude-opus-5-5', label: 'settings.keys.claude.opus' },
      { id: 'claude-sonnet-5-5', label: 'settings.keys.claude.sonnet' },
      { id: 'claude-haiku-5-5', label: 'settings.keys.claude.haiku' },
    ];
    const current = this.claudeModel();
    return choices.some((c) => c.id === current) ? choices : [...choices, { id: current, label: 'settings.keys.claude.other' }];
  }

  protected async saveClaudeModel(model: string): Promise<void> {
    if (this.credBusy() || model === this.claudeModel()) return;
    this.credBusy.set('anthropic');
    this.store.error.set(null);
    try {
      const res = await this.ipc.saveCredential({ service: 'anthropic', model });
      this.store.credentials.set(res.services);
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.credBusy.set(null);
    }
  }

  protected keyInputFor(service: CloudServiceId): string {
    return this.keyInputs()[service] ?? '';
  }

  protected setKeyInput(service: CloudServiceId, value: string): void {
    this.keyInputs.update((m) => ({ ...m, [service]: value }));
  }

  protected async saveKey(service: CloudServiceId): Promise<void> {
    const key = this.keyInputFor(service).trim();
    if (!key || this.credBusy()) return;
    this.credBusy.set(service);
    this.store.error.set(null);
    try {
      const res = await this.ipc.saveCredential({ service, apiKey: key });
      this.store.credentials.set(res.services);
      this.setKeyInput(service, '');
      this.testResults.update((m) => ({ ...m, [service]: undefined }));
      // Refresh availability flags on the provider pickers.
      await this.store.refreshProviders();
      void this.store.loadEffective();
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.credBusy.set(null);
    }
  }

  protected async clearKey(service: CloudServiceId): Promise<void> {
    if (this.credBusy()) return;
    const ok = await this.confirmSvc.confirm({
      title: this.translate.instant('confirm.remove-key-title'),
      message: this.translate.instant('confirm.remove-key-body', {
        service: this.serviceMeta[service].label,
      }),
      confirmLabel: this.translate.instant('confirm.remove'),
    });
    if (!ok) return;
    this.credBusy.set(service);
    this.store.error.set(null);
    try {
      const res = await this.ipc.saveCredential({ service, apiKey: null });
      this.store.credentials.set(res.services);
      this.testResults.update((m) => ({ ...m, [service]: undefined }));
      await this.store.refreshProviders();
      void this.store.loadEffective();
    } catch (err) {
      this.store.error.set(toAppError(err));
    } finally {
      this.credBusy.set(null);
    }
  }

  protected async testKey(service: CloudServiceId): Promise<void> {
    if (this.credBusy()) return;
    this.credBusy.set(service);
    this.testing.set(service);
    this.testResults.update((m) => ({ ...m, [service]: undefined }));
    try {
      const result = await this.ipc.testCredential(service);
      this.testResults.update((m) => ({ ...m, [service]: result }));
    } catch (err) {
      this.testResults.update((m) => ({
        ...m,
        [service]: { service, ok: false, detail: toAppError(err).message },
      }));
    } finally {
      this.credBusy.set(null);
      this.testing.set(null);
    }
    // A test through Mother Claude also tells whether its HTTP API is up.
    if (service === 'anthropic' && this.claudeVia() === 'mother-claude') void this.checkMotherClaude();
  }

  // ----------------------- Claude through Mother Claude -----------------------
  //
  // The user's Claude plan instead of an API key: Mother Claude's HTTP API
  // speaks the Claude API, so translation only changes its address. The API
  // key is never touched by switching: choosing "API key" again uses it.

  protected claudeVia(): ClaudeConnection {
    return this.credentialFor('anthropic')?.via === 'mother-claude' ? 'mother-claude' : 'api-key';
  }

  protected motherClaudeUrl(): string {
    return this.credentialFor('anthropic')?.motherClaude?.url ?? MOTHER_CLAUDE_DEFAULT_URL;
  }

  protected motherClaudeKeySet(): boolean {
    return this.credentialFor('anthropic')?.motherClaude?.keySet === true;
  }

  /** Save part of Claude's settings; true when it worked (the error banner says why not). */
  private async saveClaude(patch: Omit<SaveCredentialRequest, 'service'>): Promise<boolean> {
    if (this.credBusy()) return false;
    this.credBusy.set('anthropic');
    this.store.error.set(null);
    try {
      const res = await this.ipc.saveCredential({ service: 'anthropic', ...patch });
      this.store.credentials.set(res.services);
      this.testResults.update((m) => ({ ...m, anthropic: undefined }));
      return true;
    } catch (err) {
      this.store.error.set(toAppError(err));
      return false;
    } finally {
      this.credBusy.set(null);
    }
  }

  protected async setClaudeVia(via: ClaudeConnection): Promise<void> {
    if (via === this.claudeVia()) return;
    if (!(await this.saveClaude({ via }))) return;
    // The provider pickers' "needs an API key" follows the choice.
    await this.store.refreshProviders();
    void this.store.loadEffective();
    if (via === 'mother-claude') void this.checkMotherClaude();
  }

  protected async checkMotherClaude(): Promise<void> {
    if (this.motherClaudeChecking()) return;
    this.motherClaudeChecking.set(true);
    try {
      this.motherClaudeStatus.set(await this.ipc.getMotherClaudeStatus());
    } catch {
      this.motherClaudeStatus.set(null);
    } finally {
      this.motherClaudeChecking.set(false);
    }
  }

  protected async saveMotherClaudeUrl(): Promise<void> {
    const typed = this.motherClaudeUrlInput();
    if (typed === null) return;
    if (!(await this.saveClaude({ motherClaudeUrl: typed.trim() || null }))) return;
    this.motherClaudeUrlInput.set(null);
    void this.checkMotherClaude();
  }

  protected async resetMotherClaudeUrl(): Promise<void> {
    if (!(await this.saveClaude({ motherClaudeUrl: null }))) return;
    this.motherClaudeUrlInput.set(null);
    void this.checkMotherClaude();
  }

  protected async saveMotherClaudeKey(): Promise<void> {
    const key = this.motherClaudeKeyInput().trim();
    if (!key || !(await this.saveClaude({ motherClaudeKey: key }))) return;
    this.motherClaudeKeyInput.set('');
    void this.checkMotherClaude();
  }

  protected async clearMotherClaudeKey(): Promise<void> {
    if (!(await this.saveClaude({ motherClaudeKey: null }))) return;
    void this.checkMotherClaude();
  }

  protected downloadMotherClaude(): void {
    void this.ipc.openExternal(MOTHER_CLAUDE_DOWNLOAD_URL);
  }
}
