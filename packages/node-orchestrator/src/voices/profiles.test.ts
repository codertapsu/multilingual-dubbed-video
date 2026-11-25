import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppErrorException, type TtsInput, type VoiceProfile } from '@videodubber/shared';
import { ProviderRegistry } from '../providers/registry.js';
import type { CancellableTtsProvider, VoiceCloner } from '../providers/types.js';
import { acceptConsent, CONSENT_VERSION, consentStatements } from './consent.js';
import { VoiceProfileService } from './profileService.js';
import { isValidProfileId, projectOfProfileId, VoiceProfileStore } from './profileStore.js';
import { checkProfileVoices } from './projectVoices.js';
import { ReferencePrep } from './referencePrep.js';

const PROJECT = `proj_${'a'.repeat(32)}`;

/** A WAV of `ms` milliseconds: silence, then a tone from 300 ms to `ms - 300`. */
function toneWav(ms: number, rate: number): Buffer {
  const n = Math.round((ms * rate) / 1000);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = (i * 1000) / rate;
    const v = t > 300 && t < ms - 300 ? 0.3 * Math.sin((2 * Math.PI * 220 * i) / rate) : 0.0005 * Math.sin(i);
    data.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/** ffmpeg stand-in: "decodes" any input to a tone of the input's notional length. */
function fakeMedia(sourceMs: number) {
  return {
    referenceClip: vi.fn(async (_in: string, out: string, opts: { startMs?: number; endMs?: number; sampleRate?: number }) => {
      const start = opts.startMs ?? 0;
      const ms = Math.max(0, Math.min(opts.endMs ?? sourceMs, sourceMs) - start);
      await fsp.writeFile(out, toneWav(ms, opts.sampleRate ?? 48_000));
      return { audioPath: out, sampleRate: opts.sampleRate ?? 48_000, channels: 1, durationMs: ms };
    }),
  };
}

class FakeCloner implements CancellableTtsProvider, VoiceCloner {
  readonly isLocal = true;
  readonly displayName = 'VieNeu-TTS 3.8';
  enrollCalls: string[] = [];
  failEnroll = false;
  synthVoices: (string | undefined)[] = [];
  constructor(
    readonly id: string,
    private readonly resolver?: VoiceProfileService,
  ) {}
  async enroll(referencePath: string, outPath: string) {
    this.enrollCalls.push(referencePath);
    await new Promise((r) => setTimeout(r, 5));
    if (this.failEnroll) throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'engine refused');
    await fsp.writeFile(outPath, 'npz');
    return { fingerprint: 'f'.repeat(64), engineVersion: '3.8.4', codeFrames: 120 };
  }
  async synthesizeSegments(input: TtsInput) {
    this.synthVoices.push(input.voiceId);
    if (this.resolver && input.voiceId?.startsWith('vp_')) {
      await this.resolver.resolve(input.voiceId, this.id, (r, o) => this.enroll(r, o));
    }
    await fsp.mkdir(input.outputDir, { recursive: true });
    const out = path.join(input.outputDir, 'segment_0001.wav');
    await fsp.writeFile(out, toneWav(1500, 48_000));
    return { segments: [{ segmentId: 'seg_0001', text: '', audioPath: out, durationMs: 1500, startMs: 0, endMs: 1500, speedRatio: 1 }] };
  }
}

describe('consent', () => {
  it('stores the literal statement in the language shown, with its version', () => {
    const c = acceptConsent({ accepted: true, relation: 'self', statementVersion: CONSENT_VERSION, locale: 'vi' }, 'library', new Date('2026-11-18T10:00:00Z'));
    expect(c).toEqual({
      statementVersion: CONSENT_VERSION,
      statementText: consentStatements('vi').statements.self,
      acceptedAt: '2026-11-18T10:00:00.000Z',
      relation: 'self',
      method: 'declaration',
    });
    expect(acceptConsent({ accepted: true, relation: 'authorized', statementVersion: CONSENT_VERSION, locale: 'en' }, 'library').statementText).toMatch(
      /owner of this voice has agreed/,
    );
  });

  it('refuses no answer, an old statement, and a source-video voice outside its project', () => {
    const code = (fn: () => unknown) => {
      try {
        fn();
      } catch (err) {
        return (err as AppErrorException).code;
      }
      return 'none';
    };
    expect(code(() => acceptConsent(undefined, 'library'))).toBe('VOICE_CONSENT_REQUIRED');
    expect(code(() => acceptConsent({ accepted: false, relation: 'self', statementVersion: CONSENT_VERSION }, 'library'))).toBe('VOICE_CONSENT_REQUIRED');
    expect(code(() => acceptConsent({ accepted: true, relation: 'self', statementVersion: '2020-01-01' }, 'library'))).toBe('VOICE_CONSENT_REQUIRED');
    expect(code(() => acceptConsent({ accepted: true, relation: 'boss', statementVersion: CONSENT_VERSION }, 'library'))).toBe('VOICE_CONSENT_REQUIRED');
    expect(code(() => acceptConsent({ accepted: true, relation: 'source-video', statementVersion: CONSENT_VERSION }, 'library'))).toBe(
      'VOICE_CONSENT_REQUIRED',
    );
    expect(code(() => acceptConsent({ accepted: true, relation: 'source-video', statementVersion: CONSENT_VERSION }, 'project'))).toBe('none');
  });
});

describe('voice profiles', () => {
  let tmp: string;
  let store: VoiceProfileStore;
  let prep: ReferencePrep;
  let cloner: FakeCloner;
  let service: VoiceProfileService;
  let registry: ProviderRegistry;
  const consent = { accepted: true, relation: 'self', statementVersion: CONSENT_VERSION, locale: 'vi' };

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-profiles-'));
    store = new VoiceProfileStore(path.join(tmp, 'config'), path.join(tmp, 'projects'));
    prep = new ReferencePrep({ workRoot: path.join(tmp, 'config', 'voices', 'work'), media: fakeMedia(12_000) });
    registry = new ProviderRegistry();
    service = new VoiceProfileService({
      store,
      prep,
      registry: () => registry,
      projectExists: async (id) => id === PROJECT,
      now: () => new Date('2026-11-18T10:00:00Z'),
    });
    cloner = new FakeCloner('vieneu-tts', service);
    registry.registerTts(cloner);
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function analysed() {
    const src = path.join(tmp, 'me.m4a');
    await fsp.writeFile(src, 'whatever the user had');
    return prep.analyze(src, { minSpeechMs: 3000, idealMs: 8000, maxMs: 8000, transcript: 'unused' }, { sourceName: 'me.m4a' });
  }

  it('names library and project voices so a project voice is found inside its project', () => {
    const lib = store.newId({ kind: 'library' });
    const own = store.newId({ kind: 'project', projectId: PROJECT });
    expect(isValidProfileId(lib) && isValidProfileId(own)).toBe(true);
    expect(projectOfProfileId(lib)).toBeUndefined();
    expect(projectOfProfileId(own)).toBe(PROJECT);
    expect(store.dirOf(own)).toBe(path.join(tmp, 'projects', PROJECT, 'voices', own));
    expect(() => store.dirOf('vp_../../etc')).toThrow();
  });

  it('analyses a recording: speech, the best window, and its checks', async () => {
    const a = await analysed();
    expect(a.detector).toBe('energy');
    expect(a.durationMs).toBe(12_000);
    expect(a.window.endMs - a.window.startMs).toBeLessThanOrEqual(8000);
    expect(a.checks.speechMs).toBeGreaterThan(6000);
    expect(a.peaks.length).toBeGreaterThan(100);
  });

  it('makes a voice: consent, levelled reference, enrollment, preview, and no work left behind', async () => {
    const a = await analysed();
    const p = await service.create({ analysisId: a.analysisId, window: a.window, name: '  Giọng của tôi  ', engine: 'vieneu', consent });
    expect(p).toMatchObject({
      name: 'Giọng của tôi',
      engine: 'vieneu',
      scope: { kind: 'library' },
      consent: { relation: 'self', statementVersion: CONSENT_VERSION },
      enrollments: { vieneu: { file: 'vieneu.npz', fingerprint: 'f'.repeat(64), engineVersion: '3.8.4' } },
      reference: { file: 'reference.wav', sampleRate: 48000 },
    });
    expect(p.reference!.sha256).toMatch(/^[0-9a-f]{64}$/);
    const files = (await fsp.readdir(store.dirOf(p.id))).sort();
    expect(files).toEqual(['preview.wav', 'profile.json', 'reference.wav', 'vieneu.npz']);
    expect(await fsp.readdir(path.join(tmp, 'config', 'voices', 'work')).catch(() => [])).toEqual([]);
    expect((await store.list()).map((x) => x.id)).toEqual([p.id]);
  });

  it('keeps only the voice data when the user says so', async () => {
    const a = await analysed();
    const p = await service.create({ analysisId: a.analysisId, window: a.window, name: 'x', consent, keepRecording: false });
    expect(p.reference).toBeUndefined();
    expect(await fsp.readdir(store.dirOf(p.id))).not.toContain('reference.wav');
  });

  it('refuses without consent before touching the recording', async () => {
    const a = await analysed();
    await expect(service.create({ analysisId: a.analysisId, window: a.window, name: 'x' })).rejects.toMatchObject({
      appError: { code: 'VOICE_CONSENT_REQUIRED' },
    });
    expect(cloner.enrollCalls).toEqual([]);
    expect(await fsp.readdir(store.libraryRoot()).catch(() => [])).toEqual([]);
  });

  it('refuses a window with too little speech, and an engine that cannot clone', async () => {
    const a = await analysed();
    await expect(
      service.create({ analysisId: a.analysisId, window: { startMs: 0, endMs: 2000 }, name: 'x', consent }),
    ).rejects.toMatchObject({ appError: { code: 'VOICE_REFERENCE_REJECTED' } });
    await expect(
      service.create({ analysisId: a.analysisId, window: a.window, name: 'x', consent, engine: 'piper' }),
    ).rejects.toMatchObject({ appError: { code: 'VOICE_ENGINE_CANNOT_CLONE' } });
  });

  it('leaves nothing behind when the engine refuses the recording', async () => {
    const a = await analysed();
    cloner.failEnroll = true;
    await expect(service.create({ analysisId: a.analysisId, window: a.window, name: 'x', consent })).rejects.toThrow('engine refused');
    expect(await fsp.readdir(store.libraryRoot()).catch(() => [])).toEqual([]);
  });

  it('keeps project voices inside their project, with the source-video statement', async () => {
    const a = await analysed();
    const p = await service.create({
      analysisId: a.analysisId,
      window: a.window,
      name: 'Người nói 1',
      consent: { ...consent, relation: 'source-video' },
      projectId: PROJECT,
    });
    expect(p.scope).toEqual({ kind: 'project', projectId: PROJECT });
    expect(await store.list()).toEqual([]);
    expect((await store.list(PROJECT)).map((x) => x.id)).toEqual([p.id]);
    await expect(
      service.create({ analysisId: (await analysed()).analysisId, window: a.window, name: 'x', consent, projectId: `proj_${'b'.repeat(32)}` }),
    ).rejects.toMatchObject({ appError: { code: 'VOICE_REFERENCE_REJECTED' } });
  });

  it('speaks a voice from its enrollment, and enrolls a kept recording once for a new engine', async () => {
    const a = await analysed();
    const p = await service.create({ analysisId: a.analysisId, window: a.window, name: 'x', consent });
    const enroll = vi.fn(async (_ref: string, out: string) => {
      await fsp.writeFile(out, 'npz');
      return { fingerprint: 'e'.repeat(64), engineVersion: '3.8.4' };
    });
    expect(await service.resolve(p.id, 'vieneu-tts', enroll)).toEqual({
      file: path.join(store.dirOf(p.id), 'vieneu.npz'),
      fingerprint: 'f'.repeat(64),
    });
    expect(enroll).not.toHaveBeenCalled();

    // The enrollment file is gone (e.g. cleaned up): made again from the recording, once.
    await fsp.rm(path.join(store.dirOf(p.id), 'vieneu.npz'));
    const [r1, r2] = await Promise.all([service.resolve(p.id, 'vieneu-tts', enroll), service.resolve(p.id, 'vieneu-tts', enroll)]);
    expect(enroll).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
    expect((await store.get(p.id))!.enrollments.vieneu!.fingerprint).toBe('e'.repeat(64));
  });

  it('never speaks a cloned voice in another voice', async () => {
    const a = await analysed();
    const p = await service.create({ analysisId: a.analysisId, window: a.window, name: 'x', consent, keepRecording: false });
    await fsp.rm(path.join(store.dirOf(p.id), 'vieneu.npz'));
    const enroll = vi.fn();
    await expect(service.resolve(p.id, 'vieneu-tts', enroll)).rejects.toMatchObject({ appError: { code: 'VOICE_REFERENCE_REJECTED' } });
    await expect(service.resolve(p.id, 'neural-tts', enroll)).rejects.toMatchObject({ appError: { code: 'VOICE_ENGINE_CANNOT_CLONE' } });
    await expect(service.resolve('vp_0123456789abcdef', 'vieneu-tts', enroll)).rejects.toMatchObject({ appError: { code: 'TTS_VOICE_MISSING' } });
    expect(enroll).not.toHaveBeenCalled();
  });

  it('renames, and deletes a voice with its recording and consent record', async () => {
    const a = await analysed();
    const p = await service.create({ analysisId: a.analysisId, window: a.window, name: 'x', consent });
    expect((await service.rename(p.id, { name: 'Giọng kể chuyện', note: 'đọc chậm' })).name).toBe('Giọng kể chuyện');
    // Kept for one main character, and shared again; a rename leaves the flag as it is.
    expect((await service.rename(p.id, { mainOnly: true })).mainOnly).toBe(true);
    expect((await service.rename(p.id, { name: 'Giọng của tôi' })).mainOnly).toBe(true);
    expect(await service.rename(p.id, { mainOnly: false })).not.toHaveProperty('mainOnly');
    expect(await service.delete(p.id)).toBe(true);
    await expect(fsp.stat(store.dirOf(p.id))).rejects.toThrow();
    expect(await service.delete(p.id)).toBe(false);
  });

  it('checks cloned voices at Start', async () => {
    const a = await analysed();
    const kept = await service.create({ analysisId: a.analysisId, window: a.window, name: 'kept', consent });
    const lean = await service.create({
      analysisId: (await analysed()).analysisId,
      window: a.window,
      name: 'lean',
      consent,
      keepRecording: false,
    });
    const get = (id: string) => store.get(id);
    expect(await checkProfileVoices({ ttsProviderId: 'vieneu-tts', ttsVoiceId: kept.id }, get)).toEqual([]);
    expect(await checkProfileVoices({ ttsProviderId: 'neural-tts', ttsVoiceId: kept.id }, get)).toMatchObject([{ kind: 'cannot-clone' }]);
    expect(await checkProfileVoices({ ttsProviderId: 'vieneu-tts', ttsVoiceId: 'vp_0123456789abcdef' }, get)).toMatchObject([{ kind: 'unknown' }]);
    // Made for vieneu, so fine there even without its recording.
    expect(await checkProfileVoices({ ttsProviderId: 'vieneu-tts', ttsVoiceId: lean.id }, get)).toEqual([]);
    const profile = (await store.get(lean.id)) as VoiceProfile;
    await store.save({ ...profile, enrollments: {} });
    expect(await checkProfileVoices({ ttsProviderId: 'vieneu-tts', ttsVoiceId: lean.id }, get)).toMatchObject([{ kind: 'no-recording' }]);
  });
});
