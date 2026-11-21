/**
 * Lines with nothing to say.
 *
 * A transcript line can hold no word at all: "…", ".", "-", "♪", or only
 * zero-width characters (whisper writes them over music). Sent to a voice
 * engine they come back as noise: VieNeu read "…" and "." as "Ơ…", and a "♪"
 * or a zero-width line became seconds of gibberish (field report B6,
 * 2026-11-18). Such a line is silence in the dub; its subtitle stays.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

import { renameReplacing } from '../fsRename.js';

/** Whether a line has anything a voice can say: a letter or a digit ("3" is spoken). Pure. */
export function hasSpeakableText(text: string | undefined): boolean {
  return text !== undefined && /[\p{L}\p{N}]/u.test(text);
}

/** A mono 16-bit PCM WAV of `ms` of silence. Pure. */
export function silentWav(ms: number, sampleRate = 24_000): Buffer {
  const samples = Math.max(1, Math.round((Math.max(0, ms) * sampleRate) / 1000));
  const data = samples * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  return buf;
}

/** How long the silent clip of a line with nothing to say is. */
export const SILENT_CLIP_MS = 120;

/**
 * Write a silent clip where a line's voice clip goes, atomically (an artifact
 * that exists is complete: CLAUDE.md), and return its length.
 */
export async function writeSilentClip(dest: string, ms = SILENT_CLIP_MS): Promise<number> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const partial = `${dest}.partial.wav`;
  await fsp.writeFile(partial, silentWav(ms));
  await renameReplacing(partial, dest);
  return ms;
}
