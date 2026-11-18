/**
 * The user's favourite voices: `<configDir>/voices/favorites.json`, a plain list
 * of voice ids (presets and profiles alike), written atomically.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../workspace/projectStore.js';

const ID = /^[\w.#:-]{1,200}$/u;

export class VoiceFavorites {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(configDir: string) {
    this.file = path.join(configDir, 'voices', 'favorites.json');
  }

  async list(): Promise<Set<string>> {
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8')) as unknown;
      return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && ID.test(x)) : []);
    } catch {
      return new Set();
    }
  }

  /** Turn one favourite on or off; serialized so two quick clicks never lose one. */
  set(voiceId: string, favorite: boolean): Promise<Set<string>> {
    const run = this.queue.then(async () => {
      if (!ID.test(voiceId)) throw new Error(`Not a voice id: "${voiceId}"`);
      const all = await this.list();
      if (favorite) all.add(voiceId);
      else all.delete(voiceId);
      await writeJsonAtomic(this.file, [...all].sort());
      return all;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }
}
