/**
 * A text step's saved progress, so a pause, a closed app or a crash costs at
 * most one batch: the translation step's finished lines, and the review pass's
 * finished batches. On a 31-minute dub with a local model translation took
 * 11.5 minutes and the review 16, and every stop used to start them over.
 *
 * Reused only for the very same work. The key covers everything the result
 * depends on — engine, model, languages, the lines and their timing, the
 * character sheet, the voice's pace — so a change to any of them starts
 * fresh. And a checkpoint lives only while its step is unfinished: it is
 * removed once the step's result is written, so re-running a finished step
 * (to try another engine, say) never gets the old result back.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import { writeJsonAtomic } from '../workspace/projectStore.js';

/** A key over everything a step's result depends on (any JSON values). */
export function checkpointKey(parts: readonly unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

interface CheckpointFile<T> {
  key: string;
  data: T;
  savedAt: string;
}

/** What was saved for `key`; undefined when there is no file, it is another run's, or it is unreadable. */
export async function readCheckpoint<T>(file: string, key: string): Promise<T | undefined> {
  try {
    const saved = JSON.parse(await fsp.readFile(file, 'utf8')) as Partial<CheckpointFile<T>>;
    return saved.key === key && saved.data !== undefined ? saved.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Saves a step's progress, one atomic write at a time (a write can be cut off
 * by a closing app; the previous file is then still whole).
 */
export class CheckpointWriter<T> {
  private writing: Promise<void> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly key: string,
  ) {}

  save(data: T): void {
    const snapshot: CheckpointFile<T> = { key: this.key, data, savedAt: new Date().toISOString() };
    this.writing = this.writing.then(() => writeJsonAtomic(this.file, snapshot)).catch(() => undefined);
  }

  /** Wait for the writes in flight. */
  flush(): Promise<void> {
    return this.writing;
  }

  /** The step finished: its result is written, the checkpoint has served. */
  async discard(): Promise<void> {
    await this.flush();
    await fsp.rm(this.file, { force: true });
  }
}

// ---- The translation step: finished lines by id ------------------------------

/** What a translation depends on; equal parts, equal lines. */
export interface TranslationCheckpointKeyParts {
  providerId: string;
  model?: string;
  sourceLanguage: string;
  targetLanguage: string;
  segments: ReadonlyArray<{ id: string; sourceText: string; startMs: number; endMs: number; speakerId?: string }>;
  documentContext?: unknown;
  speechRate?: number;
}

export function translationCheckpointKey(parts: TranslationCheckpointKeyParts): string {
  return checkpointKey([
    'translation',
    1, // bump when the meaning of a saved line changes
    parts.providerId,
    parts.model ?? null,
    parts.sourceLanguage,
    parts.targetLanguage,
    parts.segments.map((s) => [s.id, s.sourceText, s.startMs, s.endMs, s.speakerId ?? null]),
    parts.documentContext ?? null,
    parts.speechRate ?? null,
  ]);
}

/** The lines saved for `key`; none when there is no file, it is another translation's, or it is unreadable. */
export async function readTranslationCheckpoint(file: string, key: string): Promise<Map<string, string>> {
  const lines = await readCheckpoint<Record<string, string>>(file, key);
  if (typeof lines !== 'object' || lines === null) return new Map();
  return new Map(Object.entries(lines).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1].trim() !== ''));
}

/** Saves translated lines as batches finish. */
export class TranslationCheckpointWriter {
  private readonly lines: Map<string, string>;
  private readonly writer: CheckpointWriter<Record<string, string>>;

  constructor(file: string, key: string, initial: ReadonlyMap<string, string> = new Map()) {
    this.lines = new Map(initial);
    this.writer = new CheckpointWriter(file, key);
  }

  /** Lines the engine really translated (an empty one is no translation). */
  add(batch: ReadonlyArray<{ id: string; translatedText: string }>): void {
    let changed = false;
    for (const line of batch) {
      if (line.translatedText.trim() === '') continue;
      this.lines.set(line.id, line.translatedText);
      changed = true;
    }
    if (changed) this.writer.save(Object.fromEntries(this.lines));
  }

  flush(): Promise<void> {
    return this.writer.flush();
  }

  discard(): Promise<void> {
    return this.writer.discard();
  }
}
