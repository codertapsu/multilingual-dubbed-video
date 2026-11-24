import { Injectable } from '@angular/core';

import type { ProjectSettings } from '../models';

/** How long each part of a series is: a preset range, or the user's own. */
export type DraftSeriesLength = '15-20' | '30-40' | '55-65' | 'custom';

/** "Split into parts" as the form holds it. */
export interface DraftSeries {
  split: boolean;
  length: DraftSeriesLength;
  /** Minutes, used when `length` is 'custom'. */
  min: number;
  max: number;
  /** The AI that chooses the cuts ('' = none set up). */
  ai: string;
  recapSec: number;
  autoStart: boolean;
}

/** What the New project form held when the user left it. */
export interface NewProjectDraft {
  name: string;
  /** The name the video's file gave it: equal to `name` while the user typed none. */
  autoName: string;
  inputVideoPath: string;
  settings: ProjectSettings;
  series: DraftSeries;
  /**
   * The preset chosen (`id`, '' for none), the name typed to save one, and the
   * folder the chosen preset saves finished videos to.
   */
  preset: { id: string; name: string; outputDir?: string };
  /** "More options" was open. */
  moreOptions: boolean;
  /**
   * The project Continue made from this form, while it has not started:
   * coming back revises it instead of making a second one (and a second copy
   * of the video). `step` 2 when the user left step 2 through one of the
   * form's own links (Add key), to come back to it.
   */
  created?: { projectId: string; fromVideo: string; step: 1 | 2 };
  /** "Join several videos" (absent: one video, as before). */
  join?: DraftJoin;
}

/** "Join several videos" as the form holds it (screens/new-project-wizard/join-videos). */
export interface DraftJoin {
  /** The form joins several videos into one project instead of dubbing one. */
  on: boolean;
  /** The files, in the order they play. */
  paths: string[];
  /** The user agreed to encode the picture again (asked only when the files differ). */
  reencode: boolean;
}

/**
 * The New project form, kept while the user is on another screen.
 *
 * The form's state lived in the wizard component alone, so any navigation
 * threw it away: opening "Listen to and compare every voice" from the form and
 * coming back gave a blank form, video, languages, engines and voice gone. The
 * wizard leaves its draft here when it closes and takes it back when it opens.
 * The first version kept only the name, video and settings, so the form's own
 * Voices and Settings links still lost "Split into parts" and the chosen
 * preset with its folder (UX audit, 2026-11-21): the draft holds every field
 * the form shows.
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
