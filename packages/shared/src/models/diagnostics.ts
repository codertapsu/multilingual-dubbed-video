/**
 * What the app knows about its own health and about what went worse than
 * asked in a dub (docs/plans/production-hardening-2026-11.md, Phases 1 and 7).
 *
 * A dub that silently degraded (speaker detection failed, so one voice; the
 * GPU was busy, so the CPU build) used to say so only in the pipeline log.
 * Those are now {@link ProjectWarning}s, kept with the pipeline and shown in the
 * Processing screen, the editor and the plugin's get_project.
 */
import type { PipelineStepId } from './domain.js';

/** One sample of the backend's own health (every minute while work runs). */
export interface HealthSample {
  at: string;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  externalMb: number;
  arrayBuffersMb: number;
  /** Event-loop delay over the sample period: the 99th percentile and the worst. */
  lagP99Ms: number;
  lagMaxMs: number;
  /** Free system memory, as a share of the total (0..1). */
  freeRamShare: number;
}

/** GET /diagnostics/health. */
export interface BackendHealth {
  version: string;
  commit?: string;
  startedAt: string;
  uptimeSec: number;
  /** V8's heap limit: an out-of-memory crash happens near it. */
  heapLimitMb: number;
  latest?: HealthSample;
  /** The worst values seen since start. */
  peak: { rssMb: number; heapUsedMb: number; lagMaxMs: number };
  /** The last hour or so, oldest first. */
  samples: HealthSample[];
  /** A crash of the previous backend this one was restarted after, when there was one. */
  recoveredFrom?: BackendCrash;
}

/** A backend that ended without being asked to (the shell's watchdog writes it). */
export interface BackendCrash {
  at: string;
  /** The exit code as the OS gave it. */
  code?: number;
  /** The same code in hex, for Windows status codes (0xC0000409). */
  codeHex?: string;
  /** What the code means, in plain words. */
  meaning?: string;
  /** How long that backend had run. */
  uptimeSec?: number;
}

/** What a warning is about (the UI and the plugin key on it). */
export type ProjectWarningCode =
  /** Speaker detection was asked for and failed: every line keeps one voice. */
  | 'speakers-failed'
  /** Speaker detection found speakers but some lines are only a best guess. */
  | 'speakers-low-confidence'
  /** A GPU engine could not be used (busy or unusable): a CPU build ran instead. */
  | 'gpu-fallback'
  /** Speech-to-text repeated itself (a hallucination loop) and was repaired. */
  | 'loops-repaired'
  /** Loops or hallucinated lines were found and could not be repaired: flagged. */
  | 'loops-left'
  /** A series part came out shorter or longer than asked. */
  | 'part-length'
  /** The AI gave no usable cut; the best pause was used. */
  | 'ai-cut-fallback'
  /** Lines with no letters were left silent instead of spoken. */
  | 'no-speech-lines'
  /** The source's audio ran longer than its picture (by 0.5 s or more): re-timed to the picture. */
  | 'audio-drift'
  /** A speech-to-text chunk wrote lines over (nearly) no speech: hallucinations over silence. */
  | 'stt-no-speech'
  /** Over a minute of digital silence in a talk-heavy video: probably a source or encoding problem. */
  | 'digital-silence'
  /** A spot check found the transcript does not match the audio around a time. */
  | 'transcript-mismatch'
  /** Re-transcribed lines whose speaker could not be carried over. */
  | 'speakers-unassigned'
  /** Lines that look like a song, offered to keep as the original. */
  | 'songs-suggested'
  /** Anything else worth knowing (the message says what). */
  | 'other';

/** Something that went worse than asked in a run; kept until the step runs again. */
export interface ProjectWarning {
  code: ProjectWarningCode;
  /** The step it happened in. */
  step?: PipelineStepId;
  at: string;
  /** Plain English, for the plugin and the log. */
  message: string;
  /** i18n key and parameters, for the app's own wording. */
  key: string;
  params?: Record<string, string | number>;
}

/** Where a long step is inside itself ("Detecting speakers 12/60"). */
export interface StepDetail {
  /** i18n key and parameters, for the app's own wording. */
  key: string;
  params?: Record<string, string | number>;
  /** Plain English, for the plugin and the log. */
  text: string;
}
