/**
 * How many dubbing runs this machine should execute at once.
 *
 * Dubbing is not a background task: a single run drives ffmpeg (x264 render),
 * faster-whisper, and possibly a local LLM — each of which happily saturates
 * every core it is given. Running N projects at once therefore does not finish
 * them N× sooner; it makes all of them slower and the machine unusable. This
 * module turns the machine's specs into an honest limit.
 *
 * ── DELIBERATE EXCLUSIONS (do not "fix" these later) ──────────────────────
 *  - `freeRamMb` is NOT an input. {@link getSystemProfile} re-reads
 *    `os.freemem()` on every call, so a limit derived from it would visibly
 *    change between two visits to the Settings screen; macOS also understates
 *    it (compressed/cached pages). Stable specs only.
 *  - GPUs are NOT an input. A GPU accelerates one run's engine; it does not
 *    make a second concurrent render cheap, and VRAM is already gated per
 *    engine pack.
 *
 * ── THE HEAVY LANE IS SEPARATE ────────────────────────────────────────────
 * {@link CapacityRecommendation.heavyLanes} is always 1 and is NOT derived from
 * hardware: heavy local engines (llama.cpp, whisper.cpp, LibreTranslate,
 * separation, alignment) unload each other by design (EngineManager's
 * sequential-memory policy), so a second concurrent heavy run is a FAILURE
 * (ENGINE_BUSY / evicted mid-request), not merely slow. No machine, however
 * fast, changes that — which is why no user setting may raise it.
 */
import type { CapacityRecommendation, SystemProfile,
  LocalizedText,
} from '@videodubber/shared';

/** Cores left to the OS, the Tauri webview, and this orchestrator. */
const CORES_RESERVED = 2;
/** Cores a local run wants at its peak (ffmpeg/whisper are multi-threaded). */
const CORES_PER_RUN = 3;
/** RAM left to the OS + app shell (GB). */
const RAM_RESERVED_GB = 4;
/** RAM a local run wants (GB). Apple Silicon's unified memory is also GPU memory. */
function ramPerRunGb(profile: SystemProfile): number {
  return profile.appleSilicon ? 4 : 3;
}
/**
 * Past this, the SHARED Python workers (STT :5101 / MT :5102 / TTS :5103) are
 * single processes and serialize the work anyway — more parallel runs would add
 * contention without throughput.
 */
const HARD_CAP = 4;

/** Points a run consumes: a local run costs 2, a cloud-only run 1. */
export const POINTS_PER_LOCAL_RUN = 2;
export const POINTS_PER_CLOUD_RUN = 1;

function clamp(n: number, min: number, max: number): number {
  // A non-finite input (a failed hardware probe reporting NaN) must collapse to
  // the SAFE minimum, not propagate NaN through the whole recommendation.
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

/** A spec reading we can compute with: finite and non-negative, else 0. */
function sane(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Recommend the simultaneous-run capacity for a machine. Pure + unit-tested:
 * the same profile always yields the same limit.
 */
export function recommendCapacity(profile: SystemProfile): CapacityRecommendation {
  const cores = sane(profile.cpuCores);
  const ramGb = sane(profile.totalRamMb) / 1024;
  const cpuSlots = Math.floor((cores - CORES_RESERVED) / CORES_PER_RUN);
  const ramSlots = Math.floor((ramGb - RAM_RESERVED_GB) / ramPerRunGb(profile));
  const uncapped = Math.min(cpuSlots, ramSlots);
  const maxProjects = clamp(uncapped, 1, HARD_CAP);
  const hardCapped = uncapped > HARD_CAP;

  const reasons: LocalizedText[] = [];
  if (maxProjects === 1) {
    reasons.push({ key: 'capacity.one-at-a-time', params: { cores, ram: Math.round(ramGb) } });
  } else {
    reasons.push({ key: 'capacity.multiple', params: { cores, ram: Math.round(ramGb), n: maxProjects } });
  }
  if (cpuSlots < ramSlots) reasons.push({ key: 'capacity.cpu-bound' });
  else if (ramSlots < cpuSlots) reasons.push({ key: 'capacity.ram-bound' });
  if (hardCapped) {
    reasons.push({ key: 'capacity.hard-cap', params: { cap: HARD_CAP } });
  }
  reasons.push({ key: 'capacity.heavy-engines' });

  return {
    maxProjects,
    budgetPoints: maxProjects * POINTS_PER_LOCAL_RUN,
    heavyLanes: 1,
    cpuSlots,
    ramSlots,
    hardCapped,
    reasons,
  };
}

/**
 * The limit actually in force: the hardware recommendation, or the user's
 * manual pin (clamped to a sane 1..8 — above 8 is never useful and the shared
 * workers serialize regardless).
 */
export function effectiveCapacity(
  recommended: CapacityRecommendation,
  prefs?: { mode: 'auto' | 'manual'; maxProjects?: number },
): CapacityRecommendation {
  if (!prefs || prefs.mode !== 'manual' || prefs.maxProjects === undefined) return recommended;
  const maxProjects = clamp(Math.round(prefs.maxProjects), 1, 8);
  return {
    ...recommended,
    maxProjects,
    budgetPoints: maxProjects * POINTS_PER_LOCAL_RUN,
    reasons: [
      // No English pluralization here: `dub`/`dubs` cannot survive translation
      // (Vietnamese has no plural -s), so the count is a parameter instead.
      { key: 'capacity.manual', params: { n: maxProjects, recommended: recommended.maxProjects } },
      ...recommended.reasons.slice(-1),
    ],
  };
}
