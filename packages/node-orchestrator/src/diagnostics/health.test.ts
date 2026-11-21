import { mkdtempSync, existsSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { HealthMonitor, sampleOf, takeRecoveredCrash } from './health.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('health', () => {
  it('turns Node figures into a sample in MB and ms', () => {
    const s = sampleOf(
      { rss: 512 * 1024 * 1024, heapUsed: 100 * 1024 * 1024, heapTotal: 150 * 1024 * 1024, external: 10 * 1024 * 1024, arrayBuffers: 5 * 1024 * 1024 },
      { p99Ns: 12_500_000, maxNs: 1_500_000_000 },
      0.42,
      new Date('2026-11-21T04:51:00Z'),
    );
    expect(s).toEqual({
      at: '2026-11-21T04:51:00.000Z',
      rssMb: 512,
      heapUsedMb: 100,
      heapTotalMb: 150,
      externalMb: 10,
      arrayBuffersMb: 5,
      lagP99Ms: 12.5,
      lagMaxMs: 1500,
      freeRamShare: 0.42,
    });
  });

  it('keeps the last samples and the peaks, and warns on a stall', () => {
    const warnings: string[] = [];
    const m = new HealthMonitor({ keep: 2, logger: { info: () => undefined, warn: (w) => warnings.push(w) } });
    m.tick(new Date('2026-11-21T00:00:00Z'));
    m.tick(new Date('2026-11-21T00:01:00Z'));
    m.tick(new Date('2026-11-21T00:02:00Z'));
    expect(m.samples().map((s) => s.at)).toEqual(['2026-11-21T00:01:00.000Z', '2026-11-21T00:02:00.000Z']);
    expect(m.peak().rssMb).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
  });

  it('reads the crash the shell restarted it after, once', () => {
    const logs = mkdtempSync(path.join(os.tmpdir(), 'vd-health-'));
    dirs.push(logs);
    expect(takeRecoveredCrash(logs)).toBeUndefined();
    writeFileSync(
      path.join(logs, 'backend-crash.json'),
      JSON.stringify({ at: '2026-11-21T04:51:00Z', code: -1073740791, codeHex: '0xC0000409', meaning: 'fast-fail', uptimeSec: 66_444 }),
    );
    expect(takeRecoveredCrash(logs)).toEqual({ at: '2026-11-21T04:51:00Z', code: -1073740791, codeHex: '0xC0000409', meaning: 'fast-fail', uptimeSec: 66_444 });
    expect(existsSync(path.join(logs, 'backend-crash.json'))).toBe(false);
    expect(readdirSync(path.join(logs, 'crash'))).toHaveLength(1);
    expect(takeRecoveredCrash(logs)).toBeUndefined();
  });
});
