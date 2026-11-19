import { Injectable } from '@angular/core';

import type { ProjectSettings } from '../models';

/** What the New project form held when the user left it. */
export interface NewProjectDraft {
  name: string;
  /** The name the video's file gave it: equal to `name` while the user typed none. */
  autoName: string;
  inputVideoPath: string;
  settings: ProjectSettings;
}

/**
 * The New project form, kept while the user is on another screen.
 *
 * The form's state lived in the wizard component alone, so any navigation
 * threw it away: opening "Listen to and compare every voice" from the form and
 * coming back gave a blank form, video, languages, engines and voice gone. The
 * wizard leaves its draft here when it closes and takes it back when it opens.
 *
 * In memory for the app session, never on disk; cleared once the project is
 * created (the project is then in the list).
 */
@Injectable({ providedIn: 'root' })
export class NewProjectDraftService {
  private draft: NewProjectDraft | null = null;

  /** Keep a copy (later edits to the form's objects must not reach it). */
  save(draft: NewProjectDraft): void {
    this.draft = structuredClone(draft);
  }

  /** The kept draft, once: the form that takes it owns it from then on. */
  take(): NewProjectDraft | null {
    const draft = this.draft;
    this.draft = null;
    return draft;
  }

  clear(): void {
    this.draft = null;
  }
}
