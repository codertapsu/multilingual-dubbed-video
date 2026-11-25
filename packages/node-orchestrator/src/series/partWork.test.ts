import { describe, expect, it } from 'vitest';

import { changesOnlyMixAndRender, partRedoAction, partSkipReason, seriesRedoRefusal } from './partWork.js';

describe('a change asked of a whole series', () => {
  it('says why a part kept its settings, a waiting one included', () => {
    expect(partSkipReason('queued')).toMatch(/^waiting in the queue, and this change is not only to its mix or render/);
    expect(partSkipReason('running')).toMatch(/^dubbing now/);
    expect(partSkipReason('detecting')).toMatch(/speakers are being detected/);
    expect(partSkipReason(undefined)).toMatch(/^busy with a job/);
  });

  it('lets a waiting part take a change to its mix or render only', () => {
    // The user's change for the 48 parts: the watermark blurred and a new greeting.
    expect(changesOnlyMixAndRender({ blurRegions: [], branding: {} })).toBe(true);
    expect(changesOnlyMixAndRender({ burnSubtitleStyle: { coverOriginal: 'blur' }, songSubtitles: true, renderQuality: 'auto' })).toBe(true);
    // An engine is what the queue classified the part by.
    expect(changesOnlyMixAndRender({ blurRegions: [], ttsProviderId: 'vieneu' })).toBe(false);
    expect(changesOnlyMixAndRender({ originalAudioMode: 'replace-vocals' })).toBe(false);
    expect(changesOnlyMixAndRender({})).toBe(false);
  });

  it('redoes the mix or render across a series, refuses the costly steps, leaves the parent\'s own alone', () => {
    expect(seriesRedoRefusal('audio-mix', 48)).toBeUndefined();
    expect(seriesRedoRefusal('render', 48)).toBeUndefined();
    const refused = seriesRedoRefusal('translation', 48);
    expect(refused?.code).toBe('INVALID_EDIT');
    expect(refused?.message).toContain('series of 48 part(s)');
    expect(refused?.appError.remediation).toContain('start_dubbing on each part');
    expect(seriesRedoRefusal('tts', 48)?.code).toBe('INVALID_EDIT');
    expect(seriesRedoRefusal('stt', 48)).toBeUndefined();
    expect(seriesRedoRefusal('translation', 0)).toBeUndefined();
  });

  it('redoes a part that made the step, and says why it leaves the others', () => {
    expect(partRedoAction('audio-mix', 'completed', undefined)).toEqual({ redo: true });
    expect(partRedoAction('audio-mix', 'pending', undefined)).toEqual({ redo: false, reason: 'has not made "audio-mix" yet: it uses the change when it gets there' });
    expect(partRedoAction('render', undefined, undefined)).toMatchObject({ redo: false });
    expect(partRedoAction('render', 'completed', { work: 'queued' })).toEqual({ redo: false, reason: 'waiting in the queue: it uses the change when it gets there' });
    expect(partRedoAction('render', 'completed', { work: 'running' })).toEqual({ redo: false, reason: 'dubbing now: pause it (or the series), then redo it' });
  });
});
