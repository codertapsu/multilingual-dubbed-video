/**
 * HTTP routes of the voice library (docs/VOICES.md):
 *
 *   GET  /voices                 the library, filtered (VoiceQuery as query params)
 *   GET  /voices/engines         each voice engine with its packs and install state
 *   GET  /voices/:id/preview     a verified, cached sample (needs nothing installed)
 *   POST /voices/:id/speak       { text, language? } -> WAV of an installed voice saying it
 *   PUT  /voices/:id/favorite    { favorite: boolean }
 *   POST /voices/:id/install     { packId? } -> VoiceInstallResult (202)
 *
 * The old /setup/voices and /setup/install-voice stay as they were, for the
 * MCP server and the first-run wizard.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  AppErrorException,
  splitSpeakerVoiceId,
  type VoiceEngineId,
  type VoiceEngineInfo,
  type VoiceInstallResult,
  type VoiceLibraryResponse,
  type VoiceLicenseCategory,
  type VoiceProfile,
} from '@videodubber/shared';
import { allCatalogVoices, findCatalogVoice, VOICE_ENGINES, voiceEngineInfo } from './voiceCatalog.js';
import { libraryItems, queryVoices, type VoiceLibraryState, type VoiceQuery } from './voiceLibrary.js';
import type { VoiceFavorites } from './voicePreferences.js';
import { projectOfProfileId } from './profileStore.js';
import { PREVIEW_CONTENT_TYPES, type VoicePreviewCache } from './previewCache.js';

/** One engine pack as the voice screens show it. */
export interface VoicePackState {
  id: string;
  displayName: string;
  /** Where it runs: 'cuda' (NVIDIA GPU), 'metal' (Apple chip), 'cpu'… */
  accel?: string;
  approxSizeMb: number;
  installed: boolean;
  /** Offered on this platform. */
  available: boolean;
  /** Runs well on this machine's hardware (the recommendation, never a gate). */
  fits: boolean;
  installing: boolean;
}

export interface VoiceEngineState extends VoiceEngineInfo {
  installed: boolean;
  available: boolean;
  packs: VoicePackState[];
}

export interface VoiceRoutesDeps {
  /** This computer's state for the library. */
  libraryState: () => Promise<Omit<VoiceLibraryState, 'favorites' | 'profiles'>>;
  favorites: VoiceFavorites;
  previews: VoicePreviewCache;
  /** The user's cloned voices: the library's, plus one project's own. */
  profiles?: (projectId?: string) => Promise<VoiceProfile[]>;
  /** Engine packs of a voice engine, with their state here. */
  packStates: (packIds: readonly string[]) => Promise<VoicePackState[]>;
  /** Start downloading one Piper model (progress on /setup/events). */
  installPiperVoice: (modelId: string) => void;
  /** Start installing an engine pack; resolves to every pack it started. */
  installPack: (packId: string) => Promise<string[]>;
  /**
   * Speak `text` in an installed voice (its engine's provider); resolves to
   * the WAV. Optional: without it the route answers 404.
   */
  speak?: (voiceId: string, text: string, language: string) => Promise<string>;
  sendError: (reply: FastifyReply, err: unknown) => unknown;
}

const LICENSES: readonly VoiceLicenseCategory[] = [
  'permissive',
  'attribution',
  'use-restricted',
  'non-commercial',
  'service-terms',
  'unknown',
];

type Query = Record<string, string | undefined>;

const bool = (v: string | undefined): boolean | undefined =>
  v === 'true' || v === '1' ? true : v === 'false' || v === '0' ? false : undefined;
const list = (v: string | undefined): string[] =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
const int = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
};

/**
 * The folder name of a "hear it say this" clip: everything that decides its
 * audio. Voice, text and language alone kept serving an engine's old take
 * after the engine changed: Kokoro's Japanese went on reading kanji as their
 * names after the misaki fix (2026-11-18). So the installed versions of the
 * voice's engine packs are in it, and for a cloned voice its recording (or,
 * kept without one, its voice data).
 */
export function speakCacheKey(input: {
  voiceId: string;
  text: string;
  language: string;
  /** Installed packs of the voice's engine ({ id, version }). */
  packs: readonly { id: string; version?: string }[];
  profile?: Pick<VoiceProfile, 'engine' | 'reference' | 'enrollments'>;
}): string {
  const packs = input.packs.map((p) => `${p.id}@${p.version ?? ''}`).sort();
  const p = input.profile;
  const voiceData = p ? (p.reference?.sha256 ?? p.enrollments[p.engine]?.fingerprint ?? '') : '';
  return createHash('sha256')
    .update(JSON.stringify([input.voiceId, input.text, input.language, packs, voiceData]))
    .digest('hex')
    .slice(0, 24);
}

/** Query string -> VoiceQuery, ignoring values it does not know. */
export function parseVoiceQuery(q: Query): VoiceQuery {
  const engines = list(q.engine).filter((e): e is VoiceEngineId => VOICE_ENGINES.some((x) => x.id === e));
  const licenses = list(q.license).filter((l): l is VoiceLicenseCategory => LICENSES.includes(l as VoiceLicenseCategory));
  const gender = q.gender === 'female' || q.gender === 'male' ? q.gender : undefined;
  const accent = q.accent === 'north' || q.accent === 'central' || q.accent === 'south' ? q.accent : undefined;
  const kind = q.kind === 'preset' || q.kind === 'profile' ? q.kind : undefined;
  return {
    ...(q.language?.trim() ? { language: q.language.trim() } : {}),
    ...(engines.length ? { engine: engines } : {}),
    ...(gender ? { gender } : {}),
    ...(accent ? { accent } : {}),
    ...(licenses.length ? { license: licenses } : {}),
    ...(bool(q.installed) !== undefined ? { installed: bool(q.installed) } : {}),
    ...(bool(q.favorite) !== undefined ? { favorite: bool(q.favorite) } : {}),
    ...(kind ? { kind } : {}),
    ...(q.projectId?.trim() ? { projectId: q.projectId.trim() } : {}),
    ...(q.q?.trim() ? { q: q.q.trim().slice(0, 200) } : {}),
    ...(int(q.limit) !== undefined ? { limit: Math.min(int(q.limit)!, 1000) } : {}),
    ...(int(q.offset) !== undefined ? { offset: int(q.offset) } : {}),
  };
}

/**
 * What installing a voice takes: the Piper model to download, or the engine
 * pack its engine needs (the one the user picked, else the first that runs
 * well here, else the first offered; the GPU build is listed first). Nothing
 * when it is already there.
 */
export function planVoiceInstall(
  voiceId: string,
  packs: readonly VoicePackState[],
  requestedPack?: string,
): { piperModel?: string; packId?: string; downloadMb: number } {
  const entry = findCatalogVoice(voiceId);
  if (!entry) {
    throw new AppErrorException('TTS_VOICE_MISSING', `Unknown voice "${voiceId}".`, {
      remediation: 'Pick a voice from the voice library (GET /voices).',
    });
  }
  const engine = voiceEngineInfo(entry.engine);
  if (entry.engine === 'piper') {
    return { piperModel: splitSpeakerVoiceId(voiceId).modelId, downloadMb: entry.sizeMb };
  }
  if (!engine || engine.packIds.length === 0) {
    // Cloud voices need a key, not a download.
    throw new AppErrorException('CLOUD_CREDENTIALS_MISSING', `"${entry.name}" is a cloud voice: add its API key in Settings.`);
  }
  if (packs.some((p) => p.installed)) return { downloadMb: 0 };
  const pick = requestedPack
    ? packs.find((p) => p.id === requestedPack && engine.packIds.includes(p.id))
    : (packs.find((p) => p.available && p.fits) ?? packs.find((p) => p.available));
  if (!pick) {
    throw new AppErrorException(
      'ENGINE_PACK_MISSING',
      requestedPack
        ? `Engine pack "${requestedPack}" does not provide "${entry.name}".`
        : `The engine for "${entry.name}" is not available on this computer.`,
    );
  }
  return { packId: pick.id, downloadMb: pick.approxSizeMb };
}

export function registerVoiceRoutes(app: FastifyInstance, deps: VoiceRoutesDeps): void {
  const state = async (projectId?: string): Promise<VoiceLibraryState> => {
    const [base, favorites, profiles] = await Promise.all([
      deps.libraryState(),
      deps.favorites.list(),
      deps.profiles ? deps.profiles(projectId).catch(() => []) : Promise.resolve([]),
    ]);
    return { ...base, favorites, profiles };
  };

  app.get('/voices', async (req: FastifyRequest<{ Querystring: Query }>, reply) => {
    try {
      const items = libraryItems(allCatalogVoices(), VOICE_ENGINES, await state(req.query?.projectId?.trim() || undefined));
      const { voices, total } = queryVoices(items, parseVoiceQuery(req.query ?? {}));
      const body: VoiceLibraryResponse = { voices, total, engines: [...VOICE_ENGINES] };
      return body;
    } catch (err) {
      return deps.sendError(reply, err);
    }
  });

  app.get('/voices/engines', async (_req, reply) => {
    try {
      const base = await deps.libraryState();
      const engines: VoiceEngineState[] = await Promise.all(
        VOICE_ENGINES.map(async (e) => {
          const packs = await deps.packStates(e.packIds);
          const builtIn = e.packIds.length === 0;
          return {
            ...e,
            installed: e.id === 'openai' ? base.cloudServices.has('openai') : builtIn || packs.some((p) => p.installed),
            available: builtIn || packs.some((p) => p.available || p.installed),
            packs,
          };
        }),
      );
      return { engines };
    } catch (err) {
      return deps.sendError(reply, err);
    }
  });

  app.get('/voices/:id/preview', async (req: FastifyRequest<{ Params: { id: string } }>, reply) => {
    try {
      const entry = findCatalogVoice(req.params.id);
      if (!entry?.preview) {
        return reply.status(404).send({ error: { code: 'TTS_VOICE_MISSING', message: 'This voice has no preview.' } });
      }
      const file = await deps.previews.ensure(entry.preview);
      const data = await fsp.readFile(file);
      return reply
        .header('Content-Type', PREVIEW_CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream')
        .header('Cache-Control', 'private, max-age=86400')
        .send(data);
    } catch (err) {
      return deps.sendError(reply, err);
    }
  });

  // "Listen with your own sentence": any installed voice, spoken by its engine.
  app.post(
    '/voices/:id/speak',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { text?: string; language?: string } }>, reply) => {
      try {
        if (!deps.speak) return reply.status(404).send({ error: { code: 'UNKNOWN', message: 'Not available.' } });
        const id = req.params.id;
        const entry = findCatalogVoice(id);
        const text = (req.body?.text ?? '').trim().slice(0, 300);
        if (!text) throw new AppErrorException('UNKNOWN', 'Type a sentence to hear.');
        const language = (req.body?.language ?? entry?.languages.find((l) => l !== '*') ?? 'vi-VN').trim();
        const file = await deps.speak(id, text, language);
        return reply.header('Content-Type', 'audio/wav').header('Cache-Control', 'no-store').send(await fsp.readFile(file));
      } catch (err) {
        return deps.sendError(reply, err);
      }
    },
  );

  app.put(
    '/voices/:id/favorite',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { favorite?: boolean } }>, reply) => {
      try {
        const id = req.params.id;
        const known = Boolean(findCatalogVoice(id)) || ((await deps.profiles?.(projectOfProfileId(id))) ?? []).some((p) => p.id === id);
        if (!known) {
          return reply.status(404).send({ error: { code: 'TTS_VOICE_MISSING', message: `Unknown voice "${id}".` } });
        }
        const all = await deps.favorites.set(id, req.body?.favorite !== false);
        return { id, favorite: all.has(id) };
      } catch (err) {
        return deps.sendError(reply, err);
      }
    },
  );

  app.post(
    '/voices/:id/install',
    async (req: FastifyRequest<{ Params: { id: string }; Body: { packId?: string } }>, reply) => {
      try {
        const entry = findCatalogVoice(req.params.id);
        const engine = voiceEngineInfo(entry?.engine);
        const packs = await deps.packStates(engine?.packIds ?? []);
        const plan = planVoiceInstall(req.params.id, packs, req.body?.packId);
        const enginePacks: string[] = [];
        if (plan.piperModel) deps.installPiperVoice(plan.piperModel);
        if (plan.packId) enginePacks.push(...(await deps.installPack(plan.packId)));
        const result: VoiceInstallResult = {
          started: Boolean(plan.piperModel || plan.packId),
          enginePacks,
          downloadMb: plan.downloadMb,
        };
        return reply.status(202).send(result);
      } catch (err) {
        return deps.sendError(reply, err);
      }
    },
  );
}
