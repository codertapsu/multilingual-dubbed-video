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
 * Linux/Windows when present. Failure to detect a GPU never fails the call —
 * the bundled workers are CPU builds, so the GPU only informs the notes.
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import type {
  GpuInfo,
  HardwareRecommendation,
  SystemProfile,
  SystemProfileResponse,
} from '@videodubber/shared';

const execFileAsync = promisify(execFile);

/** Detection subprocess budget — a hung tool must not stall the endpoint. */
const DETECT_TIMEOUT_MS = 3000;

/** Best-effort GPU list for the current platform. Never throws. */
async function detectGpus(platform: string): Promise<GpuInfo[]> {
  try {
    if (platform === 'darwin') {
      const { stdout } = await execFileAsync(
        'system_profiler',
        ['SPDisplaysDataType', '-json'],
        { timeout: DETECT_TIMEOUT_MS },
      );
      const parsed = JSON.parse(stdout) as {
        SPDisplaysDataType?: { sppci_model?: string; spdisplays_vram?: string }[];
      };
      return (parsed.SPDisplaysDataType ?? [])
        .filter((d) => d.sppci_model)
        .map((d) => {
          const vram = d.spdisplays_vram ? Number.parseInt(d.spdisplays_vram, 10) : NaN;
          return {
            name: d.sppci_model as string,
            ...(Number.isFinite(vram) ? { vramMb: vram * 1024 } : {}),
          };
        });
    }

    // Linux/Windows: nvidia-smi if present (the common dedicated-GPU case).
    const { stdout } = await execFileAsync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: DETECT_TIMEOUT_MS },
    );
    return stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, mem] = line.split(',').map((s) => s.trim());
        const vramMb = Number.parseInt(mem ?? '', 10);
        return { name: name ?? 'GPU', ...(Number.isFinite(vramMb) ? { vramMb } : {}) };
      });
  } catch {
    return [];
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
    gpus: await detectGpus(platform),
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
    whisperModel = 'base';
    reasons.push(
      `${ramGb.toFixed(0)} GB RAM runs the "base" model well — a good speed/accuracy balance for offline use.`,
    );
  } else if (ramGb < 32) {
    tier = 'performance';
    whisperModel = profile.appleSilicon ? 'medium' : 'small';
    reasons.push(
      profile.appleSilicon
        ? `Apple Silicon with ${ramGb.toFixed(0)} GB unified memory handles the "medium" model — near-best accuracy fully offline.`
        : `${ramGb.toFixed(0)} GB RAM comfortably runs the "small" model offline.`,
    );
  } else {
    tier = 'performance';
    whisperModel = 'medium';
    reasons.push(
      `${ramGb.toFixed(0)} GB RAM runs the "medium" model easily ("large-v3" also fits, but is slow without GPU acceleration).`,
    );
  }

  const slowCpu = profile.cpuCores < 4;
  if (slowCpu) {
    reasons.push(
      `${profile.cpuCores} CPU cores will make local transcription slow on long videos — consider cloud STT for anything over a few minutes.`,
    );
  }

  const nvidia = profile.gpus.find((g) => /nvidia/i.test(g.name));
  if (nvidia && (nvidia.vramMb ?? 0) >= 4096) {
    reasons.push(
      `${nvidia.name} detected — the bundled engines are CPU builds today, so the GPU is not used yet.`,
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
  return { profile, recommendation: recommendSetup(profile) };
}
