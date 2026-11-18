/**
 * Music & voice separation with HTDemucs, through audio.cpp's command-line
 * tool (the `separation-htdemucs` model pack plus an `audiocpp-*` runtime).
 *
 * The audio-mix step asks for the voices and the rest of the original track
 * ("replace the voices, keep the music", runner.ts). HTDemucs makes four
 * stems at 44.1 kHz, the only rate it accepts; the media worker converts the
 * track to it and sums drums, bass and the rest back into one 48 kHz
 * accompaniment for the mix (media-worker stems.ts).
 *
 * The stems are cached in audio/stems/ with the size and modification time of
 * the track and the model, so a re-mix or re-render does not separate again
 * (the audio-mix step runs on every render). The folder is built beside and
 * renamed into place, so a cancelled run never leaves half a set of stems.
 *
 * Runtimes are tried best first (packsForProvider: Vulkan before the processor
 * build); one that cannot run here falls back to the next, and on the Mac the
 * Metal build last to its own processor backend, so installing a GPU runtime
 * never makes separation fail where the processor would have done it. (On
 * Windows the processor build is installed beside the Vulkan one instead.)
 */
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppErrorException } from '@videodubber/shared';
import type { EngineManager } from '../../engines/engineManager.js';
import { findFile } from '../../engines/engineManager.js';
import { findPack, HTDEMUCS_MODEL_FILE } from '../../engines/enginePackCatalog.js';
import type { EnginePackStore } from '../../engines/enginePackStore.js';
import { graphicsBuildRunsOnProcessor, installedPacksForProvider } from '../../engines/packSelection.js';
import type { PipelineMediaService, SeparationService } from '../../media.js';
import { writeJsonAtomic } from '../../workspace/projectStore.js';

/** What the cached stems depend on besides the track. */
const MODEL_KEY = 'htdemucs-q8_0@7a103b33';
const STEMS = ['vocals', 'drums', 'bass', 'other'] as const;

export interface CliResult {
  code: number | null;
  /** The end of what it printed (for the error a user sees). */
  output: string;
}
export type CliRunner = (exe: string, args: readonly string[], opts: { signal?: AbortSignal; cwd?: string }) => Promise<CliResult>;

/** Run a command (argv, no shell), keeping the last 4 KB of its output; killed when `signal` aborts. */
export const runCli: CliRunner = (exe, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(exe, [...args], { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-4096);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (err) => {
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, output });
    });
  });

interface StemsManifest {
  audio: { sizeBytes: number; mtimeMs: number };
  model: string;
}

export interface AudioCppSeparationDeps {
  engines: Pick<EngineManager, 'claimForJob'>;
  store: EnginePackStore;
  media: Pick<PipelineMediaService, 'prepareStemInput' | 'mixStems'>;
  run?: CliRunner;
  /** The performance cores (system/performanceCores.ts); undefined = 4. */
  threads?: () => Promise<number | undefined>;
  logger?: { warn(message: string): void };
}

const isFile = (p: string) =>
  fsp.stat(p).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  );

/**
 * The separated voices of `audioPath`, when stems made from it exactly as it
 * is now are already in `<outputDir>/stems` (a render with "replace the
 * voices" made them); undefined otherwise. Reads only, never separates.
 */
export async function currentVocals(audioPath: string, outputDir: string): Promise<string | undefined> {
  const stemsDir = path.join(outputDir, 'stems');
  const vocals = path.join(stemsDir, 'vocals.wav');
  try {
    const [stat, have] = await Promise.all([
      fsp.stat(audioPath),
      fsp.readFile(path.join(stemsDir, 'stems.json'), 'utf8').then((t) => JSON.parse(t) as StemsManifest),
    ]);
    const current =
      have.model === MODEL_KEY && have.audio?.sizeBytes === stat.size && have.audio?.mtimeMs === Math.round(stat.mtimeMs);
    return current && (await isFile(vocals)) ? vocals : undefined;
  } catch {
    return undefined;
  }
}

export class AudioCppSeparationProvider implements SeparationService {
  constructor(private readonly deps: AudioCppSeparationDeps) {}

  private async modelPath(): Promise<string | undefined> {
    const rec = await this.deps.store.get('separation-htdemucs');
    const file = rec ? path.join(rec.path, HTDEMUCS_MODEL_FILE) : undefined;
    return file && (await isFile(file)) ? file : undefined;
  }

  async available(): Promise<boolean> {
    if (!this.deps.media.prepareStemInput || !this.deps.media.mixStems) return false;
    if (!(await this.modelPath())) return false;
    return (await installedPacksForProvider(this.deps.store, 'audio-cpp')).length > 0;
  }

  async separate(
    audioPath: string,
    outputDir: string,
    signal?: AbortSignal,
  ): Promise<{ vocalsPath: string; accompanimentPath: string } | null> {
    const { prepareStemInput, mixStems } = this.deps.media;
    const model = await this.modelPath();
    const runtimes = await installedPacksForProvider(this.deps.store, 'audio-cpp');
    if (!model || runtimes.length === 0 || !prepareStemInput || !mixStems) return null;

    const stemsDir = path.join(outputDir, 'stems');
    const result = { vocalsPath: path.join(stemsDir, 'vocals.wav'), accompanimentPath: path.join(stemsDir, 'accompaniment.wav') };
    const stat = await fsp.stat(audioPath);
    const want: StemsManifest = { audio: { sizeBytes: stat.size, mtimeMs: Math.round(stat.mtimeMs) }, model: MODEL_KEY };
    const have = await fsp
      .readFile(path.join(stemsDir, 'stems.json'), 'utf8')
      .then((t) => JSON.parse(t) as StemsManifest)
      .catch(() => undefined);
    if (
      have &&
      JSON.stringify(have) === JSON.stringify(want) &&
      (await isFile(result.vocalsPath)) &&
      (await isFile(result.accompanimentPath))
    ) {
      return result;
    }

    await this.deps.engines.claimForJob('Music and voice separation');
    const work = `${stemsDir}.partial-${crypto.randomBytes(4).toString('hex')}`;
    await fsp.mkdir(path.join(work, 'raw'), { recursive: true });
    try {
      const input = path.join(work, 'input-44k.wav');
      await prepareStemInput.call(this.deps.media, audioPath, input, signal);
      await this.runSeparation(runtimes, model, input, path.join(work, 'raw'), signal);
      const raw = (s: string) => path.join(work, 'raw', `${s}.wav`);
      await mixStems.call(this.deps.media, [raw('vocals')], path.join(work, 'vocals.wav'), signal);
      await mixStems.call(this.deps.media, [raw('drums'), raw('bass'), raw('other')], path.join(work, 'accompaniment.wav'), signal);
      await fsp.rm(path.join(work, 'raw'), { recursive: true, force: true });
      await fsp.rm(input, { force: true });
      await writeJsonAtomic(path.join(work, 'stems.json'), want);
      await fsp.rm(stemsDir, { recursive: true, force: true });
      await fsp.rename(work, stemsDir);
    } catch (err) {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
    return result;
  }

  /** HTDemucs on the best runtime that runs here, each graphics build falling back to its processor backend. */
  private async runSeparation(runtimes: readonly string[], model: string, input: string, outDir: string, signal?: AbortSignal): Promise<void> {
    const run = this.deps.run ?? runCli;
    const exeName = process.platform === 'win32' ? 'audiocpp_cli.exe' : 'audiocpp_cli';
    const attempts: { exe: string; backend: string }[] = [];
    for (const packId of runtimes) {
      const rec = await this.deps.store.get(packId);
      const exe = rec ? await findFile(rec.path, exeName) : undefined;
      if (!exe) continue;
      attempts.push({ exe, backend: findPack(packId)?.accel ?? 'cpu' });
    }
    // Each graphics build's own processor backend comes after all the graphics
    // ones, where it runs: on Windows the Vulkan build's dies at once with an
    // illegal instruction, and the processor build installed beside it is the
    // fallback instead (packSelection.companionRuntimesFor).
    if (graphicsBuildRunsOnProcessor('audio-cpp')) {
      for (const a of [...attempts]) if (a.backend !== 'cpu' && !attempts.some((b) => b.exe === a.exe && b.backend === 'cpu')) attempts.push({ exe: a.exe, backend: 'cpu' });
    }
    const threads = (await this.deps.threads?.().catch(() => undefined)) ?? 4;
    let lastError = 'no audio.cpp runtime found in the installed packs';
    for (const a of attempts) {
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled');
      const args = ['--task', 'sep', '--family', 'htdemucs', '--model', model, '--backend', a.backend, '--threads', String(threads), '--audio', input, '--out-dir', outDir];
      const res = await run(a.exe, args, { cwd: path.dirname(a.exe), ...(signal ? { signal } : {}) });
      if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('cancelled');
      const stems = await Promise.all(STEMS.map((s) => isFile(path.join(outDir, `${s}.wav`))));
      if (res.code === 0 && stems.every(Boolean)) return;
      lastError = `${a.backend}: exit ${res.code}: ${res.output.trim().split('\n').slice(-2).join(' ')}`;
      this.deps.logger?.warn(`Music and voice separation could not run on ${a.backend} (${lastError}); trying the next way.`);
    }
    throw new AppErrorException('ENGINE_UNAVAILABLE', 'Music and voice separation could not run on this computer.', {
      cause: lastError,
      remediation:
        process.platform === 'win32'
          ? 'Install "audio.cpp (processor)" in Settings → Engines: it runs on any computer, more slowly. Until then the original is turned down under the dub.'
          : 'Reinstall "Music & voice separation" in Settings → Engines. Until then the original is turned down under the dub.',
    });
  }
}
