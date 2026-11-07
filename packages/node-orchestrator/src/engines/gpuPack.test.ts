/**
 * The GPU voice pack: which PyTorch build a machine gets, how its install is
 * verified, and the disk-space check in front of every engine-pack install.
 *
 * Measured on 2026-11-07 on an RTX 3050 (sm_86, driver 616.92): torch 2.14.1
 * cu126 carries sm_50..sm_90 and no PTX (no Blackwell); cu130 carries
 * sm_75..sm_120 and ran VieNeu twice as fast (RTF 0.18 vs 0.34).
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EngineInstallEvent, GpuInfo, SystemProfile } from '@videodubber/shared';
import { EngineEventBus } from './engineBus.js';
import { EngineInstaller } from './engineInstaller.js';
import { EnginePackStore } from './enginePackStore.js';
import { findPack } from './enginePackCatalog.js';
import { requiredFreeMb } from './diskSpace.js';
import { recommendEnginePacks } from './engineRecommendation.js';
import { recommendSetup } from '../system/systemProfile.js';
import { judgeTorchProbe, TORCH_PROBE } from './gpuVerify.js';
import { resolveUvRequirements, torchCudaBuildFor, TORCH_GPU_VERSION } from './uvRequirements.js';

const gpu = (name: string, computeCapability?: string, driverVersion = '616.92'): GpuInfo => ({
  name,
  driverVersion,
  ...(computeCapability ? { computeCapability } : {}),
});

describe('torchCudaBuildFor (which PyTorch CUDA build a machine gets)', () => {
  it('gives Turing-or-newer cards on an R580+ driver the faster cu130 build', () => {
    expect(torchCudaBuildFor([gpu('NVIDIA GeForce RTX 3050', '8.6')])).toBe('cu130');
    expect(torchCudaBuildFor([gpu('NVIDIA GeForce GTX 1660 SUPER', '7.5', '581.15')])).toBe(
      'cu130',
    );
  });

  it('keeps those cards on cu126 when the driver predates CUDA 13', () => {
    expect(torchCudaBuildFor([gpu('NVIDIA GeForce RTX 3050', '8.6', '561.17')])).toBe('cu126');
  });

  it('gives pre-Turing cards cu126, the only build with their kernels', () => {
    expect(torchCudaBuildFor([gpu('NVIDIA GeForce GTX 1060 6GB', '6.1')])).toBe('cu126');
    expect(torchCudaBuildFor([gpu('NVIDIA GeForce GTX 970', '5.2')])).toBe('cu126');
  });

  it('gives Blackwell cu130 whatever the driver says (cu126 has no kernels for it)', () => {
    expect(torchCudaBuildFor([gpu('NVIDIA GeForce RTX 5090', '12.0', '572.16')])).toBe('cu130');
  });

  it('falls back to the card name when the driver cannot report a capability', () => {
    expect(torchCudaBuildFor([gpu('NVIDIA GeForce RTX 5070 Ti', undefined, '575.00')])).toBe(
      'cu130',
    );
    expect(torchCudaBuildFor([gpu('NVIDIA GeForce RTX 2060', undefined, '600.10')])).toBe('cu130');
    expect(torchCudaBuildFor([gpu('NVIDIA GeForce GTX 1080', undefined, '600.10')])).toBe('cu126');
  });

  it('picks cu126 when ANY card is pre-Turing (it might be the one PyTorch uses)', () => {
    expect(
      torchCudaBuildFor([
        gpu('NVIDIA GeForce RTX 3060', '8.6'),
        gpu('NVIDIA GeForce GTX 1050', '6.1'),
      ]),
    ).toBe('cu126');
  });

  it('defaults to cu126 when nothing is known', () => {
    expect(torchCudaBuildFor([])).toBe('cu126');
  });
});

describe('GPU pack requirements', () => {
  it('pins the exact CUDA build of torch and adds its index', () => {
    const r = resolveUvRequirements('tts-neural-cuda', 'win32', 'x64', [
      gpu('NVIDIA GeForce RTX 3050', '8.6'),
    ]);
    expect(r?.torchCudaBuild).toBe('cu130');
    expect(r?.requirements).toContain(`torch==${TORCH_GPU_VERSION}+cu130`);
    expect(r?.extraIndexUrls).toEqual(['https://download.pytorch.org/whl/cu130']);
    // Everything the CPU pack has, so the engine can fall back to the CPU.
    for (const req of resolveUvRequirements('tts-neural', 'win32', 'x64')!.requirements) {
      expect(r?.requirements).toContain(req);
    }
    expect(r?.requirements.some((x) => x.startsWith('torchaudio'))).toBe(false);
  });

  it('leaves the CPU pack torch-free', () => {
    const r = resolveUvRequirements('tts-neural', 'win32', 'x64', [
      gpu('NVIDIA GeForce RTX 3050', '8.6'),
    ]);
    expect(r?.torchCudaBuild).toBeUndefined();
    expect(r?.requirements.some((x) => x.startsWith('torch'))).toBe(false);
  });

  it('is offered for the same voices, ahead of the CPU pack', () => {
    const cuda = findPack('tts-neural-cuda');
    expect(cuda?.providerId).toBe(findPack('tts-neural')?.providerId);
    expect(cuda?.accel).toBe('cuda');
  });
});

describe('judgeTorchProbe (is the GPU really usable after install?)', () => {
  const ok = JSON.stringify({
    torch: '2.14.1+cu130',
    cuda: '13.0',
    available: true,
    device: 'NVIDIA GeForce RTX 3050',
    capability: '8.6',
    arch: ['sm_75', 'sm_86'],
  });

  it('passes a working GPU and names it', () => {
    expect(judgeTorchProbe(ok)).toEqual({
      ok: true,
      summary: 'Runs on NVIDIA GeForce RTX 3050 (PyTorch 2.14.1+cu130, CUDA 13.0).',
    });
  });

  it('ignores whatever a library printed before the JSON line', () => {
    expect(judgeTorchProbe(`some warning\n\n${ok}\n`).ok).toBe(true);
  });

  it('turns a missing Visual C++ runtime into steps the user can follow', () => {
    const v = judgeTorchProbe(
      JSON.stringify({
        error:
          'OSError: [WinError 126] The specified module could not be found. Error loading "c10.dll" or one of its dependencies.',
      }),
      'win32',
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error.message).toContain('Microsoft Visual C++ runtime');
    expect(v.error.remediation).toContain('https://aka.ms/vc14/vc_redist.x64.exe');
    expect(v.error.remediation).toContain('click Install again');
    expect(v.error.docsRef).toBe(
      'docs/TROUBLESHOOTING.md#engines-need-the-microsoft-visual-c-runtime',
    );
  });

  it('turns an invisible GPU into driver-update steps', () => {
    const v = judgeTorchProbe(
      JSON.stringify({ torch: '2.14.1+cu130', cuda: '13.0', available: false }),
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error.remediation).toMatch(/driver/i);
    expect(v.error.remediation).toContain('https://www.nvidia.com/Download');
  });

  it('recognises a card the build has no kernels for', () => {
    const v = judgeTorchProbe(
      JSON.stringify({
        available: true,
        device: 'NVIDIA GeForce RTX 5090',
        capability: '12.0',
        error: 'RuntimeError: CUDA error: no kernel image is available for execution on the device',
      }),
    );
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.error.message).toContain('RTX 5090');
    expect(v.error.remediation).toContain('CPU pack');
  });

  it('never passes output it cannot read', () => {
    expect(judgeTorchProbe('Traceback (most recent call last):\n  ...').ok).toBe(false);
    expect(judgeTorchProbe('').ok).toBe(false);
  });

  it('probes with a real kernel, not just is_available()', () => {
    expect(TORCH_PROBE).toContain('device="cuda"');
    expect(TORCH_PROBE).toContain('.item()');
  });
});

describe('disk space before an install', () => {
  it('asks for room in proportion to how the pack installs', () => {
    expect(
      requiredFreeMb({ artifacts: [{ url: 'uv-env://x', approxSizeMb: 4500, destPath: 'venv' }] }),
    ).toBe(6137);
    expect(
      requiredFreeMb({
        artifacts: [{ url: 'https://x/a.zip', approxSizeMb: 300, destPath: '.', archive: true }],
      }),
    ).toBe(1412);
    expect(
      requiredFreeMb({
        artifacts: [{ url: 'https://x/m.gguf', approxSizeMb: 1000, destPath: 'm.gguf' }],
      }),
    ).toBe(1612);
  });

  let tmp: string;
  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-gpu-pack-test-'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  it('refuses up front, saying how much is needed and how much is free', async () => {
    const store = new EnginePackStore(path.join(tmp, 'config'));
    const bus = new EngineEventBus();
    const events: EngineInstallEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const installer = new EngineInstaller({ store, bus, freeBytes: async () => 2 * 2 ** 30 });

    await installer.install('tts-neural-cuda');

    const error = events.find(
      (e): e is Extract<EngineInstallEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(error?.error.message).toMatch(/needs about 6\.0 GB .* 2\.0 GB is free/);
    expect(error?.error.remediation).toContain('Settings → Storage');
    expect(await store.isInstalled('tts-neural-cuda')).toBe(false);
    await expect(fsp.stat(store.packDir('tts-neural-cuda'))).rejects.toThrow();
    // ...and it is not left marked "in progress": a retry after freeing space runs.
    await installer.install('tts-neural-cuda');
    expect(events.filter((e) => e.type === 'error')).toHaveLength(2);
  });
});

describe('recommending the GPU voice pack', () => {
  const pc = (gpus: SystemProfile['gpus']): SystemProfile => ({
    platform: 'win32',
    arch: 'x64',
    cpuModel: '13th Gen Intel(R) Core(TM) i5-13400F',
    cpuCores: 16,
    totalRamMb: 32 * 1024,
    freeRamMb: 20 * 1024,
    gpus,
    appleSilicon: false,
  });
  const rec = (profile: SystemProfile) =>
    recommendEnginePacks(profile, recommendSetup(profile), 'win32', 'x64');

  it('offers the GPU build on an NVIDIA machine, naming the card in the reason', () => {
    const r = rec(
      pc([
        {
          name: 'NVIDIA GeForce RTX 3050',
          vramMb: 8192,
          driverVersion: '616.92',
          computeCapability: '8.6',
        },
      ]),
    );
    const voice = r.find((x) => findPack(x.packId)?.providerId === 'neural-tts');
    expect(voice?.packId).toBe('tts-neural-cuda');
    expect(voice?.reasonText).toEqual({
      key: 'engines.why.vieneu-gpu',
      params: { gpu: 'NVIDIA GeForce RTX 3050' },
    });
  });

  it('offers the CPU build when the driver is too old for the GPU build', () => {
    const r = rec(
      pc([
        {
          name: 'NVIDIA GeForce RTX 3050',
          vramMb: 8192,
          driverVersion: '531.79',
          computeCapability: '8.6',
        },
      ]),
    );
    expect(r.find((x) => findPack(x.packId)?.providerId === 'neural-tts')?.packId).toBe(
      'tts-neural',
    );
  });

  it('offers the CPU build without an NVIDIA card', () => {
    const r = rec(pc([{ name: 'AMD Radeon RX 7600' }]));
    const voice = r.find((x) => findPack(x.packId)?.providerId === 'neural-tts');
    expect(voice?.packId).toBe('tts-neural');
    expect(voice?.reasonText.key).toBe('engines.why.vieneu-cpu');
  });

  it('gives every recommendation a translatable reason', () => {
    for (const r of rec(
      pc([{ name: 'NVIDIA GeForce RTX 3050', vramMb: 8192, driverVersion: '616.92' }]),
    )) {
      expect(r.reasonText.key).toMatch(/^engines\.why\.[a-z0-9-]+$/);
    }
  });
});
