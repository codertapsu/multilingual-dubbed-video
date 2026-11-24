import type { AppError } from '../errors.js';
import type { CreateProjectInput, Project, ProjectInputFile } from './domain.js';

/**
 * One project from several video files (New project → "Join several videos",
 * MCP `join_videos`): the files are joined, in the order given, into the
 * project's one input video, and `Project.inputFiles` records where each one
 * starts.
 *
 * WHY THE APP DOES IT: the 27.8-hour series (claude-dubber report,
 * 2026-11-23) was five Bilibili files joined by hand into one 18.2 GB source,
 * and that join is where it went wrong: the files mixed 44.1 and 48 kHz audio,
 * one file's audio clock ran fast (P4: 4.81 s more samples than its
 * timestamps), and a naive `aresample=async=1` over the whole join garbled
 * P3/P4 (content shifted, then two hours of silence). Here each file's sound is
 * re-timed to its own picture and cut to exactly its length before the next
 * file starts.
 */

/** How the picture is joined: copied as it is, or decoded and encoded again. */
export type JoinMode = 'copy' | 'reencode';

/** One file as the compatibility check read it. */
export interface JoinFileInfo {
  path: string;
  /** Its file name ("P4.mp4"). */
  name: string;
  sizeBytes: number;
  /** Its length in the joined video (its picture's end), in ms. */
  durationMs: number;
  video?: {
    codec: string;
    profile?: string;
    /** Display size (a phone video's rotation applied). */
    width: number;
    height: number;
    /** Base frame rate, e.g. 25 or 29.97. */
    fps: number;
    pixFmt?: string;
  };
  audio?: {
    codec: string;
    sampleRate: number;
    channels: number;
  };
  /** Why this file cannot be joined (unreadable, no picture). */
  error?: AppError;
}

/** A way a file differs from the first one, so its picture cannot be copied as it is. */
export interface JoinMismatch {
  field: 'codec' | 'profile' | 'resolution' | 'frame-rate' | 'pixel-format' | 'encoding';
  /** The file that differs (0-based). */
  index: number;
  /** Its value ("720×1280"), and the first file's ("1080×1920"). */
  value: string;
  expected: string;
}

/** POST /join/check: can these files be joined, how, and at what cost. */
export interface JoinCheck {
  files: JoinFileInfo[];
  /** Every file can be read and has a picture. */
  ok: boolean;
  /** `copy` when every file was encoded alike; else the picture must be encoded again. */
  mode: JoinMode;
  mismatches: JoinMismatch[];
  /** The joined video's length, in ms. */
  totalDurationMs: number;
  /** The files' audio sample rates differ (harmless: all of it becomes 48 kHz). */
  mixedSampleRates: boolean;
  /** Only when the picture must be encoded again: what that costs here. */
  reencode?: {
    /** The frame every file is fitted to: the size and rate most of the video already has. */
    target: { width: number; height: number; fps: number };
    /** The encoder that will do it (h264_nvenc, libx264…). */
    encoder?: string;
    /** Measured with a short test encode on this computer, in seconds; absent when it could not be measured. */
    estimatedSec?: number;
    /** The joined file's estimated size. */
    estimatedBytes?: number;
  };
  /** Free space where the project is made: the joined file is about the size of the files together. */
  disk: { folder: string; needBytes: number; freeBytes?: number; enough: boolean };
}

/** Where a join stands. `waiting`: behind another join (one runs at a time). */
export type JoinState = 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';

/** GET /projects/:id/join: a joined project's join, live. */
export interface JoinStatus {
  projectId: string;
  state: JoinState;
  mode: JoinMode;
  /** The files in order, with where each starts in the joined video. */
  files: ProjectInputFile[];
  totalDurationMs: number;
  /** 0..100 while it runs, null while unknown. */
  percent: number | null;
  /** Seconds left, once it can tell. */
  etaSec?: number;
  /** The file it is on (0-based). */
  currentFile?: number;
  startedAt: string;
  endedAt?: string;
  /** Tries so far (a restart of the app starts it again). */
  attempts: number;
  /** The activity list's entry for the current or last try. */
  activityId?: string;
  error?: AppError;
  /** Start dubbing as soon as the join is done (MCP `join_videos` start=true). */
  startWhenDone: boolean;
  /** What happened when it started the dub. */
  started?: { started?: boolean; queued?: boolean; waiting?: boolean; error?: AppError };
  /** What it made, once done. */
  result?: {
    durationMs: number;
    audioDurationMs?: number;
    sizeBytes: number;
    /** The encoder of a re-encoding join. */
    encoder?: string;
  };
}

/** POST /projects/join: a new project made from several videos, joined in this order. */
export interface JoinProjectRequest extends Omit<CreateProjectInput, 'inputVideoPath' | 'linkInputVideo' | 'source'> {
  /** Absolute paths, in the order they play. */
  videoPaths: string[];
  /** The user agreed to encode the picture again (asked when the files differ). */
  reencode?: boolean;
  /** Start dubbing as soon as the join is done. */
  start?: boolean;
}

/** POST /projects/join's answer. */
export interface JoinProjectResult {
  project: Project;
  join: JoinStatus;
}
