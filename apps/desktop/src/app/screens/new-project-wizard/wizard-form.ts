/**
 * The New project form's decisions that need no Angular: what leaving does to
 * its draft, why Continue is not available yet, what to ask before leaving
 * while it works, and the series part of the create request. Pure, so
 * wizard-form.spec.ts can hold each rule to the incident that made it.
 */
import { seriesAiId, type PresetSeries } from '@videodubber/shared';

import type { CreateProjectInput, ProjectSettings } from '../../core/models';
import type { DraftJoin, DraftSeries, DraftSeriesLength, NewProjectDraft } from '../../core/state/new-project-draft.service';

/** Everything the form shows, as plain values. */
export interface DraftForm {
  name: string;
  autoName: string;
  inputVideoPath: string;
  settings: ProjectSettings;
  series: DraftSeries;
  presetId: string;
  presetName: string;
  /** The folder the chosen preset saves finished videos to. */
  presetOutputDir: string | undefined;
  moreOptions: boolean;
  step: 1 | 2;
  /** The project Continue made, while it has not started. */
  projectId: string | null;
  /** The video that project holds a copy of. */
  createdFromVideo: string | null;
  /** "Join several videos" (join-videos/); absent or off: one video. */
  join?: DraftJoin;
}

/**
 * The draft that brings the form back as it was. Every field the form shows
 * is in it: the first draft kept only the name, video and settings, so the
 * form's own Voices and Settings links lost "Split into parts" and the chosen
 * preset with its folder (UX audit, 2026-11-21).
 */
export function draftOf(f: DraftForm): NewProjectDraft {
  return {
    name: f.name,
    autoName: f.autoName,
    inputVideoPath: f.inputVideoPath,
    settings: f.settings,
    series: { ...f.series },
    preset: { id: f.presetId, name: f.presetName, ...(f.presetOutputDir ? { outputDir: f.presetOutputDir } : {}) },
    moreOptions: f.moreOptions,
    ...(f.projectId ? { created: { projectId: f.projectId, fromVideo: f.createdFromVideo ?? '', step: f.step } } : {}),
    // Only once the user turned it on or listed files: an untouched form stays untouched.
    ...(f.join && (f.join.on || f.join.paths.length > 0) ? { join: { ...f.join, paths: [...f.join.paths] } } : {}),
  };
}

/** "Split into parts" as a new form starts: off, 15-20 minute parts. */
export const DEFAULT_SERIES: DraftSeries = {
  split: false,
  length: '15-20',
  min: 15,
  max: 20,
  ai: '',
  recapSec: 4,
  autoStart: false,
  nameTemplate: '',
  continues: '',
  total: 0,
};

/**
 * The series settings Continue sends, or undefined when the video is not
 * split. A part name template, the series it continues and a total only when
 * set: without them a series is named and numbered as it always was.
 */
export function seriesRequestOf(s: DraftSeries): CreateProjectInput['series'] | undefined {
  if (!s.split || !s.ai) return undefined;
  const [min = s.min, max = s.max] = s.length === 'custom' ? [s.min, s.max] : s.length.split('-').map(Number);
  const nameTemplate = s.nameTemplate?.trim();
  const total = Math.floor(Number(s.total) || 0);
  return {
    minMinutes: min,
    maxMinutes: Math.max(min, max),
    aiProviderId: s.ai,
    recapSec: s.recapSec,
    autoStart: s.autoStart,
    ...(nameTemplate ? { nameTemplate } : {}),
    ...(s.continues ? { continues: s.continues } : {}),
    ...(total > 0 ? { totalParts: total } : {}),
    ...(s.perFile ? { perFile: true } : {}),
  };
}

/** The part length the form offers for these minutes ('custom' when it offers none). Pure. */
export function seriesLengthOf(min: number, max: number): DraftSeriesLength {
  const key = `${min}-${max}`;
  return key === '15-20' || key === '30-40' || key === '55-65' ? key : 'custom';
}

/**
 * "Split into parts" filled from a preset's series block: its part length,
 * its AI (while set up here: `readyAi`), recap, start and part names. Whether
 * THIS video is split stays as it was: the preset splits only videos longer
 * than its threshold, and the form does not know the video's length before
 * the project is made. Pure.
 */
export function seriesDraftFromPreset(current: DraftSeries, block: PresetSeries, readyAi: readonly string[]): DraftSeries {
  const min = block.minMinutes ?? current.min;
  const max = Math.max(min, block.maxMinutes ?? current.max);
  const ai = block.aiProviderId ? seriesAiId(block.aiProviderId) : '';
  return {
    ...current,
    length: seriesLengthOf(min, max),
    min,
    max,
    ai: ai && readyAi.includes(ai) ? ai : current.ai,
    recapSec: block.recapSec ?? current.recapSec,
    autoStart: block.autoStart ?? current.autoStart,
    nameTemplate: block.nameTemplate ?? current.nameTemplate ?? '',
  };
}

/**
 * The series block a preset saved from the form keeps: the form's when it
 * splits this video, else `kept` (the preset's own), never dropped because one
 * short video had Split into parts off. A series it continues and a total are
 * this video's, not the preset's. Pure.
 */
export function presetSeriesOf(draft: DraftSeries, kept: PresetSeries | undefined): PresetSeries | undefined {
  const asked = seriesRequestOf(draft);
  if (!asked) return kept;
  return {
    minMinutes: asked.minMinutes,
    maxMinutes: asked.maxMinutes,
    aiProviderId: asked.aiProviderId,
    recapSec: asked.recapSec,
    autoStart: asked.autoStart,
    ...(asked.nameTemplate ? { nameTemplate: asked.nameTemplate } : {}),
    ...(kept?.longerThanMinutes !== undefined ? { longerThanMinutes: kept.longerThanMinutes } : {}),
  };
}

/** The length, in minutes, over which a preset's series block splits a video (1.5 x its longest part by default). Pure. */
export function presetSplitsOver(block: PresetSeries): number {
  return Math.round(block.longerThanMinutes ?? (block.maxMinutes ?? DEFAULT_SERIES.max) * 1.5);
}

/** A save folder named after each project ("D:\\Dubs\\{series}"). Pure. */
export function isNamedFolder(dir: string | null | undefined): boolean {
  return /\{(series|name)\}/i.test(dir ?? '');
}

/**
 * Why Continue is not available yet, said beside it. A disabled button below
 * a long form, with the reason (an empty video field) at the top of it, was a
 * button that "did nothing" (UX audit, 2026-11-21).
 */
export type ContinueBlocker = 'video' | 'languages' | 'voice' | 'series-ai';

export function continueBlocker(f: {
  videoPath: string;
  sourceLanguage: string;
  targetLanguage: string;
  voiceDownloading: boolean;
  /** "Split into parts" is on without an AI chosen to plan the cuts. */
  seriesWithoutAi?: boolean;
}): ContinueBlocker | null {
  if (!f.videoPath.trim()) return 'video';
  // A preset saved without a source language leaves it empty.
  if (!f.sourceLanguage || !f.targetLanguage) return 'languages';
  if (f.voiceDownloading) return 'voice';
  // Split into parts with no AI chosen used to make a whole project, without a word.
  if (f.seriesWithoutAi) return 'series-ai';
  return null;
}

/** What the form is doing as the user leaves it. */
export interface LeaveState {
  /** Defaults applied: before that, the form holds nothing of the user's. */
  initialized: boolean;
  step: 1 | 2;
  /** Continue is making (or revising) the project right now. */
  creating: boolean;
  /** The project Continue made, while it has not started. */
  createdProjectId: string | null;
  /** The form differs from what the defaults gave it. */
  touched: boolean;
  /** The user left step 2 through one of the form's own links (Add key), to come back to it. */
  returning: boolean;
}

/**
 * What leaving does with the draft: keep the form for coming back, forget a
 * kept one, or leave it alone.
 *
 * - While Continue is making the project, nothing: the project will hold
 *   these choices, and what becomes of the form is decided when it is done.
 *   Keeping it here let the finished creation clear it under the user, or a
 *   restored copy make a second project and a second copy of the video.
 * - Step 2 only when the user went to fix something through the form's own
 *   link: it comes back to the project's step 2. Any other way out of step 2
 *   leaves the project in Projects, as before.
 * - Step 1 after Back keeps the form with its project, so Continue revises
 *   that project instead of making another.
 */
export function draftOnLeave(s: LeaveState): 'keep' | 'forget' | 'nothing' {
  if (!s.initialized || s.creating) return 'nothing';
  if (s.step === 2) return s.returning && s.createdProjectId ? 'keep' : 'nothing';
  if (s.createdProjectId) return 'keep';
  return s.touched ? 'keep' : 'forget';
}

/**
 * The choices that tell a form the user touched from one the defaults filled.
 * "More options" being open is not a choice: a draft kept for it alone would
 * freeze the engines, and a Settings change made meanwhile would not show.
 * Nor are the parts' settings while the video is not split: the AI that
 * chooses the cuts is filled in when the list of AIs arrives, which can be
 * after the defaults were.
 */
export function draftSnapshot(d: NewProjectDraft): string {
  return JSON.stringify({ ...d, series: d.series.split ? d.series : undefined, moreOptions: undefined, created: undefined });
}

/** The question to ask before leaving (translation keys). */
export interface LeaveWarning {
  title: string;
  message: string;
  leave: string;
  stay: string;
}

/**
 * What to ask before the user leaves the form now, or null when leaving is
 * fine. Leaving while Continue copied the video cleared the kept form or made
 * a second project; leaving while an Ollama model downloaded got the user
 * pulled back to the dub's screen from wherever they were.
 */
export function leaveWarningFor(s: { creating: boolean; pulling: boolean; leavingOnPurpose: boolean }): LeaveWarning | null {
  if (s.leavingOnPurpose) return null;
  if (s.creating) {
    return { title: 'wizard.leave.creating-title', message: 'wizard.leave.creating-body', leave: 'wizard.leave.go', stay: 'wizard.leave.stay' };
  }
  if (s.pulling) {
    return { title: 'wizard.leave.pulling-title', message: 'wizard.leave.pulling-body', leave: 'wizard.leave.go', stay: 'wizard.leave.stay' };
  }
  return null;
}
