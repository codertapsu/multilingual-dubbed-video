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
  isNamedFolder,
  leaveWarningFor,
  presetSeriesOf,
  presetSplitsOver,
  seriesDraftFromPreset,
  seriesLengthOf,
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

  it('sends a part name template, the series it continues and a total only when set', () => {
    const on = { ...DEFAULT_SERIES, split: true, ai: 'anthropic-translate' };
    expect(seriesRequestOf({ ...on, nameTemplate: ' {series} - Tập {nn} ', continues: 'proj_s1', total: 60 })).toMatchObject({
      nameTemplate: '{series} - Tập {nn}',
      continues: 'proj_s1',
      totalParts: 60,
    });
    const plain = seriesRequestOf({ ...on, nameTemplate: '  ', continues: '', total: 0 })!;
    expect(['nameTemplate', 'continues', 'totalParts'].some((k) => k in plain)).toBe(false);
    // A draft kept before these fields existed.
    const { nameTemplate: _t, continues: _c, total: _n, ...old } = on;
    expect(seriesRequestOf(old)).toEqual(seriesRequestOf({ ...on }));
  });
});

describe('a preset’s series of parts in the form', () => {
  const block = { minMinutes: 30, maxMinutes: 40, aiProviderId: 'anthropic', recapSec: 2, autoStart: true, nameTemplate: '{series} - Phần {n} - {title}' };

  it('fills the choices from the preset, leaving this video’s split as it was', () => {
    const filled = seriesDraftFromPreset(DEFAULT_SERIES, block, ['anthropic-translate']);
    expect(filled).toEqual({
      ...DEFAULT_SERIES,
      length: '30-40',
      min: 30,
      max: 40,
      ai: 'anthropic-translate',
      recapSec: 2,
      autoStart: true,
      nameTemplate: '{series} - Phần {n} - {title}',
    });
    expect(filled.split).toBe(false);
    // An AI not set up here leaves the form's choice; odd lengths are the custom ones.
    expect(seriesDraftFromPreset({ ...DEFAULT_SERIES, ai: 'openai-translate' }, { ...block, minMinutes: 25 }, [])).toMatchObject({
      ai: 'openai-translate',
      length: 'custom',
      min: 25,
      max: 40,
    });
    expect(seriesLengthOf(55, 65)).toBe('55-65');
  });

  it('saves the form’s series when it splits, else keeps the preset’s own', () => {
    const kept = { ...block, longerThanMinutes: 90 };
    expect(presetSeriesOf(DEFAULT_SERIES, kept)).toBe(kept);
    expect(presetSeriesOf(DEFAULT_SERIES, undefined)).toBeUndefined();
    const on = { ...DEFAULT_SERIES, split: true, ai: 'gemini-translate', length: '15-20' as const, continues: 'proj_s1', total: 60 };
    expect(presetSeriesOf(on, kept)).toEqual({ minMinutes: 15, maxMinutes: 20, aiProviderId: 'gemini-translate', recapSec: 4, autoStart: false, longerThanMinutes: 90 });
  });

  it('says when a preset splits a video, and when its folder is named after each project', () => {
    expect(presetSplitsOver(block)).toBe(60);
    expect(presetSplitsOver({ longerThanMinutes: 45.4 })).toBe(45);
    expect(presetSplitsOver({})).toBe(30);
    expect(isNamedFolder(String.raw`D:\Dubs\{series}`)).toBe(true);
    expect(isNamedFolder('/Dubs/{Name}')).toBe(true);
    expect(isNamedFolder(String.raw`D:\Dubs`)).toBe(false);
    expect(isNamedFolder(null)).toBe(false);
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

  it('waits for the AI that plans the parts when the video is to be split: none is picked for the user', () => {
    expect(continueBlocker({ ...f, seriesWithoutAi: true })).toBe('series-ai');
    expect(continueBlocker({ ...f, seriesWithoutAi: false })).toBeNull();
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
