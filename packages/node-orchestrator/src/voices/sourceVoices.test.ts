import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toHttpError } from '../httpErrors.js';
import { ProviderRegistry } from '../providers/registry.js';
import { CONSENT_VERSION } from './consent.js';
import { registerProfileRoutes } from './profileRoutes.js';
import { VoiceProfileService } from './profileService.js';
import { VoiceProfileStore } from './profileStore.js';
import { parseWavPcm16 } from './referenceAnalysis.js';
import { ReferencePrep } from './referencePrep.js';
import { analyzeProjectSource, encodePcmWav, joinPcm, pickLineRanges, speakerLineRanges } from './sourceVoices.js';
import { makeSpeakerVoices } from './speakerVoices.js';

const PROJECT = `proj_${'d'.repeat(32)}`;
const POLICY = { minSpeechMs: 3000, idealMs: 8000, maxMs: 8000, transcript: 'unused' as const };

function tone(ms: number, rate = 48_000): Buffer {
  const n = Math.round((ms * rate) / 1000);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * 200 * i) / rate));
  return encodePcmWav({ sampleRate: rate, samples });
}

describe('voices from a project video', () => {
  it('picks the chosen lines in order, merges touching ones, and caps the total', () => {
    const segs = [
      { id: 'a', startMs: 1000, endMs: 3000 },
      { id: 'b', startMs: 3100, endMs: 5000 },
      { id: 'c', startMs: 9000, endMs: 12_000 },
      { id: 'd', startMs: 20_000, endMs: 90_000 },
    ];
    expect(pickLineRanges(segs, ['c', 'a', 'b', 'zzz'])).toEqual([
      { startMs: 1000, endMs: 5000 },
      { startMs: 9000, endMs: 12_000 },
    ]);
    expect(pickLineRanges(segs, ['d'], 60_000)).toEqual([{ startMs: 20_000, endMs: 80_000 }]);
    expect(pickLineRanges(segs, [])).toEqual([]);
  });

  it("takes a speaker's longest clean lines, never their crosstalk, and lists only what it used", () => {
    const segs = [
      { id: 's1', startMs: 0, endMs: 2000, speakerId: 'SPEAKER_00' },
      { id: 's2', startMs: 3000, endMs: 9000, speakerId: 'SPEAKER_00' },
      { id: 'o1', startMs: 9500, endMs: 12_000, speakerId: 'SPEAKER_01' },
      { id: 's3', startMs: 11_000, endMs: 15_000, speakerId: 'SPEAKER_00' }, // over SPEAKER_01
      { id: 's4', startMs: 20_000, endMs: 24_000, speakerId: 'SPEAKER_00' },
    ];
    // 6 s + 4 s, longest first, never s3; in time order.
    expect(speakerLineRanges(segs, 'SPEAKER_00', 10_000)).toEqual({
      ranges: [
        { startMs: 3000, endMs: 9000 },
        { startMs: 20_000, endMs: 24_000 },
      ],
      segmentIds: ['s2', 's4'],
    });
    // Only crosstalk: better than nothing.
    expect(speakerLineRanges(segs, 'SPEAKER_01').segmentIds).toEqual(['o1']);
    expect(speakerLineRanges(segs, 'SPEAKER_07')).toEqual({ ranges: [], segmentIds: [] });
    // A cap that trims a line away does not list it.
    expect(speakerLineRanges(segs, 'SPEAKER_00', 6000).segmentIds).toEqual(['s2']);
  });

  it('joins clips with a short pause, and refuses mixed rates', () => {
    const a = { sampleRate: 1000, samples: new Int16Array([1, 2]) };
    const b = { sampleRate: 1000, samples: new Int16Array([3]) };
    expect(Array.from(joinPcm([a, b], 3).samples)).toEqual([1, 2, 0, 0, 0, 3]);
    expect(() => joinPcm([a, { sampleRate: 2000, samples: new Int16Array(1) }])).toThrow();
    expect(parseWavPcm16(encodePcmWav(a)).samples).toEqual(a.samples);
  });

  describe('end to end with a fake ffmpeg', () => {
    let tmp: string;
    let prep: ReferencePrep;
    let media: { referenceClip: ReturnType<typeof vi.fn> };

    beforeEach(async () => {
      tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-source-'));
      await fsp.mkdir(path.join(tmp, 'p'), { recursive: true });
      await fsp.writeFile(path.join(tmp, 'p', 'original.wav'), tone(30_000));
      await fsp.writeFile(
        path.join(tmp, 'p', 'source.json'),
        JSON.stringify({ segments: [{ id: 'seg_0001', startMs: 2000, endMs: 6000 }, { id: 'seg_0002', startMs: 10_000, endMs: 13_000 }] }),
      );
      // Like ffmpeg here: the output is as long as the requested part of the input.
      media = {
        referenceClip: vi.fn(async (input: string, out: string, o: { startMs?: number; endMs?: number; maxMs?: number; sampleRate?: number }) => {
          const src = parseWavPcm16(await fsp.readFile(input));
          const total = Math.round((src.samples.length * 1000) / src.sampleRate);
          const start = o.startMs ?? 0;
          const ms = Math.max(0, Math.min(o.endMs ?? total, total, start + (o.maxMs ?? total)) - start);
          await fsp.writeFile(out, tone(ms, o.sampleRate ?? 48_000));
          return { audioPath: out, sampleRate: o.sampleRate ?? 48_000, channels: 1, durationMs: ms };
        }),
      };
      prep = new ReferencePrep({ workRoot: path.join(tmp, 'work'), media });
    });
    afterEach(async () => {
      await fsp.rm(tmp, { recursive: true, force: true });
    });

    const deps = () => ({
      projectAudio: async (id: string) =>
        id === PROJECT ? { audioPath: path.join(tmp, 'p', 'original.wav'), transcriptPath: path.join(tmp, 'p', 'source.json') } : undefined,
      media,
      prep,
      workRoot: path.join(tmp, 'work'),
    });

    it('analyses the chosen lines joined, remembering where they came from', async () => {
      const a = await analyzeProjectSource(deps(), PROJECT, POLICY, { segmentIds: ['seg_0002', 'seg_0001'] });
      expect(a.origin).toEqual({ projectId: PROJECT, segmentIds: ['seg_0002', 'seg_0001'] });
      // 4 s + 0.15 s pause + 3 s.
      expect(Math.abs(a.durationMs - 7150)).toBeLessThan(5);
      expect(media.referenceClip.mock.calls.slice(0, 2).map((c) => [c[2].startMs, c[2].endMs])).toEqual([
        [2000, 6000],
        [10_000, 13_000],
      ]);
      // The joining scratch is gone; only the analysis remains.
      expect((await fsp.readdir(path.join(tmp, 'work'))).every((n) => n.startsWith('va_'))).toBe(true);
    });

    it("takes the lines' voices without the music when separation is installed, and the lines as they are when not", async () => {
      const isolateVoices = vi.fn(async (_id: string, wav: string, workDir: string) => {
        await fsp.mkdir(workDir, { recursive: true });
        const out = path.join(workDir, 'vocals.wav');
        await fsp.writeFile(out, tone(5000)); // shorter than the 7.15 s of joined lines: proves it was used
        expect(path.basename(wav)).toBe('lines.wav');
        return out;
      });
      const a = await analyzeProjectSource({ ...deps(), isolateVoices }, PROJECT, POLICY, { segmentIds: ['seg_0001', 'seg_0002'] });
      expect(isolateVoices).toHaveBeenCalledWith(PROJECT, expect.any(String), expect.any(String), undefined);
      expect(a.voicesIsolated).toBe(true);
      expect(Math.abs(a.durationMs - 5000)).toBeLessThan(5);

      const notNow = await analyzeProjectSource({ ...deps(), isolateVoices: async () => undefined }, PROJECT, POLICY, {
        segmentIds: ['seg_0001', 'seg_0002'],
      });
      expect(notNow.voicesIsolated).toBeUndefined();
      expect(Math.abs(notNow.durationMs - 7150)).toBeLessThan(5);
    });

    it('uses the separated voices a render already made for the whole track', async () => {
      const vocals = path.join(tmp, 'p', 'vocals.wav');
      await fsp.writeFile(vocals, tone(12_000));
      const a = await analyzeProjectSource({ ...deps(), cachedVocals: async () => vocals }, PROJECT, POLICY);
      expect(a.voicesIsolated).toBe(true);
      expect(Math.abs(a.durationMs - 12_000)).toBeLessThan(5);
      const raw = await analyzeProjectSource({ ...deps(), cachedVocals: async () => undefined }, PROJECT, POLICY);
      expect(Math.abs(raw.durationMs - 30_000)).toBeLessThan(5);
    });

    it('analyses the whole track without lines, and says when audio is not ready', async () => {
      const a = await analyzeProjectSource(deps(), PROJECT, POLICY);
      expect(a.origin).toEqual({ projectId: PROJECT });
      await expect(analyzeProjectSource(deps(), `proj_${'e'.repeat(32)}`, POLICY)).rejects.toMatchObject({
        appError: { code: 'VOICE_REFERENCE_REJECTED' },
      });
      await expect(analyzeProjectSource(deps(), PROJECT, POLICY, { segmentIds: ['nope'] })).rejects.toThrow(/None of the chosen lines/);
    });

    it('never turns a project id that is not one into a path', async () => {
      const projectAudio = vi.fn(deps().projectAudio);
      for (const id of ['..\\..\\x', '../x', `proj_${'d'.repeat(32)}\\..`, 'proj_ABC']) {
        await expect(analyzeProjectSource({ ...deps(), projectAudio }, id, POLICY)).rejects.toMatchObject({
          appError: { code: 'VOICE_REFERENCE_REJECTED' },
        });
      }
      expect(projectAudio).not.toHaveBeenCalled();
    });

    it('keeps such a voice in its project, under the source-video declaration', async () => {
      const store = new VoiceProfileStore(path.join(tmp, 'config'), path.join(tmp, 'projects'));
      const registry = new ProviderRegistry();
      const service = new VoiceProfileService({ store, prep, registry: () => registry, projectExists: async () => true });
      registry.registerTts({
        id: 'vieneu-tts',
        displayName: 'VieNeu',
        isLocal: true,
        enroll: async (_r: string, out: string) => {
          await fsp.writeFile(out, 'npz');
          return { fingerprint: 'c'.repeat(64), engineVersion: '3.8.4' };
        },
        synthesizeSegments: async () => ({ segments: [] }),
      } as never);
      const a = await analyzeProjectSource(deps(), PROJECT, POLICY, { segmentIds: ['seg_0001'] });
      const consent = { accepted: true, statementVersion: CONSENT_VERSION, locale: 'vi' };
      await expect(
        service.create({ analysisId: a.analysisId, window: a.window, name: 'x', consent: { ...consent, relation: 'self' } }),
      ).rejects.toMatchObject({ appError: { code: 'VOICE_CONSENT_REQUIRED' } });
      await expect(
        service.create({
          analysisId: a.analysisId,
          window: a.window,
          name: 'x',
          consent: { ...consent, relation: 'source-video' },
          projectId: `proj_${'f'.repeat(32)}`,
        }),
      ).rejects.toMatchObject({ appError: { code: 'VOICE_REFERENCE_REJECTED' } });
      const p = await service.create({
        analysisId: a.analysisId,
        window: a.window,
        name: 'Người nói 1',
        consent: { ...consent, relation: 'source-video' },
      });
      expect(p.scope).toEqual({ kind: 'project', projectId: PROJECT });
      expect(p.source).toEqual({ kind: 'project-lines', segmentIds: ['seg_0001'] });
      expect(p.consent.relation).toBe('source-video');
    });

    describe('speakers', () => {
      const consent = { accepted: true, statementVersion: CONSENT_VERSION, locale: 'vi', relation: 'source-video' };

      function cloning() {
        const store = new VoiceProfileStore(path.join(tmp, 'config'), path.join(tmp, 'projects'));
        const registry = new ProviderRegistry();
        registry.registerTts({
          id: 'vieneu-tts',
          displayName: 'VieNeu',
          isLocal: true,
          enroll: async (_r: string, out: string) => {
            await fsp.writeFile(out, 'npz');
            return { fingerprint: 'c'.repeat(64), engineVersion: '3.8.4' };
          },
          synthesizeSegments: async () => ({ segments: [] }),
        } as never);
        return new VoiceProfileService({ store, prep, registry: () => registry, projectExists: async () => true });
      }

      beforeEach(async () => {
        // SPEAKER_00 says 8 s in two lines; SPEAKER_01 only 1.5 s.
        await fsp.writeFile(
          path.join(tmp, 'p', 'source.json'),
          JSON.stringify({
            segments: [
              { id: 'seg_0001', startMs: 2000, endMs: 6000, speakerId: 'SPEAKER_00' },
              { id: 'seg_0002', startMs: 10_000, endMs: 11_500, speakerId: 'SPEAKER_01' },
              { id: 'seg_0003', startMs: 14_000, endMs: 18_000, speakerId: 'SPEAKER_00' },
            ],
          }),
        );
      });

      it("makes a speaker's voice from their lines, and the voice remembers whose it is", async () => {
        const a = await analyzeProjectSource(deps(), PROJECT, POLICY, { speakerId: 'SPEAKER_00' });
        expect(a.origin).toEqual({ projectId: PROJECT, segmentIds: ['seg_0001', 'seg_0003'], speakerId: 'SPEAKER_00' });
        const p = await cloning().create({ analysisId: a.analysisId, window: a.window, name: 'Người nói 1', consent });
        expect(p.scope).toEqual({ kind: 'project', projectId: PROJECT, speakerId: 'SPEAKER_00' });
        expect(p.source).toEqual({ kind: 'project-speaker', segmentIds: ['seg_0001', 'seg_0003'] });
        await expect(analyzeProjectSource(deps(), PROJECT, POLICY, { speakerId: 'SPEAKER_09' })).rejects.toThrow(/no lines/);
        await expect(analyzeProjectSource(deps(), PROJECT, POLICY, { speakerId: '../x' })).rejects.toThrow(/Unknown speaker/);
      });

      it('makes a voice for every speaker who says enough, under one declaration, and assigns them', async () => {
        const assign = vi.fn(async () => undefined);
        const service = cloning();
        const result = await makeSpeakerVoices({ source: deps(), service, assign }, PROJECT, POLICY, {
          consent,
          names: { SPEAKER_00: 'Người nói 1' },
        });
        expect(result.made.map((m) => [m.speakerId, m.profile.name, m.profile.scope])).toEqual([
          ['SPEAKER_00', 'Người nói 1', { kind: 'project', projectId: PROJECT, speakerId: 'SPEAKER_00' }],
        ]);
        expect(result.skipped).toEqual([expect.objectContaining({ speakerId: 'SPEAKER_01', reason: 'too-short' })]);
        expect(assign).toHaveBeenCalledWith(PROJECT, [{ speakerId: 'SPEAKER_00', voiceId: result.made[0]!.profile.id }]);

        // No declaration, or the wrong one: nothing is analysed.
        for (const bad of [{}, { ...consent, relation: 'self' }, { ...consent, accepted: false }]) {
          await expect(makeSpeakerVoices({ source: deps(), service, assign }, PROJECT, POLICY, { consent: bad })).rejects.toMatchObject({
            appError: { code: 'VOICE_CONSENT_REQUIRED' },
          });
        }
        // Only the speakers asked for.
        const one = await makeSpeakerVoices({ source: deps(), service, assign }, PROJECT, POLICY, { consent, speakerIds: ['SPEAKER_01'] });
        expect(one.made).toEqual([]);
        expect(one.skipped.map((s) => s.speakerId)).toEqual(['SPEAKER_01']);
      });

      it('says so when the transcript has no speakers yet', async () => {
        await fsp.writeFile(path.join(tmp, 'p', 'source.json'), JSON.stringify({ segments: [{ id: 'seg_0001', startMs: 0, endMs: 5000 }] }));
        await expect(
          makeSpeakerVoices({ source: deps(), service: cloning(), assign: vi.fn() }, PROJECT, POLICY, { consent }),
        ).rejects.toThrow(/no speakers yet/);
      });
    });

    it('over HTTP: the analysis decides the source, whatever the client claims', async () => {
      const store = new VoiceProfileStore(path.join(tmp, 'config'), path.join(tmp, 'projects'));
      const registry = new ProviderRegistry();
      registry.registerTts({
        id: 'vieneu-tts',
        displayName: 'VieNeu',
        isLocal: true,
        enroll: async (_r: string, out: string) => {
          await fsp.writeFile(out, 'npz');
          return { fingerprint: 'c'.repeat(64), engineVersion: '3.8.4' };
        },
        synthesizeSegments: async () => ({ segments: [] }),
      } as never);
      const service = new VoiceProfileService({ store, prep, registry: () => registry, projectExists: async () => true });
      const sendError = (reply: FastifyReply, err: unknown) => {
        const { status, body } = toHttpError(err);
        return reply.status(status).send(body);
      };
      const app = Fastify();
      registerProfileRoutes(app, { store, service, prep, source: deps(), sendError });
      await app.ready();

      const res = await app.inject({
        method: 'POST',
        url: `/projects/${PROJECT}/voices/analyze`,
        payload: { segmentIds: ['seg_0002', 42, 'seg_0001'], engine: 'vieneu' },
      });
      expect(res.statusCode).toBe(200);
      const a = res.json<{ analysisId: string; window: { startMs: number; endMs: number }; origin: unknown }>();
      expect(a.origin).toEqual({ projectId: PROJECT, segmentIds: ['seg_0002', 'seg_0001'] });

      const made = await app.inject({
        method: 'POST',
        url: '/voice-profiles',
        payload: {
          analysisId: a.analysisId,
          window: a.window,
          name: 'Speaker',
          source: { kind: 'file', fileName: 'mine.wav' },
          consent: { accepted: true, statementVersion: CONSENT_VERSION, locale: 'en', relation: 'source-video' },
        },
      });
      expect(made.statusCode).toBe(201);
      expect(made.json()).toMatchObject({
        scope: { kind: 'project', projectId: PROJECT },
        source: { kind: 'project-lines', segmentIds: ['seg_0002', 'seg_0001'] },
      });

      const bare = Fastify();
      registerProfileRoutes(bare, { store, service, prep, sendError });
      await bare.ready();
      expect((await bare.inject({ method: 'POST', url: `/projects/${PROJECT}/voices/analyze`, payload: {} })).statusCode).toBe(404);
    });
  });
});
