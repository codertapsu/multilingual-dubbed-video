import { describe, expect, it } from 'vitest';

import { partSkipReason, seriesRedoRefusal } from './partWork.js';

describe('a change asked of a whole series', () => {
  it('says why a part kept its settings, a waiting one included', () => {
    expect(partSkipReason('queued')).toMatch(/^waiting in the queue: pause the series/);
    expect(partSkipReason('running')).toMatch(/^dubbing now/);
    expect(partSkipReason('detecting')).toMatch(/speakers are being detected/);
    expect(partSkipReason(undefined)).toMatch(/^busy with a job/);
  });

  it('refuses a redo of a part-only step on the parent once its parts exist, with the way to do it', () => {
    const refused = seriesRedoRefusal('audio-mix', 48);
    expect(refused?.code).toBe('INVALID_EDIT');
    expect(refused?.message).toContain('series of 48 part(s)');
    expect(refused?.appError.remediation).toContain('start_dubbing on the part');
    // The parent's own steps stay its own, and a series not split yet is a project like any other.
    expect(seriesRedoRefusal('stt', 48)).toBeUndefined();
    expect(seriesRedoRefusal('extract-audio', 48)).toBeUndefined();
    expect(seriesRedoRefusal('render', 0)).toBeUndefined();
  });
});
