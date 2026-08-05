import { beforeEach, describe, expect, it } from 'vitest';
import type { SystemProfile } from '@videodubber/shared';
import {
  detectGpus,
  parseNvidiaSmi,
  parseSystemProfiler,
  parseWindowsWmiGpus,
  recommendSetup,
  type ExecProbe,
} from './systemProfile.js';

function profile(overrides: Partial<SystemProfile> = {}): SystemProfile {
  return {
    platform: 'linux',
    arch: 'x64',
    cpuModel: 'Test CPU',
    cpuCores: 8,
    totalRamMb: 16 * 1024,
    freeRamMb: 8 * 1024,
    gpus: [],
    appleSilicon: false,
    ...overrides,
  };
}

describe('recommendSetup', () => {
  it('constrained machines get tiny + cloud suggestions for STT and translation', () => {
    const rec = recommendSetup(profile({ totalRamMb: 4 * 1024 }));
    expect(rec.tier).toBe('constrained');
    expect(rec.whisperModel).toBe('tiny');
    expect(rec.suggestCloud.stt).toBe(true);
    expect(rec.suggestCloud.translation).toBe(true);
    expect(rec.suggestCloud.tts).toBe(false);
  });

  it('8-16 GB machines get the balanced turbo model', () => {
    const rec = recommendSetup(profile({ totalRamMb: 8 * 1024 }));
    expect(rec.tier).toBe('balanced');
    expect(rec.whisperModel).toBe('large-v3-turbo');
    expect(rec.suggestCloud.stt).toBe(false);
  });

  it('16-32 GB machines get the performance turbo model', () => {
    expect(recommendSetup(profile({ totalRamMb: 24 * 1024 })).whisperModel).toBe('large-v3-turbo');
    const apple = recommendSetup(
      profile({ totalRamMb: 24 * 1024, platform: 'darwin', arch: 'arm64', appleSilicon: true }),
    );
    expect(apple.whisperModel).toBe('large-v3-turbo');
    expect(apple.tier).toBe('performance');
    // Apple Silicon should be nudged toward the Metal engine pack.
    expect(apple.reasons.map((r) => r.key)).toContain('reason.apple-metal');
  });

  it('32+ GB machines get the performance turbo model', () => {
    const rec = recommendSetup(profile({ totalRamMb: 64 * 1024 }));
    expect(rec.whisperModel).toBe('large-v3-turbo');
    expect(rec.tier).toBe('performance');
  });

  it('few CPU cores push STT toward cloud even with plenty of RAM', () => {
    const rec = recommendSetup(profile({ totalRamMb: 32 * 1024, cpuCores: 2 }));
    expect(rec.suggestCloud.stt).toBe(true);
    expect(rec.reasons.map((r) => r.key)).toContain('reason.slow-cpu');
  });

  it('mentions an NVIDIA GPU in the reasons when detected', () => {
    const rec = recommendSetup(
      profile({ gpus: [{ name: 'NVIDIA GeForce RTX 4070', vramMb: 12288 }] }),
    );
    // Assert the KEY and its params, not the prose: the sentence is now
    // translated, so matching on English would break the moment it is reworded.
    const nvidiaReason = rec.reasons.find((r) => r.key === 'reason.nvidia');
    expect(nvidiaReason).toBeDefined();
    expect(String(nvidiaReason?.params?.['name'])).toMatch(/NVIDIA/);
  });
});

/**
 * The Windows fallback is code that can never run on the maintainer's Mac, and
 * on the one Windows machine available `nvidia-smi` works — so without these it
 * would ship covered by nothing but "it compiles". That is exactly how the bug
 * it exists to fix reached users in the first place.
 */
describe('GPU probe parsing', () => {
  it('parses nvidia-smi CSV, including a driver that prints no VRAM', () => {
    expect(
      parseNvidiaSmi('NVIDIA GeForce GTX 1650, 4096, 610.88\nNVIDIA RTX A2000, 6144, 610.88\n'),
    ).toEqual([
      { name: 'NVIDIA GeForce GTX 1650', vramMb: 4096, driverVersion: '610.88' },
      { name: 'NVIDIA RTX A2000', vramMb: 6144, driverVersion: '610.88' },
    ]);
    expect(parseNvidiaSmi('NVIDIA Weird, [N/A], 610.88')).toEqual([
      { name: 'NVIDIA Weird', driverVersion: '610.88' },
    ]);
    expect(parseNvidiaSmi('   \n')).toEqual([]);
  });

  it('parses WMI JSON in BOTH shapes, and never invents VRAM', () => {
    // A single adapter serialises as an object, several as an array — the shape
    // changes under the caller's feet depending on the machine.
    expect(parseWindowsWmiGpus('{"Name":"NVIDIA GeForce GTX 1650"}')).toEqual([
      { name: 'NVIDIA GeForce GTX 1650' },
    ]);
    expect(
      parseWindowsWmiGpus('[{"Name":"NVIDIA GeForce RTX 4090"},{"Name":"Intel UHD Graphics 770"}]'),
    ).toEqual([{ name: 'NVIDIA GeForce RTX 4090' }, { name: 'Intel UHD Graphics 770' }]);
    // AdapterRAM is a uint32 that pins at 4 GB, so VRAM is deliberately absent:
    // a wrong budget is worse than no budget (gpuWeightBudgetMb returns 0).
    const [gpu] = parseWindowsWmiGpus('{"Name":"NVIDIA GeForce RTX 4090","AdapterRAM":4293918720}');
    expect(gpu).toEqual({ name: 'NVIDIA GeForce RTX 4090' });
    expect('vramMb' in (gpu as object)).toBe(false);
    // Junk rows are dropped rather than becoming a nameless "GPU".
    expect(parseWindowsWmiGpus('[{"Name":"  "},{"Name":null},{}]')).toEqual([]);
  });

  it('parses system_profiler, mapping its GB string to MB', () => {
    expect(
      parseSystemProfiler(
        '{"SPDisplaysDataType":[{"sppci_model":"Apple M3 Pro","spdisplays_vram":"18 GB"}]}',
      ),
    ).toEqual([{ name: 'Apple M3 Pro', vramMb: 18 * 1024 }]);
  });
});

describe('GPU probe order and fail-open verdict', () => {
  const calls: string[] = [];
  const probe = (impl: Record<string, () => string>): ExecProbe => async (cmd) => {
    calls.push(cmd);
    const fn = impl[cmd];
    if (!fn) throw new Error(`ENOENT ${cmd}`);
    return fn();
  };
  beforeEach(() => {
    calls.length = 0;
  });

  it('uses nvidia-smi when it answers, and does not spend a WMI call', async () => {
    const r = await detectGpus(
      'win32',
      probe({ 'nvidia-smi': () => 'NVIDIA GeForce GTX 1650, 4096, 610.88' }),
    );
    expect(r.probe).toBe('ok');
    expect(r.gpus[0]).toEqual({ name: 'NVIDIA GeForce GTX 1650', vramMb: 4096, driverVersion: '610.88' });
    expect(calls).toEqual(['nvidia-smi']);
  });

  it('falls back to WMI when nvidia-smi is missing — the bug this fixes', async () => {
    const r = await detectGpus(
      'win32',
      probe({ 'powershell.exe': () => '{"Name":"NVIDIA GeForce GTX 1650"}' }),
    );
    expect(r.probe).toBe('ok');
    expect(r.gpus).toEqual([{ name: 'NVIDIA GeForce GTX 1650' }]);
    expect(calls).toEqual(['nvidia-smi', 'powershell.exe']);
  });

  it('also falls back when nvidia-smi answers EMPTY (an AMD/Intel box)', async () => {
    const r = await detectGpus(
      'win32',
      probe({ 'nvidia-smi': () => '', 'powershell.exe': () => '{"Name":"AMD Radeon RX 7900"}' }),
    );
    expect(r.gpus).toEqual([{ name: 'AMD Radeon RX 7900' }]);
    expect(calls).toEqual(['nvidia-smi', 'powershell.exe']);
  });

  it("reports 'failed' only when BOTH probes fail, so callers fail open", async () => {
    const r = await detectGpus('win32', probe({}));
    expect(r).toEqual({ gpus: [], probe: 'failed' });
  });

  it("reports 'ok' when WMI genuinely finds no adapter", async () => {
    // An empty ANSWER is not a failed probe: this machine really has no GPU, and
    // fail-open must not swallow that or every CPU box is offered a CUDA build.
    const r = await detectGpus('win32', probe({ 'powershell.exe': () => '[]' }));
    expect(r).toEqual({ gpus: [], probe: 'ok' });
  });

  it('does not attempt WMI off Windows', async () => {
    const r = await detectGpus('linux', probe({}));
    expect(r).toEqual({ gpus: [], probe: 'failed' });
    expect(calls).toEqual(['nvidia-smi']);
  });
});
