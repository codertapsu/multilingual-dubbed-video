import { Injectable } from '@angular/core';

import type { LanguageCode } from '../../core/models';

/** The choices the welcome screen's download was started with. */
export interface OnboardingChoices {
  sourceLanguage: LanguageCode;
  targetLanguage: LanguageCode;
  whisperModel: string;
  fetchPiperVoice: boolean;
  selectedVoiceId: string;
}

/**
 * The welcome screen's download, remembered while the user is elsewhere.
 *
 * The top navigation stays live during setup, and leaving step 4 and coming
 * back started the wizard over at step 1 with no sign of the download still
 * running (UX audit, 2026-11-21); Finish would then have saved the default
 * speech model as the user's choice instead of the one being downloaded. The
 * screen keeps its choices here when the download starts, reopens on step 4
 * while they are kept, and forgets them at Finish or Skip.
 *
 * In memory for the app session: the download stops with the app anyway.
 */
@Injectable({ providedIn: 'root' })
export class OnboardingSessionService {
  private choices: OnboardingChoices | null = null;

  keep(choices: OnboardingChoices): void {
    this.choices = { ...choices };
  }

  /** The kept choices, or null when no download was started (or it was finished with). */
  get(): OnboardingChoices | null {
    return this.choices ? { ...this.choices } : null;
  }

  clear(): void {
    this.choices = null;
  }
}
