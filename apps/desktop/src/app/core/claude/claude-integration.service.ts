import { Injectable, inject, signal } from '@angular/core';

import { IpcService } from '../ipc/ipc.service';
import type { ClaudeCodeAction, ClaudeIntegration } from '../models/setup';

/**
 * The app's Claude connections (Claude Desktop, Claude Code) and whether
 * Mother Claude is running, shared by Settings, the guide and Home, so a
 * connect made in one place shows in the others. Every action answers with the
 * fresh status from the orchestrator (GET/POST /integrations/claude…).
 */
@Injectable({ providedIn: 'root' })
export class ClaudeIntegrationService {
  private readonly ipc = inject(IpcService);

  readonly status = signal<ClaudeIntegration | null>(null);
  /** The status could not be read (the backend is not answering). */
  readonly unavailable = signal(false);

  async refresh(): Promise<void> {
    try {
      this.status.set(await this.ipc.getClaudeIntegration());
      this.unavailable.set(false);
    } catch {
      this.unavailable.set(this.status() === null);
    }
  }

  /** Add (or remove) VideoDubber in Claude Desktop's config. Throws the app error. */
  async setDesktop(connect: boolean): Promise<void> {
    this.status.set(await this.ipc.setClaudeDesktopConnection(connect));
  }

  /** Connect, reconnect or disconnect Claude Code through its CLI. Throws the app error (the CLI's words). */
  async setCode(action: ClaudeCodeAction): Promise<void> {
    this.status.set(await this.ipc.setClaudeCodeConnection(action));
  }
}
