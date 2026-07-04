/**
 * Detect default-pipeline models that are PRESENT ON DISK but may not be recorded
 * in setup.json yet — chiefly the bundled default set (whisper 'small' + en->vi
 * Argos + the vi Piper voice) that the desktop shell seed-copies into the model
 * dirs on first launch, but also anything a user dropped in by hand.
 *
 * The {@link SetupStore} reconciles its recorded inventory with this on startup
 * so a project's required-resource check never tries to re-download a model
 * that's already there (which would fail offline, defeating the bundled set).
 *
 * Detection is deliberately conservative: a model counts only when its real
 * payload is present (a snapshot blob / the Argos `model` dir / the paired
 * `.onnx.json`), so a half-written or empty dir is never reported as installed.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ArgosPair, InstalledModels } from '@videodubber/shared';

/** A standard Systran faster-whisper hub-cache dir -> the curated model id. */
const WHISPER_DIR_RE = /^models--Systran--faster-whisper-(.+)$/;
/** An argostranslate installed-package dir -> its language pair. */
const ARGOS_DIR_RE = /^translate-([a-z]{2,3})_([a-z]{2,3})-/i;

async function listDir(dir: string): Promise<string[]> {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/** True if `dir` exists and holds at least one entry. */
async function isNonEmptyDir(dir: string): Promise<boolean> {
  return (await listDir(dir)).length > 0;
}

export interface DetectModelDirs {
  /** Where Argos + Piper live (`<config>/models`). */
  readonly modelsDir: string;
  /** The resolved faster-whisper hub cache (honours STT_MODEL_CACHE_DIR). */
  readonly whisperCacheDir: string;
}

/** Scan the model dirs and return the default-pipeline models found on disk. */
export async function detectInstalledModels(dirs: DetectModelDirs): Promise<InstalledModels> {
  const whisperModels: string[] = [];
  const argosPairs: ArgosPair[] = [];
  const piperVoices: string[] = [];

  // STT — faster-whisper hub cache. Present only if the dir holds snapshot blobs.
  for (const name of await listDir(dirs.whisperCacheDir)) {
    const id = WHISPER_DIR_RE.exec(name)?.[1];
    if (id && (await isNonEmptyDir(path.join(dirs.whisperCacheDir, name, 'blobs')))) {
      whisperModels.push(id);
    }
  }

  // Translation — argostranslate installed packages. Require the `model` payload.
  const argosDir = path.join(dirs.modelsDir, 'argos');
  for (const name of await listDir(argosDir)) {
    const m = ARGOS_DIR_RE.exec(name);
    const from = m?.[1]?.toLowerCase();
    const to = m?.[2]?.toLowerCase();
    if (from && to && (await isNonEmptyDir(path.join(argosDir, name, 'model')))) {
      argosPairs.push({ from, to });
    }
  }

  // TTS — a Piper voice is `<voiceId>.onnx` paired with `<voiceId>.onnx.json`.
  const piperEntries = await listDir(path.join(dirs.modelsDir, 'piper'));
  const piperSet = new Set(piperEntries);
  for (const name of piperEntries) {
    if (name.endsWith('.onnx') && piperSet.has(`${name}.json`)) {
      piperVoices.push(name.slice(0, -'.onnx'.length));
    }
  }

  return { whisperModels, argosPairs, piperVoices };
}
