import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config.js';
import { runPreflight, type PreflightDeps } from './preflight.js';

const config = loadConfig({
  configDir: '/tmp/vd-preflight',
  modelsDir: '/tmp/vd-preflight/models',
});

/** All-green dependency stubs. */
function okDeps(): PreflightDeps {
  return {
    probeBinary: async () => ({ available: true, detail: 'ffmpeg version 6.0' }),
    probeWorkerHealth: async () => ({ available: true, detail: 'ok' }),
    probeNetwork: async () => true,
    freeSpaceMb: async () => 50_000,
    // No retry in tests: an unreachable worker should fail fast, not block ~25s.
    workerReadyTimeoutMs: 0,
  };
}

describe('runPreflight', () => {
  it('returns ok=true with all checks passing', async () => {
    const result = await runPreflight(config, okDeps());
    expect(result.ok).toBe(true);
    const ids = result.checks.map((c) => c.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'ffmpeg',
        'ffprobe',
        'stt-worker',
        'translation-worker',
        'tts-worker',
        'network',
        'disk',
      ]),
    );
    expect(result.checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('marks a missing binary as fail and ok=false', async () => {
    const result = await runPreflight(config, {
      ...okDeps(),
      probeBinary: async (bin) =>
        bin.includes('ffprobe') ? { available: false, detail: 'not found' } : { available: true },
    });
    expect(result.ok).toBe(false);
    const ffprobe = result.checks.find((c) => c.id === 'ffprobe');
    expect(ffprobe?.status).toBe('fail');
    expect(ffprobe?.remediation).toBeDefined();
  });

  it('marks an unreachable worker as fail and ok=false', async () => {
    const result = await runPreflight(config, {
      ...okDeps(),
      probeWorkerHealth: async (_url, name) =>
        name.includes('STT') ? { available: false, detail: 'connection refused' } : { available: true },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === 'stt-worker')?.status).toBe('fail');
  });

  it('retries a still-booting worker and passes once it comes up', async () => {
    // Simulates the PyInstaller cold-start: STT is down on the first probe, then
    // up. With retry enabled it should resolve to "ok", not a transient "fail".
    let sttProbes = 0;
    const result = await runPreflight(config, {
      ...okDeps(),
      workerReadyTimeoutMs: 1000,
      workerPollIntervalMs: 10,
      probeWorkerHealth: async (_url, name) => {
        if (!name.includes('STT')) return { available: true, detail: 'ok' };
        sttProbes += 1;
        return sttProbes >= 2 ? { available: true, detail: 'ok' } : { available: false, detail: 'starting' };
      },
    });
    expect(result.checks.find((c) => c.id === 'stt-worker')?.status).toBe('ok');
    expect(sttProbes).toBeGreaterThanOrEqual(2);
    expect(result.ok).toBe(true);
  });

  it('treats no network as a warning (not a hard failure)', async () => {
    const result = await runPreflight(config, { ...okDeps(), probeNetwork: async () => false });
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.id === 'network')?.status).toBe('warn');
  });

  it('warns when free disk space is unknown', async () => {
    const result = await runPreflight(config, { ...okDeps(), freeSpaceMb: async () => undefined });
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.id === 'disk')?.status).toBe('warn');
  });

  it('warns when free disk space is low', async () => {
    const result = await runPreflight(config, { ...okDeps(), freeSpaceMb: async () => 100 });
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.id === 'disk')?.status).toBe('warn');
  });
});
