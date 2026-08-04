import { describe, it, expect } from 'vitest';
import * as shared from './index.js';

/**
 * Barrel smoke test: ensures the public API surface is exported and wired up.
 */
describe('@videodubber/shared public API', () => {
  it('exports subtitle helpers', () => {
    expect(typeof shared.toSrtTimestamp).toBe('function');
    expect(typeof shared.toVttTimestamp).toBe('function');
    expect(typeof shared.splitSubtitleLines).toBe('function');
    expect(typeof shared.segmentsToSrt).toBe('function');
    expect(typeof shared.segmentsToVtt).toBe('function');
    expect(typeof shared.transcriptSegmentsToCues).toBe('function');
  });

  it('exports language helpers and COMMON_LANGUAGES', () => {
    expect(typeof shared.normalizeLanguageCode).toBe('function');
    expect(typeof shared.toWhisperLanguage).toBe('function');
    expect(typeof shared.toArgosLanguage).toBe('function');
    expect(typeof shared.isValidLanguageCode).toBe('function');
    expect(Array.isArray(shared.COMMON_LANGUAGES)).toBe(true);
  });

  it('exports pipeline helpers', () => {
    expect(Array.isArray(shared.PIPELINE_STEP_DEFS)).toBe(true);
    expect(typeof shared.createInitialPipelineState).toBe('function');
    expect(typeof shared.setStepStatus).toBe('function');
  });

  it('exports the error model', () => {
    expect(typeof shared.toAppError).toBe('function');
    expect(typeof shared.makeAppError).toBe('function');
    expect(typeof shared.AppErrorException).toBe('function');
    expect(shared.REMEDIATIONS.UNKNOWN).toBeDefined();
  });

  it('end-to-end: transcript -> cues -> srt/vtt', () => {
    const cues = shared.transcriptSegmentsToCues([
      {
        id: 'seg_0001',
        index: 0,
        startMs: 0,
        endMs: 1500,
        sourceText: 'Hello',
        translatedText: 'Xin chào',
      },
    ]);
    const srt = shared.segmentsToSrt(cues);
    const vtt = shared.segmentsToVtt(cues);
    expect(srt).toContain('Xin chào');
    expect(srt).toContain('00:00:00,000 --> 00:00:01,500');
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('Xin chào');
  });
  it('exports the NVIDIA driver gate helpers', () => {
    expect(typeof shared.compareDriverVersions).toBe('function');
    expect(typeof shared.outdatedNvidiaDriver).toBe('function');
    expect(shared.NVIDIA_GPU_RE).toBeInstanceOf(RegExp);
  });
});

/**
 * The comparator decides whether a user is told to update a driver or to buy
 * RAM, so it is pinned rather than smoke-tested. Numbers come from a real
 * failure: a GTX 1650 aborted every CUDA run on driver 546.29 and served the
 * byte-for-byte identical allocation on 610.88.
 */
describe('NVIDIA driver comparison', () => {
  const gtx = (driverVersion?: string) => [
    { name: 'NVIDIA GeForce GTX 1650', ...(driverVersion ? { driverVersion } : {}) },
  ];
  const pack = { minNvidiaDriver: '551.61' };

  it('compares segment-wise and numerically, not lexicographically', () => {
    expect(shared.compareDriverVersions('546.29', '551.61')).toBeLessThan(0);
    expect(shared.compareDriverVersions('610.88', '551.61')).toBeGreaterThan(0);
    expect(shared.compareDriverVersions('551.61', '551.61')).toBe(0);
    // "9" > "5" as a string; 9 < 551 as a number. This is the trap.
    expect(shared.compareDriverVersions('9.99', '551.61')).toBeLessThan(0);
    // Linux drivers carry a third segment; a missing one counts as 0.
    expect(shared.compareDriverVersions('550.54.14', '550.54')).toBeGreaterThan(0);
    expect(shared.compareDriverVersions('551.61.02', '551.61')).toBeGreaterThan(0);
  });

  it('reports the driver only when it is genuinely too old', () => {
    expect(shared.outdatedNvidiaDriver(pack, gtx('546.29'))).toBe('546.29');
    expect(shared.outdatedNvidiaDriver(pack, gtx('551.60'))).toBe('551.60');
    expect(shared.outdatedNvidiaDriver(pack, gtx('551.61'))).toBeUndefined();
    expect(shared.outdatedNvidiaDriver(pack, gtx('610.88'))).toBeUndefined();
  });

  it('fails open on anything it cannot establish', () => {
    expect(shared.outdatedNvidiaDriver(pack, gtx(undefined))).toBeUndefined();
    expect(shared.outdatedNvidiaDriver(pack, gtx(''))).toBeUndefined();
    expect(shared.outdatedNvidiaDriver(pack, [])).toBeUndefined();
    // Non-NVIDIA GPUs are not judged by an NVIDIA driver floor...
    expect(shared.outdatedNvidiaDriver(pack, [{ name: 'AMD Radeon RX 7900', driverVersion: '1.0' }])).toBeUndefined();
    // ...nor is a pack that declares no floor.
    expect(shared.outdatedNvidiaDriver({}, gtx('546.29'))).toBeUndefined();
  });

  it('passes when ANY installed NVIDIA GPU is new enough, and names the newest when none is', () => {
    const mixed = [
      { name: 'NVIDIA GeForce GTX 1650', driverVersion: '546.29' },
      { name: 'NVIDIA RTX 4070', driverVersion: '560.00' },
    ];
    // CUDA picks one device and llama.cpp takes the best, so one is enough.
    expect(shared.outdatedNvidiaDriver(pack, mixed)).toBeUndefined();
    const bothOld = [
      { name: 'NVIDIA GeForce GTX 1650', driverVersion: '546.29' },
      { name: 'NVIDIA GeForce GTX 1060', driverVersion: '540.00' },
    ];
    // Name the one the runtime would actually use.
    expect(shared.outdatedNvidiaDriver(pack, bothOld)).toBe('546.29');
  });
});

/**
 * The desktop app has no test runner ("ui tests optional in MVP"), so the
 * What's-New decision lives here rather than in the component — its edge cases
 * are exactly the ones that would ship unnoticed.
 */
describe('update notice', () => {
  const info = (o: Record<string, unknown> = {}) => ({
    available: true, version: '0.7.1', currentVersion: '0.7.0', notes: 'What changed', ...o,
  });

  it('says nothing when there is no update', () => {
    expect(shared.updateNoticeFor(info({ available: false }), { autoUpdate: false })).toEqual({ kind: 'none' });
    expect(shared.updateNoticeFor(info({ available: false }), { autoUpdate: true })).toEqual({ kind: 'none' });
  });

  it('shows STATUS, not a choice, when auto-update is on', () => {
    // The background task at launch is already installing; an Install button
    // here would race it.
    expect(shared.updateNoticeFor(info(), { autoUpdate: true })).toEqual({
      kind: 'auto-installing', version: '0.7.1', notes: 'What changed',
    });
  });

  it('offers the choice when auto-update is off', () => {
    expect(shared.updateNoticeFor(info({ date: '2026-08-04' }), { autoUpdate: false })).toEqual({
      kind: 'available', version: '0.7.1', notes: 'What changed', date: '2026-08-04',
    });
  });

  it('remembers a dismissal per VERSION, and a new release re-opens it', () => {
    expect(shared.updateNoticeFor(info(), { autoUpdate: false, dismissedVersion: '0.7.1' })).toEqual({ kind: 'none' });
    expect(shared.updateNoticeFor(info(), { autoUpdate: false, dismissedVersion: '0.7.0' }).kind).toBe('available');
  });

  it('never suppresses the auto-installing status', () => {
    // The app is about to restart underneath the user — worth saying every time,
    // dismissal or not.
    expect(
      shared.updateNoticeFor(info(), { autoUpdate: true, dismissedVersion: '0.7.1' }).kind,
    ).toBe('auto-installing');
  });

  it('never offers an install for an update this OS cannot run', () => {
    // check_for_update reports available:false WITH notes to explain why the
    // host is too old. Rendering an Install button from those notes would hand
    // the user a way to replace a working app with one that cannot launch.
    const tooOld = { available: false, notes: 'A newer version is available, but macOS 13.5 is required.' };
    expect(shared.updateNoticeFor(tooOld, { autoUpdate: false })).toEqual({ kind: 'none' });
    expect(shared.updateNoticeFor(tooOld, { autoUpdate: true })).toEqual({ kind: 'none' });
  });

  it('says nothing when the check omits a version', () => {
    expect(shared.updateNoticeFor({ available: true }, { autoUpdate: false })).toEqual({ kind: 'none' });
  });

  it('omits absent optional fields rather than emitting undefined keys', () => {
    const n = shared.updateNoticeFor({ available: true, version: '1.0.0' }, { autoUpdate: false });
    expect(n).toEqual({ kind: 'available', version: '1.0.0' });
    expect('notes' in n).toBe(false);
  });
});

