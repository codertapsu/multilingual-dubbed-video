import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnginePackStore } from '../../engines/enginePackStore.js';
import { FakeMediaService } from '../../test/fixtures.js';
import { AudioCppSeparationProvider, type CliRunner } from './audioCppSeparationProvider.js';

const EXE = process.platform === 'win32' ? 'audiocpp_cli.exe' : 'audiocpp_cli';
/** The processor-or-Metal runtime the catalog offers on this platform (none on Linux). */
const RUNTIME = ({ win32: 'audiocpp-cpu', darwin: 'audiocpp-metal' } as Partial<Record<NodeJS.Platform, string>>)[process.platform];

describe.skipIf(!RUNTIME || process.arch !== (process.platform === 'darwin' ? 'arm64' : 'x64'))('music & voice separation (audio.cpp)', () => {
  let tmp: string;
  let store: EnginePackStore;
  let audio: string;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-sep-'));
    store = new EnginePackStore(path.join(tmp, 'config'));
    audio = path.join(tmp, 'p', 'audio', 'original.wav');
    await fsp.mkdir(path.dirname(audio), { recursive: true });
    await fsp.writeFile(audio, 'RIFF-original');
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function install(...packs: string[]): Promise<void> {
    for (const id of packs) {
      const dir = path.join(tmp, 'packs', id);
      await fsp.mkdir(dir, { recursive: true });
      if (id === 'separation-htdemucs') await fsp.writeFile(path.join(dir, 'htdemucs-q8_0.gguf'), 'gguf');
      else await fsp.writeFile(path.join(dir, EXE), 'bin');
      await store.add({ id, path: dir, version: 'test', installedAt: new Date().toISOString() });
    }
  }

  /** A CLI that fails on the backends listed and otherwise writes the four stems. */
  function cli(failOn: string[] = []) {
    const calls: string[] = [];
    const run: CliRunner = vi.fn(async (_exe, args) => {
      const backend = args[args.indexOf('--backend') + 1]!;
      calls.push(backend);
      if (failOn.includes(backend)) return { code: 1, output: 'ggml_vulkan: no device' };
      const out = args[args.indexOf('--out-dir') + 1]!;
      for (const s of ['vocals', 'drums', 'bass', 'other']) await fsp.writeFile(path.join(out, `${s}.wav`), s);
      return { code: 0, output: 'ok' };
    });
    return { run, calls };
  }

  const provider = (run: CliRunner, media = new FakeMediaService(), claim = vi.fn(async () => undefined)) =>
    new AudioCppSeparationProvider({ engines: { claimForJob: claim }, store, media, run, threads: async () => 6 });

  it('does nothing until the model and a runtime are installed', async () => {
    const { run } = cli();
    expect(await provider(run).available()).toBe(false);
    expect(await provider(run).separate(audio, path.dirname(audio))).toBeNull();
    await install('separation-htdemucs');
    expect(await provider(run).available()).toBe(false);
    await install(RUNTIME!);
    expect(await provider(run).available()).toBe(true);
  });

  it('separates once on the best runtime, then reuses the stems for this track', async () => {
    await install('separation-htdemucs', RUNTIME!, ...(process.platform === 'win32' ? ['audiocpp-vulkan'] : []));
    const { run, calls } = cli();
    const media = new FakeMediaService();
    const claim = vi.fn(async () => undefined);
    const p = provider(run, media, claim);
    const out = await p.separate(audio, path.dirname(audio));
    expect(out).toEqual({
      vocalsPath: path.join(path.dirname(audio), 'stems', 'vocals.wav'),
      accompanimentPath: path.join(path.dirname(audio), 'stems', 'accompaniment.wav'),
    });
    if (process.platform === 'win32') expect(calls).toEqual(['vulkan']);
    expect(claim).toHaveBeenCalledTimes(1);
    // The music is three stems summed; the voices one converted.
    expect(media.calls.filter((c) => c.startsWith('mixStems:'))).toEqual(['mixStems:1', 'mixStems:3']);
    // Nothing of the work folder is left beside the stems.
    expect((await fsp.readdir(path.dirname(audio))).sort()).toEqual(['original.wav', 'stems']);

    await p.separate(audio, path.dirname(audio));
    expect(run).toHaveBeenCalledTimes(1);
    // A re-extracted track is separated again.
    await fsp.writeFile(audio, 'RIFF-another-track');
    await p.separate(audio, path.dirname(audio));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('falls back from the graphics card to the processor build when the card cannot run it', async () => {
    if (process.platform !== 'win32') return; // the Vulkan build is Windows-only
    await install('separation-htdemucs', 'audiocpp-vulkan', 'audiocpp-cpu');
    const exes: string[] = [];
    const { run: inner, calls } = cli(['vulkan']);
    const run: CliRunner = async (exe, args, opts) => {
      exes.push(path.basename(path.dirname(exe)));
      return inner(exe, args, opts);
    };
    const warn = vi.fn();
    const p = new AudioCppSeparationProvider({
      engines: { claimForJob: async () => undefined },
      store,
      media: new FakeMediaService(),
      run,
      logger: { warn },
    });
    expect(await p.separate(audio, path.dirname(audio))).not.toBeNull();
    // The processor BUILD, never the Vulkan build's own processor backend:
    // that one dies with an illegal instruction on CPUs it was not built for.
    expect(calls).toEqual(['vulkan', 'cpu']);
    expect(exes).toEqual(['audiocpp-vulkan', 'audiocpp-cpu']);
    expect(warn.mock.calls[0]![0]).toMatch(/could not run on vulkan/);
  });

  it("on Windows never tries the Vulkan build's own processor backend", async () => {
    if (process.platform !== 'win32') return;
    await install('separation-htdemucs', 'audiocpp-vulkan');
    const { run, calls } = cli(['vulkan']);
    const p = new AudioCppSeparationProvider({ engines: { claimForJob: async () => undefined }, store, media: new FakeMediaService(), run });
    await expect(p.separate(audio, path.dirname(audio))).rejects.toMatchObject({
      appError: { code: 'ENGINE_UNAVAILABLE', remediation: expect.stringMatching(/audio\.cpp \(processor\)/) },
    });
    expect(calls).toEqual(['vulkan']);
  });

  it('a pause stops it and leaves no half set of stems', async () => {
    await install('separation-htdemucs', RUNTIME!);
    const controller = new AbortController();
    const run: CliRunner = async () => {
      controller.abort(new Error('paused'));
      return { code: null, output: '' };
    };
    await expect(provider(run).separate(audio, path.dirname(audio), controller.signal)).rejects.toThrow('paused');
    expect(await fsp.readdir(path.dirname(audio))).toEqual(['original.wav']);
  });
});
