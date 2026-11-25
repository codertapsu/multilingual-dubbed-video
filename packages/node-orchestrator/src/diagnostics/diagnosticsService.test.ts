import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { DiagnosticsService, parseNvidiaSmi, redactHome } from './diagnosticsService.js';
import { StructuredLog } from './logFiles.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('diagnostics', () => {
  it('reads nvidia-smi and hides the home folder', () => {
    expect(parseNvidiaSmi('NVIDIA GeForce RTX 3050, 7712, 8192, 97\r\n')).toEqual([
      { name: 'NVIDIA GeForce RTX 3050', memoryUsedMb: 7712, memoryTotalMb: 8192, utilizationPct: 97 },
    ]);
    expect(parseNvidiaSmi('')).toBeNull();
    expect(redactHome('C:\\Users\\Admin\\VideoDubber\\logs and C:/Users/Admin/x', 'C:\\Users\\Admin')).toBe('~\\VideoDubber\\logs and ~/x');
  });

  it('sums disk per project, lists crash reports, and writes a support bundle', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vd-diag-'));
    dirs.push(root);
    const logs = path.join(root, 'logs');
    const p1 = path.join(root, 'projects', 'proj_a');
    mkdirSync(path.join(p1, 'audio'), { recursive: true });
    writeFileSync(path.join(p1, 'audio', 'original.wav'), Buffer.alloc(5000));
    mkdirSync(path.join(logs, 'crash'), { recursive: true });
    writeFileSync(path.join(logs, 'crash', 'backend-crash-2026-11-21T04-51-00Z.json'), '{"codeHex":"0xC0000409"}');
    mkdirSync(path.join(logs, 'engines'), { recursive: true });
    writeFileSync(path.join(logs, 'engines', 'diarization-sherpa.log'), 'Traceback (most recent call last):\n  MemoryError\n');
    const structured = new StructuredLog(logs);
    structured.write({ level: 'warn', msg: 'GPU busy', projectId: 'proj_a' });
    structured.write({ level: 'error', msg: 'Speaker detection failed', projectId: 'proj_a' });

    const svc = new DiagnosticsService({
      logsDir: logs,
      structured,
      health: () => ({ version: '0.17.0', startedAt: 'x', uptimeSec: 1, heapLimitMb: 4096, peak: { rssMb: 1, heapUsedMb: 1, lagMaxMs: 1 }, samples: [] }),
      queueState: () => Promise.reject(new Error('no queue in this test')),
      laneOwner: () => 'proj_a',
      runningEngines: () => [],
      unusableEngines: () => ['diarization-sherpa'],
      projectsDir: () => path.join(root, 'projects'),
      listProjects: async () => [{ id: 'proj_a', name: 'A', workspaceDir: p1 }],
      gpu: async () => null,
    });
    const s = await svc.summary();
    expect(s.disk.projects).toEqual([{ id: 'proj_a', name: 'A', bytes: 5000 }]);
    expect(s.crashes.map((c) => c.kind)).toEqual(['backend exit']);
    expect(s.engines.lastOutput['diarization-sherpa']).toContain('MemoryError');
    expect(s.laneOwner).toBe('proj_a');
    expect(s.recent.errors.map((r) => r.msg)).toEqual(['Speaker detection failed']);

    const bundle = await svc.bundle(new Date('2026-11-21T05:00:00Z'));
    expect(bundle.path).toContain(path.join('logs', 'support'));
    const zip = readFileSync(bundle.path);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.includes(Buffer.from('logs/engines/diarization-sherpa.log'))).toBe(true);
    expect(zip.includes(Buffer.from('crash/backend-crash-2026-11-21T04-51-00Z.json'))).toBe(true);
  });

  it('lists every measured audio drift, the largest first, under the warning too', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vd-diag-'));
    dirs.push(root);
    const drift = (driftMs: number) => ({ mediaInfo: { audioDrift: { driftMs, audioMs: 0, pictureMs: 0, method: 'packets' as const, measuredAt: 't' } } });
    const svc = new DiagnosticsService({
      logsDir: path.join(root, 'logs'),
      structured: new StructuredLog(path.join(root, 'logs')),
      health: () => ({ version: '0.18.1', startedAt: 'x', uptimeSec: 1, heapLimitMb: 4096, peak: { rssMb: 1, heapUsedMb: 1, lagMaxMs: 1 }, samples: [] }),
      queueState: () => Promise.reject(new Error('no queue in this test')),
      laneOwner: () => undefined,
      runningEngines: () => [],
      unusableEngines: () => [],
      projectsDir: () => path.join(root, 'projects'),
      listProjects: async () => [
        { id: 'p1', name: 'P1', workspaceDir: path.join(root, 'p1'), ...drift(560) },
        { id: 'p3', name: 'P3', workspaceDir: path.join(root, 'p3'), ...drift(20) },
        { id: 'p4', name: 'P4', workspaceDir: path.join(root, 'p4'), ...drift(4810) },
        { id: 'new', name: 'Not measured', workspaceDir: path.join(root, 'new') },
        { id: 'short', name: 'Ends early', workspaceDir: path.join(root, 'short'), ...drift(-900) },
      ],
      gpu: async () => null,
    });
    expect((await svc.summary()).audioDrift.map((a) => [a.id, a.driftMs])).toEqual([
      ['p4', 4810],
      ['short', -900],
      ['p1', 560],
      ['p3', 20],
    ]);
  });
});
