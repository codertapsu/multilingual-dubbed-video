/**
 * Verify a freshly installed GPU (PyTorch + CUDA) engine pack really runs here.
 *
 * `uv pip install` succeeding proves only that wheels unpacked. What actually
 * decides whether the GPU voice works is out of our hands until import time:
 *
 *  - PyTorch's Windows wheels carry their own CUDA and cuDNN, but NOT the
 *    Microsoft Visual C++ runtime (msvcp140.dll & co.). The installer puts that
 *    in place first (vcRuntime.ts); a damaged one still dies here with
 *    "DLL load failed ... c10.dll".
 *  - The NVIDIA driver must be new enough for the CUDA build.
 *  - The CUDA build must carry kernels for the card. `is_available()` says yes
 *    and the first real kernel then fails with "no kernel image is available".
 *
 * The engine would survive all three by falling back to the CPU, and that is
 * exactly the problem: the user clicked "install GPU voice", waited for a
 * 2.5 GB download, and would get CPU speed with nothing on screen saying so.
 * So the installer runs {@link TORCH_PROBE} in the new venv and fails the
 * install with steps the user can follow when the GPU cannot be used.
 */
import type { AppError } from '@videodubber/shared';
import { VC_RUNTIME_DOCS, vcRuntimeSteps } from './vcRuntime.js';

/** Runs in the pack's venv; prints one JSON object. Ends with a REAL kernel. */
export const TORCH_PROBE = [
  'import json',
  'r = {}',
  'try:',
  '    import torch',
  '    r["torch"] = torch.__version__',
  '    r["cuda"] = torch.version.cuda',
  '    r["available"] = bool(torch.cuda.is_available())',
  '    if r["available"]:',
  '        r["device"] = torch.cuda.get_device_name(0)',
  '        r["capability"] = "%d.%d" % torch.cuda.get_device_capability(0)',
  '        r["arch"] = torch.cuda.get_arch_list()',
  '        torch.ones(8, device="cuda").mul_(2).sum().item()',
  'except BaseException as e:',
  '    r["error"] = type(e).__name__ + ": " + str(e)',
  'print(json.dumps(r))',
].join('\n');

/** What {@link TORCH_PROBE} prints. */
export interface TorchProbeResult {
  torch?: string;
  cuda?: string | null;
  available?: boolean;
  device?: string;
  capability?: string;
  arch?: string[];
  error?: string;
}

export type GpuVerdict =
  | { ok: true; summary: string }
  | { ok: false; error: Pick<AppError, 'code' | 'message' | 'remediation' | 'docsRef'> };

const DOCS = 'docs/TROUBLESHOOTING.md#the-gpu-voice-pack-cannot-use-the-graphics-card';
const REINSTALL = 'Then click Reinstall on this pack (the download is cached, so it is quick).';

/** Judge the probe's output. Pure. */
export function judgeTorchProbe(
  raw: string,
  platform: NodeJS.Platform = process.platform,
): GpuVerdict {
  let probe: TorchProbeResult;
  try {
    // The last non-empty line: anything a library printed earlier is noise.
    const line = raw.trim().split(/\r?\n/).filter(Boolean).pop() ?? '';
    probe = JSON.parse(line) as TorchProbeResult;
  } catch {
    return fail(
      'The GPU voice pack installed, but its self-check printed nothing usable, so it is not known to work.',
      `Click Reinstall on this pack. If that fails too, report it from Help → Report a problem with this text: ${raw.trim().slice(0, 300) || '(no output)'}`,
    );
  }

  const err = probe.error ?? '';
  if (err) {
    // The installer puts the runtime in place before downloading (vcRuntime.ts), so
    // reaching this means it is there but damaged, or a DLL of it was removed.
    if (
      platform === 'win32' &&
      /DLL load failed|WinError 126|c10\.dll|vcruntime|msvcp/i.test(err)
    ) {
      return {
        ok: false,
        error: {
          code: 'ENGINE_PACK_FAILED',
          message:
            'The GPU voice pack installed, but PyTorch could not load the Microsoft Visual C++ runtime it needs (missing, damaged or too old).',
          remediation: vcRuntimeSteps('install'),
          docsRef: VC_RUNTIME_DOCS,
        },
      };
    }
    if (
      /no kernel image|not compatible with the current PyTorch|sm_\d+ is not compatible/i.test(err)
    ) {
      return fail(
        `The GPU voice pack installed, but this PyTorch build cannot run your ${probe.device ?? 'graphics card'}` +
          `${probe.capability ? ` (compute capability ${probe.capability})` : ''}.`,
        'Use the CPU pack ("VieNeu Neural TTS v3") instead; it gives the same voices. Please also report this from ' +
          'Help → Report a problem so the right build can be added for your card.',
      );
    }
    return fail(
      `The GPU voice pack installed, but PyTorch failed to start: ${err.slice(0, 300)}`,
      `${REINSTALL.replace('Then c', 'C')} If it fails again, use the CPU pack ("VieNeu Neural TTS v3") and report the message above from Help → Report a problem.`,
    );
  }

  if (probe.available !== true) {
    return fail(
      `The GPU voice pack installed, but PyTorch ${probe.torch ?? ''} (CUDA ${probe.cuda ?? '?'}) cannot see an NVIDIA graphics card.`,
      'This is almost always a graphics driver that is too old. 1. Open the NVIDIA App (or GeForce Experience) and go to ' +
        'Drivers, or download the latest driver for your card from https://www.nvidia.com/Download. ' +
        '2. Install it and restart the computer. 3. ' +
        REINSTALL +
        ' On a laptop, also check the PC is plugged in and not in a power-saving mode that disables the NVIDIA GPU.',
    );
  }

  return {
    ok: true,
    summary: `Runs on ${probe.device ?? 'your NVIDIA GPU'} (PyTorch ${probe.torch ?? '?'}, CUDA ${probe.cuda ?? '?'}).`,
  };
}

function fail(message: string, remediation: string): GpuVerdict {
  return { ok: false, error: { code: 'ENGINE_PACK_FAILED', message, remediation, docsRef: DOCS } };
}
