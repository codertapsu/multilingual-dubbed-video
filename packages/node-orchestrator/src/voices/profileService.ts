/**
 * Voice profiles (cloning): making a voice from a recording, and speaking it.
 *
 * Making one (POST /voice-profiles): the user's declaration is checked and
 * stored first (consent.ts), the chosen window of the analysed recording is cut
 * and levelled (referencePrep.ts), the engine turns it into its voice data
 * (POST /enroll on the engine), and a short preview is spoken in the new voice.
 * Nothing is kept when a step fails. The recording is kept only when the user
 * says so; without it the voice cannot be remade for another engine later.
 *
 * Speaking one: a project names the profile id like any voice. The provider
 * asks {@link VoiceProfileService.resolve} for the engine's voice file, which
 * enrolls the kept recording on first use with an engine. A voice never falls
 * back to another: a missing profile, an engine that cannot clone, or a voice
 * saved without its recording for this engine stops the run with the reason.
 */
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AppErrorException,
  VOICE_ENGINE_PROVIDER,
  voiceEngineOfProvider,
  type VoiceEngineId,
  type VoiceProfile,
} from '@videodubber/shared';
import { renameReplacing } from '../fsRename.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { isVoiceCloner, type VoiceEnrollmentResult, type VoiceRefResolver } from '../providers/types.js';
import { acceptConsent, type ConsentInput } from './consent.js';
import { PROFILE_FILES, projectOfProfileId, type VoiceProfileStore } from './profileStore.js';
import { clampWindow, type ReferencePrep } from './referencePrep.js';
import type { TimeRange } from './referenceAnalysis.js';
import { voiceEngineInfo } from './voiceCatalog.js';

/**
 * What a new voice speaks first, so the user hears it at once. Vietnamese
 * whatever the UI language: the cloning engine (VieNeu) speaks Vietnamese.
 */
export const PREVIEW_TEXT =
  'Xin chào, đây là giọng đọc được tạo từ bản ghi âm của bạn. Bạn có thể dùng giọng này để lồng tiếng cho video.';

export interface CreateProfileInput {
  analysisId?: string;
  window?: TimeRange;
  name?: string;
  note?: string;
  engine?: string;
  consent?: ConsentInput;
  /** Keep the levelled recording (lets the voice be remade for another engine). */
  keepRecording?: boolean;
  /** Let the engine clean the recording first (default on). */
  denoise?: boolean;
  /** Make the voice private to this project (e.g. from its source video). */
  projectId?: string;
  source?: VoiceProfile['source'];
  referenceLanguage?: string;
  locale?: string;
}

export interface VoiceProfileServiceDeps {
  store: VoiceProfileStore;
  prep: ReferencePrep;
  /** Read lazily: the registry is built after this service. */
  registry: () => ProviderRegistry;
  /** Does this project exist (for project voices)? */
  projectExists?: (projectId: string) => Promise<boolean>;
  now?: () => Date;
}

const NAME_MAX = 80;

function cloningEngine(engine: string | undefined): VoiceEngineId {
  const info = voiceEngineInfo((engine ?? 'vieneu') as VoiceEngineId);
  if (!info?.cloning || !info.reference) {
    throw new AppErrorException('VOICE_ENGINE_CANNOT_CLONE', `The voice engine "${engine}" cannot make a voice from a recording.`);
  }
  return info.id;
}

export class VoiceProfileService implements VoiceRefResolver {
  /** One enrollment at a time per profile and engine. */
  private readonly enrolling = new Map<string, Promise<{ file: string; fingerprint: string }>>();

  constructor(private readonly deps: VoiceProfileServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private cloner(engine: VoiceEngineId) {
    const provider = this.deps.registry().getTts(VOICE_ENGINE_PROVIDER[engine]);
    if (provider.id !== VOICE_ENGINE_PROVIDER[engine] || !isVoiceCloner(provider)) {
      throw new AppErrorException('VOICE_ENGINE_CANNOT_CLONE', `The ${engine} engine is not available for cloning here.`);
    }
    return provider;
  }

  async create(input: CreateProfileInput, signal?: AbortSignal): Promise<VoiceProfile> {
    const name = (input.name ?? '').trim().slice(0, NAME_MAX);
    if (!name) throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'Give the voice a name.');
    const engine = cloningEngine(input.engine);
    const policy = voiceEngineInfo(engine)!.reference!;
    const scope: VoiceProfile['scope'] = input.projectId ? { kind: 'project', projectId: input.projectId } : { kind: 'library' };
    if (scope.kind === 'project' && this.deps.projectExists && !(await this.deps.projectExists(scope.projectId))) {
      throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'That project does not exist.');
    }
    // The declaration comes first: nothing is cut, enrolled or kept without it.
    const consent = acceptConsent(input.consent, scope.kind, this.now());
    if (!input.analysisId || !input.window) {
      throw new AppErrorException('VOICE_REFERENCE_REJECTED', 'Choose the part of the recording to use.');
    }
    const analysis = await this.deps.prep.load(input.analysisId);
    const window = clampWindow(input.window, analysis.durationMs, policy);
    const { checks } = await this.deps.prep.check(input.analysisId, window, policy);
    if (checks.warnings.includes('too-short')) {
      throw new AppErrorException(
        'VOICE_REFERENCE_REJECTED',
        `The chosen part has ${(checks.speechMs / 1000).toFixed(1)} s of speech; the voice needs at least ${policy.minSpeechMs / 1000} s.`,
      );
    }
    const provider = this.cloner(engine);

    const id = this.deps.store.newId(scope);
    const dir = this.deps.store.dirOf(id);
    await fsp.mkdir(dir, { recursive: true });
    try {
      const reference = this.deps.store.fileOf(id, PROFILE_FILES.reference);
      await this.deps.prep.cut(input.analysisId, window, reference, signal);
      const enrollment = await provider.enroll(
        reference,
        this.deps.store.fileOf(id, PROFILE_FILES.enrollment(engine)),
        { denoise: input.denoise !== false },
        signal,
      );
      const createdAt = this.now().toISOString();
      const keep = input.keepRecording !== false;
      const referenceHash = keep ? await sha256File(reference) : undefined;
      const profile: VoiceProfile = {
        id,
        name,
        createdAt,
        updatedAt: createdAt,
        scope,
        engine,
        source: input.source ?? { kind: 'recording' },
        ...(input.referenceLanguage ? { referenceLanguage: input.referenceLanguage } : {}),
        ...(keep
          ? {
              reference: {
                file: PROFILE_FILES.reference,
                durationMs: window.endMs - window.startMs,
                sampleRate: 48_000,
                sha256: referenceHash!,
              },
            }
          : {}),
        checks,
        consent,
        enrollments: {
          [engine]: {
            file: PROFILE_FILES.enrollment(engine),
            fingerprint: enrollment.fingerprint,
            engineVersion: enrollment.engineVersion,
            createdAt,
          },
        },
        ...(input.note?.trim() ? { note: input.note.trim().slice(0, 500) } : {}),
      };
      await this.deps.store.save(profile);
      if (!keep) await fsp.rm(reference, { force: true });
      // A preview the user hears at once; a failure here never loses the voice.
      await this.renderPreview(profile, undefined, signal).catch(() => undefined);
      await this.deps.prep.discard(input.analysisId).catch(() => undefined);
      return profile;
    } catch (err) {
      await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  /** Speak `text` (default: the standard preview sentence) in the voice; writes preview.wav. */
  async renderPreview(profile: VoiceProfile, text?: string, signal?: AbortSignal): Promise<string> {
    const provider = this.deps.registry().getTts(VOICE_ENGINE_PROVIDER[profile.engine]);
    const scratch = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-voice-preview-'));
    try {
      const sentence = (text ?? '').trim().slice(0, 300) || PREVIEW_TEXT;
      const result = await provider.synthesizeSegments(
        {
          language: 'vi-VN',
          voiceId: profile.id,
          segments: [{ id: 'seg_0001', text: sentence, startMs: 0, endMs: 10_000 }],
          outputDir: scratch,
        },
        signal,
      );
      const clip = result.segments[0]?.audioPath;
      if (!clip || (result.fallbackSegments ?? 0) > 0) {
        throw new AppErrorException('ENGINE_UNAVAILABLE', 'The voice engine could not speak the preview.');
      }
      const out = this.deps.store.fileOf(profile.id, PROFILE_FILES.preview);
      const tmp = `${out}.${process.pid}.partial.wav`;
      await fsp.copyFile(clip, tmp);
      await renameReplacing(tmp, out);
      return out;
    } finally {
      await fsp.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async rename(id: string, patch: { name?: string; note?: string }): Promise<VoiceProfile> {
    const profile = await this.deps.store.require(id);
    const name = patch.name?.trim().slice(0, NAME_MAX);
    const next: VoiceProfile = {
      ...profile,
      ...(name ? { name } : {}),
      ...(patch.note !== undefined ? { note: patch.note.trim().slice(0, 500) } : {}),
      updatedAt: this.now().toISOString(),
    };
    if (patch.note !== undefined && !next.note) delete next.note;
    return this.deps.store.save(next);
  }

  async delete(id: string): Promise<boolean> {
    return this.deps.store.delete(id);
  }

  async resolve(
    profileId: string,
    providerId: string,
    enroll: (referencePath: string, outPath: string) => Promise<VoiceEnrollmentResult>,
  ): Promise<{ file: string; fingerprint: string }> {
    const engine = voiceEngineOfProvider(providerId);
    if (!engine || !voiceEngineInfo(engine)?.cloning) {
      throw new AppErrorException('VOICE_ENGINE_CANNOT_CLONE', `The voice engine "${providerId}" only speaks its preset voices.`);
    }
    const key = `${profileId}|${engine}`;
    const pending = this.enrolling.get(key);
    if (pending) return pending;
    const job = this.resolveNow(profileId, engine, enroll).finally(() => this.enrolling.delete(key));
    this.enrolling.set(key, job);
    return job;
  }

  private async resolveNow(
    profileId: string,
    engine: VoiceEngineId,
    enroll: (referencePath: string, outPath: string) => Promise<VoiceEnrollmentResult>,
  ): Promise<{ file: string; fingerprint: string }> {
    const profile = await this.deps.store.require(profileId);
    const existing = profile.enrollments[engine];
    if (existing) {
      const file = this.deps.store.fileOf(profileId, existing.file);
      if (await exists(file)) return { file, fingerprint: existing.fingerprint };
    }
    if (!profile.reference) {
      throw new AppErrorException(
        'VOICE_REFERENCE_REJECTED',
        `"${profile.name}" was saved without its recording, so it cannot be made for this voice engine. Record the voice again, or use it with the engine it was made for.`,
      );
    }
    const file = this.deps.store.fileOf(profileId, PROFILE_FILES.enrollment(engine));
    const r = await enroll(this.deps.store.fileOf(profileId, profile.reference.file), file);
    await this.deps.store.save({
      ...profile,
      enrollments: {
        ...profile.enrollments,
        [engine]: { file: PROFILE_FILES.enrollment(engine), fingerprint: r.fingerprint, engineVersion: r.engineVersion, createdAt: this.now().toISOString() },
      },
      updatedAt: this.now().toISOString(),
    });
    return { file, fingerprint: r.fingerprint };
  }

  /** The project a voice is private to, if any (export refuses those). */
  projectOf(id: string): string | undefined {
    return projectOfProfileId(id);
  }
}

async function exists(file: string): Promise<boolean> {
  return fsp.stat(file).then(
    (s) => s.isFile(),
    () => false,
  );
}

async function sha256File(file: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(await fsp.readFile(file)).digest('hex');
}
