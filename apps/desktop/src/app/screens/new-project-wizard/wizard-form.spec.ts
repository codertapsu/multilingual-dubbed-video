import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import type { ProjectSettings } from '../../core/models';
import {
  DEFAULT_SERIES,
  continueBlocker,
  draftOf,
  draftOnLeave,
  draftSnapshot,
  leaveWarningFor,
  seriesRequestOf,
  type DraftForm,
  type LeaveState,
} from './wizard-form';

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Tree)[part] : undefined), tree);
}

const settings = { sourceLanguage: 'en-US', targetLanguage: 'vi-VN' } as ProjectSettings;

const form = (over: Partial<DraftForm> = {}): DraftForm => ({
  name: 'Clip',
  autoName: 'Clip',
  inputVideoPath: 'D:\\Videos\\Clip.mp4',
  settings,
  series: DEFAULT_SERIES,
  presetId: '',
  presetName: '',
  presetOutputDir: undefined,
  moreOptions: false,
  step: 1,
  projectId: null,
  createdFromVideo: null,
  ...over,
});

describe('draftOf', () => {
  // The form's own Voices and Settings links lost these (UX audit, 2026-11-21).
  it('keeps "Split into parts", the chosen preset and the folder it saves to', () => {
    const series = { split: true, length: 'custom' as const, min: 25, max: 35, ai: 'anthropic-translate', recapSec: 6, autoStart: true };
    const draft = draftOf(form({ series, presetId: 'p1', presetName: 'Channel', presetOutputDir: 'E:\\Dubs', moreOptions: true }));
    expect(draft.series).toEqual(series);
    expect(draft.preset).toEqual({ id: 'p1', name: 'Channel', outputDir: 'E:\\Dubs' });
    expect(draft.moreOptions).toBe(true);
  });

  it('ties the draft to the project Continue made, on the step it was left', () => {
    expect(draftOf(form()).created).toBeUndefined();
    expect(draftOf(form({ projectId: 'proj_1', createdFromVideo: 'D:\\Videos\\Clip.mp4', step: 2 })).created).toEqual({
      projectId: 'proj_1',
      fromVideo: 'D:\\Videos\\Clip.mp4',
      step: 2,
    });
  });

  it('copies the series, so later edits to the form do not reach the draft', () => {
    const series = { ...DEFAULT_SERIES };
    const draft = draftOf(form({ series }));
    series.split = true;
    expect(draft.series.split).toBe(false);
  });
});

describe('draftSnapshot', () => {
  it('does not count opening More options as touching the form', () => {
    expect(draftSnapshot(draftOf(form({ moreOptions: true })))).toBe(draftSnapshot(draftOf(form())));
  });

  it('ignores the AI for the cuts while the video is not split (it arrives after the defaults)', () => {
    const later = draftOf(form({ series: { ...DEFAULT_SERIES, ai: 'gemini-translate' } }));
    expect(draftSnapshot(later)).toBe(draftSnapshot(draftOf(form())));
  });

  it('sees a split, a preset and a new video', () => {
    const base = draftSnapshot(draftOf(form()));
    expect(draftSnapshot(draftOf(form({ series: { ...DEFAULT_SERIES, split: true } })))).not.toBe(base);
    expect(draftSnapshot(draftOf(form({ presetId: 'p1' })))).not.toBe(base);
    expect(draftSnapshot(draftOf(form({ inputVideoPath: 'D:\\Videos\\Other.mp4' })))).not.toBe(base);
  });
});

describe('draftOnLeave', () => {
  const state = (over: Partial<LeaveState> = {}): LeaveState => ({
    initialized: true,
    step: 1,
    creating: false,
    createdProjectId: null,
    touched: true,
    returning: false,
    ...over,
  });

  it('keeps a touched form and forgets an untouched one', () => {
    expect(draftOnLeave(state())).toBe('keep');
    expect(draftOnLeave(state({ touched: false }))).toBe('forget');
  });

  it('leaves the draft alone before the defaults are in', () => {
    expect(draftOnLeave(state({ initialized: false }))).toBe('nothing');
  });

  // Keeping it here let the finished copy clear it, or a restored copy make a
  // second project of the same video.
  it('decides nothing while Continue is making the project', () => {
    expect(draftOnLeave(state({ creating: true }))).toBe('nothing');
    expect(draftOnLeave(state({ creating: true, createdProjectId: 'proj_1' }))).toBe('nothing');
  });

  it('keeps the form of a project made by Continue after Back, touched or not, so Continue revises it', () => {
    expect(draftOnLeave(state({ createdProjectId: 'proj_1', touched: false }))).toBe('keep');
  });

  it('keeps step 2 only for a round trip through a link of the form (Add key)', () => {
    expect(draftOnLeave(state({ step: 2, createdProjectId: 'proj_1' }))).toBe('nothing');
    expect(draftOnLeave(state({ step: 2, createdProjectId: 'proj_1', returning: true }))).toBe('keep');
  });
});

describe('seriesRequestOf', () => {
  it('asks for no series while the video is not split, or no AI can choose the cuts', () => {
    expect(seriesRequestOf(DEFAULT_SERIES)).toBeUndefined();
    expect(seriesRequestOf({ ...DEFAULT_SERIES, split: true, ai: '' })).toBeUndefined();
  });

  it('reads a preset length, and never lets the longest part be shorter than the shortest', () => {
    const on = { ...DEFAULT_SERIES, split: true, ai: 'anthropic-translate' };
    expect(seriesRequestOf({ ...on, length: '30-40' })).toEqual({
      minMinutes: 30,
      maxMinutes: 40,
      aiProviderId: 'anthropic-translate',
      recapSec: 4,
      autoStart: false,
    });
    expect(seriesRequestOf({ ...on, length: 'custom', min: 40, max: 20 })).toMatchObject({ minMinutes: 40, maxMinutes: 40 });
  });
});

describe('continueBlocker', () => {
  const f = { videoPath: 'D:\\a.mp4', sourceLanguage: 'en-US', targetLanguage: 'vi-VN', voiceDownloading: false };

  it('names the first thing missing, in the order the form asks for it', () => {
    expect(continueBlocker({ ...f, videoPath: '  ', sourceLanguage: '' })).toBe('video');
    expect(continueBlocker({ ...f, sourceLanguage: '' })).toBe('languages');
    expect(continueBlocker({ ...f, voiceDownloading: true })).toBe('voice');
    expect(continueBlocker(f)).toBeNull();
  });
});

describe('leaveWarningFor', () => {
  it('asks while the project is made or a model downloads, never when the form itself leaves', () => {
    expect(leaveWarningFor({ creating: false, pulling: false, leavingOnPurpose: false })).toBeNull();
    expect(leaveWarningFor({ creating: true, pulling: false, leavingOnPurpose: false })?.title).toBe('wizard.leave.creating-title');
    expect(leaveWarningFor({ creating: false, pulling: true, leavingOnPurpose: false })?.title).toBe('wizard.leave.pulling-title');
    expect(leaveWarningFor({ creating: true, pulling: true, leavingOnPurpose: true })).toBeNull();
  });

  it('asks in words both locales have', () => {
    for (const w of [
      leaveWarningFor({ creating: true, pulling: false, leavingOnPurpose: false }),
      leaveWarningFor({ creating: false, pulling: true, leavingOnPurpose: false }),
    ]) {
      for (const key of Object.values(w ?? {})) {
        expect(typeof lookup(en as Tree, key), `en ${key}`).toBe('string');
        expect(typeof lookup(vi as Tree, key), `vi ${key}`).toBe('string');
      }
    }
  });
});
