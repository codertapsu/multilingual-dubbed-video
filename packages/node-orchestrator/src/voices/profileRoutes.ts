/**
 * HTTP routes of voice profiles (cloning; docs/VOICE_CLONING.md):
 *
 *   GET    /voice-profiles?projectId=           the user's voices (+ one project's)
 *   GET    /voice-profiles/consent?locale=vi    the statement to agree to, and its version
 *   POST   /voice-profiles/uploads              a recording's raw bytes -> { uploadId }
 *   POST   /voice-profiles/analyze              { uploadId | path, engine?, sourceName? }
 *   POST   /voice-profiles/analysis/:id/check   { window } -> checks of a chosen window
 *   GET    /voice-profiles/analysis/:id/audio   the decoded recording (for the picker)
 *   POST   /voice-profiles                      make a voice (consent required)
 *   PATCH  /voice-profiles/:id                  { name?, note? }
 *   DELETE /voice-profiles/:id                  the voice, its recording and consent record
 *   GET    /voice-profiles/:id/audio/:kind      reference | preview
 *   POST   /voice-profiles/:id/preview          { text? } speak a sentence in the voice
 *   GET    /voice-profiles/:id/export           a .vdvoice file (?recording=1 includes it)
 *   POST   /voice-profiles/:id/export           { dir, includeRecording? } -> { path }
 *   POST   /voice-profiles/import               { bundle, consent } -> a new library voice
 *   POST   /projects/:id/voices/analyze         { segmentIds? | speakerId? } the project's own speech (sourceVoices.ts)
 *   POST   /projects/:id/voices/speakers        { consent, speakerIds?, names? } a voice per speaker (speakerVoices.ts)
 *
 * No MCP tool reaches these: a voice is made by a person, in the app.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppErrorException, type VoiceEngineId } from '@videodubber/shared';
import { acceptConsent, consentStatements, type ConsentInput } from './consent.js';
import { exportBundle, importBundle, parseBundle } from './profileBundle.js';
import type { CreateProfileInput, VoiceProfileService } from './profileService.js';
import { PROFILE_FILES, type VoiceProfileStore } from './profileStore.js';
import { MAX_UPLOAD_BYTES, type ReferencePrep } from './referencePrep.js';
import { analyzeProjectSource, type SourceVoiceDeps } from './sourceVoices.js';
import { makeSpeakerVoices, type SpeakerVoicesInput } from './speakerVoices.js';
import type { TimeRange } from './referenceAnalysis.js';
import { voiceEngineInfo } from './voiceCatalog.js';

export interface ProfileRoutesDeps {
  store: VoiceProfileStore;
  service: VoiceProfileService;
  prep: ReferencePrep;
  /** Voices from a project's own video (absent: the route answers 404). */
  source?: SourceVoiceDeps;
  /** Give speakers their new voices (the project's speakerVoices setting). */
  assignSpeakerVoices?: (projectId: string, assignments: { speakerId: string; voiceId: string }[]) => Promise<void>;
  sendError: (reply: FastifyReply, err: unknown) => unknown;
}

const UPLOAD_TYPES: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
  'application/octet-stream': 'wav',
};

function policyFor(engine: string | undefined) {
  const info = voiceEngineInfo((engine ?? 'vieneu') as VoiceEngineId);
  if (!info?.cloning || !info.reference) {
    throw new AppErrorException('VOICE_ENGINE_CANNOT_CLONE', `The voice engine "${engine}" cannot make a voice from a recording.`);
  }
  return info.reference;
}

/** A file name from a voice name: no path or reserved characters. */
export function safeFileName(name: string): string {
  const cleaned = [...name]
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? ' ' : c))
    .join('')
    .split(/\s+/)
    .filter((word) => word && !/^\.+$/.test(word))
    .join(' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 80);
  return cleaned || 'voice';
}

async function sendWav(reply: FastifyReply, file: string): Promise<FastifyReply> {
  const data = await fsp.readFile(file).catch(() => undefined);
  if (!data) return reply.status(404).send({ error: { code: 'TTS_VOICE_MISSING', message: 'No such recording.' } });
  return reply.header('Content-Type', 'audio/wav').header('Cache-Control', 'no-store').send(data);
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileRoutesDeps): void {
  const { store, service, prep, sendError } = deps;

  app.get('/voice-profiles', async (req: FastifyRequest<{ Querystring: { projectId?: string } }>, reply) => {
    try {
      return { profiles: await store.list(req.query?.projectId?.trim() || undefined) };
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get('/voice-profiles/consent', async (req: FastifyRequest<{ Querystring: { locale?: string } }>) =>
    consentStatements(req.query?.locale === 'en' ? 'en' : 'vi'),
  );

  // Raw recording bytes, in their own scope so the binary body parser (and its
  // larger size limit) applies to this route only.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      Object.keys(UPLOAD_TYPES),
      { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
      (_req, body, done) => done(null, body),
    );
    scope.post('/voice-profiles/uploads', async (req, reply) => {
      try {
        const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        const ext = UPLOAD_TYPES[type];
        if (!ext || !Buffer.isBuffer(req.body)) {
          throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'Send the recording as audio (WAV, MP3, M4A, OGG, WebM or FLAC).');
        }
        return { uploadId: await prep.saveUpload(req.body, ext) };
      } catch (err) {
        return sendError(reply, err);
      }
    });
  });

  app.post(
    '/voice-profiles/analyze',
    async (req: FastifyRequest<{ Body: { uploadId?: string; path?: string; engine?: string; sourceName?: string } }>, reply) => {
      try {
        const body = req.body ?? {};
        const policy = policyFor(body.engine);
        let input: string;
        if (body.uploadId) input = await prep.uploadPath(body.uploadId);
        else if (body.path && path.isAbsolute(body.path)) input = body.path;
        else throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'Choose a recording or a file.');
        const sourceName = body.sourceName ?? (body.path ? path.basename(body.path) : undefined);
        return await prep.analyze(input, policy, sourceName ? { sourceName } : {});
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // A project's own speech: the whole track, the lines chosen in the editor,
  // or one speaker's best lines.
  app.post(
    '/projects/:id/voices/analyze',
    async (
      req: FastifyRequest<{ Params: { id: string }; Body: { segmentIds?: string[]; speakerId?: string; engine?: string } }>,
      reply,
    ) => {
      try {
        if (!deps.source) return reply.status(404).send({ error: { code: 'UNKNOWN', message: 'Not available.' } });
        const ids = Array.isArray(req.body?.segmentIds) ? req.body!.segmentIds.filter((x) => typeof x === 'string').slice(0, 500) : undefined;
        const speakerId = typeof req.body?.speakerId === 'string' ? req.body.speakerId : undefined;
        return await analyzeProjectSource(deps.source, req.params.id, policyFor(req.body?.engine), {
          ...(ids ? { segmentIds: ids } : {}),
          ...(speakerId ? { speakerId } : {}),
        });
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // A voice for every speaker of the video, under one declaration (speakerVoices.ts).
  app.post(
    '/projects/:id/voices/speakers',
    async (req: FastifyRequest<{ Params: { id: string }; Body: SpeakerVoicesInput }>, reply) => {
      try {
        if (!deps.source || !deps.assignSpeakerVoices) {
          return reply.status(404).send({ error: { code: 'UNKNOWN', message: 'Not available.' } });
        }
        const body = req.body ?? ({} as SpeakerVoicesInput);
        const names =
          body.names && typeof body.names === 'object'
            ? Object.fromEntries(Object.entries(body.names).filter(([k, v]) => typeof v === 'string' && k.length < 20))
            : undefined;
        return await makeSpeakerVoices(
          { source: deps.source, service, assign: deps.assignSpeakerVoices },
          req.params.id,
          policyFor(body.engine),
          {
            consent: body.consent ?? {},
            ...(body.engine ? { engine: String(body.engine) } : {}),
            ...(Array.isArray(body.speakerIds) ? { speakerIds: body.speakerIds.filter((x) => typeof x === 'string').slice(0, 100) } : {}),
            ...(names ? { names } : {}),
          },
        );
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/voice-profiles/analysis/:id/check',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { window?: TimeRange; engine?: string } }>, reply) => {
      try {
        const window = req.body?.window;
        if (!window || !Number.isFinite(window.startMs) || !Number.isFinite(window.endMs)) {
          throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'Choose the part of the recording to use.');
        }
        return await prep.check(req.params.id, window, policyFor(req.body?.engine));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.get('/voice-profiles/analysis/:id/audio', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      return await sendWav(reply, prep.sourcePath(req.params.id));
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.post('/voice-profiles', async (req: FastifyRequest<{ Body: CreateProfileInput }>, reply) => {
    try {
      // The client cannot claim a source: recordings and files are all it can make here.
      const body = req.body ?? {};
      const source = body.source?.kind === 'file' ? { kind: 'file' as const, ...(body.source.fileName ? { fileName: String(body.source.fileName).slice(0, 200) } : {}) } : { kind: 'recording' as const };
      const profile = await service.create({ ...body, source });
      return reply.status(201).send(profile);
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.patch(
    '/voice-profiles/:id',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { name?: string; note?: string; gender?: 'female' | 'male' } }>, reply) => {
      try {
        return await service.rename(req.params.id, req.body ?? {});
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.delete('/voice-profiles/:id', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const removed = await service.delete(req.params.id);
      return removed ? { ok: true } : reply.status(404).send({ error: { code: 'TTS_VOICE_MISSING', message: 'No such voice.' } });
    } catch (err) {
      return sendError(reply, err);
    }
  });

  app.get(
    '/voice-profiles/:id/audio/:kind',
    async (req: FastifyRequest<{ Params: { id: string; kind: string } }>, reply) => {
      try {
        const name = req.params.kind === 'reference' ? PROFILE_FILES.reference : req.params.kind === 'preview' ? PROFILE_FILES.preview : undefined;
        if (!name) return reply.status(404).send({ error: { code: 'UNKNOWN', message: 'reference or preview' } });
        return await sendWav(reply, store.fileOf(req.params.id, name));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  // A .vdvoice file. GET downloads it (browser); POST writes it into a folder
  // the user picked (desktop app, where a webview download has nowhere to go).
  app.get(
    '/voice-profiles/:id/export',
    async (req: FastifyRequest<{ Params: { id: string }; Querystring: { recording?: string } }>, reply) => {
      try {
        const bundle = await exportBundle(store, req.params.id, req.query?.recording === '1');
        const name = `${safeFileName(bundle.profile.name)}.vdvoice`;
        return reply
          .header('Content-Type', 'application/json')
          .header('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`)
          .send(JSON.stringify(bundle));
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  app.post(
    '/voice-profiles/:id/export',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { dir?: string; includeRecording?: boolean } }>, reply) => {
      try {
        const dir = req.body?.dir;
        if (!dir || !path.isAbsolute(dir)) throw new AppErrorException('OUTPUT_NOT_WRITABLE', 'Choose a folder to save the voice file in.');
        const bundle = await exportBundle(store, req.params.id, req.body?.includeRecording === true);
        const base = safeFileName(bundle.profile.name);
        let file = path.join(dir, `${base}.vdvoice`);
        for (let n = 2; await fsp.stat(file).then(() => true, () => false); n++) file = path.join(dir, `${base} (${n}).vdvoice`);
        await fsp.writeFile(file, JSON.stringify(bundle));
        return { path: file };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );

  void app.register(async (scope) => {
    // Voice files are a few MB of base64; the default JSON limit is 1 MB.
    scope.post(
      '/voice-profiles/import',
      { bodyLimit: 64 * 1024 * 1024 },
      async (req: FastifyRequest<{ Body: { bundle?: unknown; consent?: ConsentInput } }>, reply) => {
        try {
          const bundle = parseBundle(req.body?.bundle);
          // Whoever imports a voice declares their own right to use it.
          const consent = acceptConsent(req.body?.consent, 'library');
          return reply.status(201).send(await importBundle(store, bundle, consent));
        } catch (err) {
          return sendError(reply, err);
        }
      },
    );
  });

  app.post(
    '/voice-profiles/:id/preview',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { text?: string } }>, reply) => {
      try {
        const profile = await store.require(req.params.id);
        await service.renderPreview(profile, req.body?.text);
        return { ok: true };
      } catch (err) {
        return sendError(reply, err);
      }
    },
  );
}
