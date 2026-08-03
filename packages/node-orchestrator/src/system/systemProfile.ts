/**
 * Hardware/OS detection + hardware-aware setup recommendations.
 *
 * VideoDubber runs every phase locally by default, but the right local
 * configuration depends on the machine: faster-whisper model sizes range from
 * ~75 MB (tiny) to ~3 GB (large-v3) and their RAM/CPU appetite scales with
 * size. `getSystemProfile()` probes the machine (cheap, cached), and
 * `recommendSetup()` is a PURE function mapping a profile to a recommendation —
 * unit-tested and reused by the UI ("Apply recommended defaults").
 *
 * GPU detection is best-effort: `system_profiler` on macOS, `nvidia-smi` on
 * Linux/Windows, with a WMI fallback on Windows when that is missing or slow.
 * Failure never fails the call.
 *
 * It is NO LONGER cosmetic, though — this comment used to say the GPU "only
 * informs the notes", which was true when the bundled workers were all CPU
 * builds. The profile now decides which engine packs are offered, which runtime
 * wins selection, and which model size is recommended. So the probe reports
 * whether it actually ran (`gpuProbe`), and every consumer must treat "could not
 * tell" as "do not restrict" rather than as "no GPU".
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import {
  NVIDIA_GPU_RE,
  type GpuInfo,
  type HardwareRecommendation,
  type SystemProfile,
  type SystemProfileResponse,
} from '@videodubber/shared';
import { recommendCapacity } from './capacity.js';

const execFileAsync = promisify(execFile);

/** Detection subprocess budget — a hung tool must not stall the endpoint. */
const DETECT_TIMEOUT_MS = 3000;

/**
 * Budget for the Windows WMI fallback. Longer than the primary probe because it
 * only runs when that already failed, and a cold `powershell.exe` start alone
 * can spend a second or two before our command begins.
 */
const WMI_TIMEOUT_MS = 8000;

/**
 * Windows fallback when `nvidia-smi` is absent or slow.
 *
 * WMI needs no vendor tool, so it still sees the card when the NVIDIA CLI is
 * missing from PATH, the dGPU is asleep under Optimus, or antivirus delays the
 * spawn. It also sees AMD/Intel adapters, which `nvidia-smi` never reports.
 *
 * VRAM is deliberately dropped: `Win32_VideoController.AdapterRAM` is a uint32,
 * so anything at or above 4 GB pins at 4293918720 and a 24 GB card is
 * indistinguishable from a 4 GB one. Reporting that would feed a wrong budget
 * into the model recommender; leaving it undefined makes `gpuWeightBudgetMb`
 * return 0, which falls back to the CPU tier rather than guessing.
 */
async function detectGpusWindowsWmi(): Promise<GpuInfo[]> {
  // powershell.exe (5.1) ships with every Windows; pwsh 7 may not be installed.
  const { stdout } = await execFileAsync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object Name | ConvertTo-Json -Compress',
    ],
    { timeout: WMI_TIMEOUT_MS, windowsHide: true },
  );
  const parsed: unknown = JSON.parse(stdout);
  // One adapter serialises as an object, several as an array.
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as { Name?: string }[];
  return rows
    .map((r) => r.Name?.trim())
    .filter((n): n is string => Boolean(n))
    .map((name) => ({ name }));
}

/**
 * Best-effort GPU list for the current platform. Never throws.
 *
 * `probe: 'failed'` distinguishes "could not tell" from "has none" — callers
 * must fail open on it. See {@link SystemProfile.gpuProbe}.
 */
async function detectGpus(platform: string): Promise<{ gpus: GpuInfo[]; probe: 'ok' | 'failed' }> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await execFileAsync(
        'system_profiler',
        ['SPDisplaysDataType', '-json'],
        { timeout: DETECT_TIMEOUT_MS, windowsHide: true },
      );
      const parsed = JSON.parse(stdout) as {
        SPDisplaysDataType?: { sppci_model?: string; spdisplays_vram?: string }[];
      };
      return {
        probe: 'ok',
        gpus: (parsed.SPDisplaysDataType ?? [])
          .filter((d) => d.sppci_model)
          .map((d) => {
            const vram = d.spdisplays_vram ? Number.parseInt(d.spdisplays_vram, 10) : NaN;
            return {
              name: d.sppci_model as string,
              ...(Number.isFinite(vram) ? { vramMb: vram * 1024 } : {}),
            };
          }),
      };
    }

    // Linux/Windows: nvidia-smi if present (the common dedicated-GPU case).
    // driver_version comes from the SAME query rather than parsing nvidia-smi's
    // banner: the banner's "CUDA Version:" field moved between driver
    // generations (it is absent entirely on 610.x), whereas --query-gpu is a
    // stable machine-readable contract.
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'],
      { timeout: DETECT_TIMEOUT_MS, windowsHide: true },
    );
    const gpus = stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, mem, driver] = line.split(',').map((s) => s.trim());
        const vramMb = Number.parseInt(mem ?? '', 10);
        return {
          name: name ?? 'GPU',
          ...(Number.isFinite(vramMb) ? { vramMb } : {}),
          ...(driver ? { driverVersion: driver } : {}),
        };
      });
    // nvidia-smi exists but reported nothing: on Windows that is still worth a
    // WMI pass, since the machine may have an AMD/Intel adapter it cannot see.
    if (gpus.length === 0 && platform === 'win32') return await detectGpusWindowsWmi2();
    return { gpus, probe: 'ok' };
  } catch {
    // nvidia-smi missing, timed out, or the GPU was asleep. On Windows, ask WMI
    // before concluding anything — this is the path that used to hide both CUDA
    // packs from a user who owns an NVIDIA card.
    if (platform === 'win32') return await detectGpusWindowsWmi2();
    return { gpus: [], probe: 'failed' };
  }
}

/** {@link detectGpusWindowsWmi} with the probe verdict, and never throwing. */
async function detectGpusWindowsWmi2(): Promise<{ gpus: GpuInfo[]; probe: 'ok' | 'failed' }> {
  try {
    const gpus = await detectGpusWindowsWmi();
    // WMI answering with an empty list is a real answer ("no adapter"); WMI
    // throwing is not, and must stay 'failed' so callers fail open.
    return { gpus, probe: 'ok' };
  } catch {
    return { gpus: [], probe: 'failed' };
  }
}

let cached: SystemProfile | undefined;

/** Probe the machine (RAM/CPU cheap + GPU subprocess); cached per process. */
export async function getSystemProfile(): Promise<SystemProfile> {
  if (cached) {
    // RAM headroom changes over time — refresh just the free-memory snapshot.
    return { ...cached, freeRamMb: Math.round(os.freemem() / (1024 * 1024)) };
  }
  const cpus = os.cpus();
  const platform = process.platform;
  const arch = process.arch;
  const profile: SystemProfile = {
    platform,
    arch,
    cpuModel: cpus[0]?.model?.trim() ?? 'unknown',
    cpuCores: cpus.length,
    totalRamMb: Math.round(os.totalmem() / (1024 * 1024)),
    freeRamMb: Math.round(os.freemem() / (1024 * 1024)),
    ...(({ gpus, probe }) => ({ gpus, gpuProbe: probe }))(await detectGpus(platform)),
    appleSilicon: platform === 'darwin' && arch === 'arm64',
  };
  cached = profile;
  return profile;
}

/**
 * Map a hardware profile to a recommended local setup. PURE — no I/O.
 *
 * Heuristics (RAM is the dominant constraint for faster-whisper on CPU):
 *   - <  8 GB: constrained — "tiny"; cloud STT/translation give better quality
 *              than anything that fits locally.
 *   - 8–16 GB: balanced — "base" (the catalog's recommended starter).
 *   - 16–32 GB: performance — "small"; Apple Silicon comfortably runs "medium".
 *   - ≥ 32 GB: performance — "medium" (large-v3 possible but slow on CPU).
 * Few CPU cores (<4) push the STT suggestion toward cloud regardless of RAM —
 * a feature-length video could take many hours locally.
 */
export function recommendSetup(profile: SystemProfile): HardwareRecommendation {
  const ramGb = profile.totalRamMb / 1024;
  const reasons: string[] = [];
  let tier: HardwareRecommendation['tier'];
  let whisperModel: string;

  if (ramGb < 8) {
    tier = 'constrained';
    whisperModel = 'tiny';
    reasons.push(
      `With ${ramGb.toFixed(0)} GB RAM, only the smallest local speech-recognition model fits comfortably; cloud STT will be noticeably more accurate.`,
    );
  } else if (ramGb < 16) {
    tier = 'balanced';
    whisperModel = 'large-v3-turbo';
    reasons.push(
      `${ramGb.toFixed(0)} GB RAM runs "large-v3-turbo" — near-best accuracy at 6-8x the speed of large-v3, a great offline balance.`,
    );
  } else {
    tier = 'performance';
    whisperModel = 'large-v3-turbo';
    reasons.push(
      `${ramGb.toFixed(0)} GB RAM easily runs "large-v3-turbo"; "large-v3" also fits for maximum accuracy if you accept the extra time.`,
    );
    if (profile.appleSilicon) {
      reasons.push('On Apple Silicon, install the whisper.cpp (Metal) engine pack for a large speed-up over the CPU build.');
    }
  }

  const slowCpu = profile.cpuCores < 4;
  if (slowCpu) {
    reasons.push(
      `${profile.cpuCores} CPU cores will make local transcription slow on long videos — consider cloud STT for anything over a few minutes.`,
    );
  }

  // NVIDIA: say what the card actually buys, and name the one prerequisite that
  // silently costs a user their GPU. This used to read "the bundled engines are
  // CPU builds today, so the GPU is not used yet" — untrue since the CUDA packs
  // shipped, and precisely backwards for the audience most able to act on it.
  const nvidia = profile.gpus.find((g) => NVIDIA_GPU_RE.test(g.name));
  if (nvidia && (nvidia.vramMb ?? 0) >= 4096) {
    const vramGb = Math.round((nvidia.vramMb ?? 0) / 1024);
    reasons.push(
      `${nvidia.name} (${vramGb} GB) detected — install the CUDA engine packs in Settings → Engines for GPU-accelerated transcription and translation. They need NVIDIA driver 551.61 or newer; on an older driver the app falls back to the Vulkan build automatically.`,
    );
  }

  return {
    tier,
    whisperModel,
    suggestCloud: {
      stt: tier === 'constrained' || slowCpu,
      translation: tier === 'constrained',
      // Piper TTS is light (runs fine on any machine); cloud TTS is a voice
      // preference rather than a hardware need.
      tts: false,
    },
    reasons,
  };
}

/** Full GET /system payload. */
export async function buildSystemResponse(): Promise<SystemProfileResponse> {
  const profile = await getSystemProfile();
  return { profile, recommendation: recommendSetup(profile), capacity: recommendCapacity(profile) };
}
