import { describe, expect, it } from 'vitest';
import { audioDriftView, spotCheckApplies, spotCheckOn } from './source-checks';

const drift = (driftMs: number) => ({ driftMs, audioMs: 1, pictureMs: 1, method: 'packets' as const, measuredAt: '2026-11-23T10:00:00.000Z' });

describe('source checks on screen', () => {
  it('the spot check: only for CJK speech; on above 2 hours unless the setting says', () => {
    expect(spotCheckApplies('zh-CN')).toBe(true);
    expect(spotCheckApplies('ja')).toBe(true);
    expect(spotCheckApplies('en-US')).toBe(false);
    expect(spotCheckApplies(undefined)).toBe(false);
    expect(spotCheckOn(undefined, 100_080_000)).toBe(true);
    expect(spotCheckOn(undefined, 7_200_000)).toBe(false);
    expect(spotCheckOn(false, 100_080_000)).toBe(false);
    expect(spotCheckOn(true, 600_000)).toBe(true);
    expect(spotCheckOn(undefined, undefined)).toBe(false);
  });

  it("the audio's drift: re-timed from 0.5 s longer, in step below, padded when it ends early", () => {
    expect(audioDriftView(drift(4810))).toEqual({ key: 'source-checks.drift-longer', params: { seconds: '4.8' }, retimed: true });
    expect(audioDriftView(drift(20))).toEqual({ key: 'source-checks.drift-match', params: { seconds: '+0.02' }, retimed: false });
    expect(audioDriftView(drift(-140))?.params.seconds).toBe('-0.14');
    expect(audioDriftView(drift(-1500))).toEqual({ key: 'source-checks.drift-shorter', params: { seconds: '1.5' }, retimed: false });
    expect(audioDriftView(undefined)).toBeUndefined();
  });
});
