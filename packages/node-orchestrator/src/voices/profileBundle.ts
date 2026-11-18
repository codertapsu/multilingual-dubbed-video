/**
 * Moving a voice between computers: the `.vdvoice` file.
 *
 * A JSON document (no archive format to parse): the profile's description and
 * its files, base64. What may travel is fixed: the voice data of a cloning
 * engine (`<engine>.npz`), the preview, and the recording only when the user
 * chose to include it. Project voices (made from a project's video) never
 * leave their project. Importing makes a NEW library voice and asks the
 * importer for their own declaration: whoever uses a voice is responsible for
 * it. The original declaration travels along as a note, for the record.
 *
 * Voice data is never trusted: an .npz must be a zip (numpy's format) and is
 * read by the engine without unpickling; anything unexpected rejects the file.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import {
  AppErrorException,
  type VoiceConsent,
  type VoiceEngineId,
  type VoiceProfile,
  type VoiceReferenceChecks,
} from '@videodubber/shared';
import { PROFILE_FILES, type VoiceProfileStore } from './profileStore.js';
import { voiceEngineInfo } from './voiceCatalog.js';

export const BUNDLE_FORMAT = 'videodubber-voice';
export const BUNDLE_VERSION = 1;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

export interface VoiceBundle {
  format: typeof BUNDLE_FORMAT;
  version: number;
  exportedAt: string;
  profile: {
    name: string;
    engine: VoiceEngineId;
    note?: string;
    referenceLanguage?: string;
    reference?: { durationMs: number; sampleRate: number; sha256: string };
    checks: VoiceReferenceChecks;
    consent: VoiceConsent;
    enrollments: Partial<Record<VoiceEngineId, { fingerprint: string; engineVersion: string; createdAt: string }>>;
  };
  /** File name -> base64 bytes. */
  files: Record<string, string>;
}

function allowedFile(name: string): boolean {
  if (name === PROFILE_FILES.preview || name === PROFILE_FILES.reference) return true;
  const m = /^([a-z0-9-]+)\.npz$/.exec(name);
  return Boolean(m && voiceEngineInfo(m[1] as VoiceEngineId)?.cloning);
}

export async function exportBundle(store: VoiceProfileStore, id: string, includeRecording: boolean, now = new Date()): Promise<VoiceBundle> {
  const profile = await store.require(id);
  if (profile.scope.kind === 'project') {
    throw new AppErrorException(
      'VOICE_REFERENCE_REJECTED',
      "A voice made from a project's video stays in that project and cannot be exported.",
    );
  }
  const files: Record<string, string> = {};
  const add = async (name: string) => {
    const data = await fsp.readFile(store.fileOf(id, name)).catch(() => undefined);
    if (data) files[name] = data.toString('base64');
  };
  for (const engine of Object.keys(profile.enrollments) as VoiceEngineId[]) {
    await add(profile.enrollments[engine]!.file);
  }
  await add(PROFILE_FILES.preview);
  if (includeRecording && profile.reference) await add(profile.reference.file);
  const enrollments: VoiceBundle['profile']['enrollments'] = {};
  for (const [engine, e] of Object.entries(profile.enrollments) as [VoiceEngineId, NonNullable<VoiceProfile['enrollments'][VoiceEngineId]>][]) {
    if (files[e.file]) enrollments[engine] = { fingerprint: e.fingerprint, engineVersion: e.engineVersion, createdAt: e.createdAt };
  }
  return {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    exportedAt: now.toISOString(),
    profile: {
      name: profile.name,
      engine: profile.engine,
      ...(profile.note ? { note: profile.note } : {}),
      ...(profile.referenceLanguage ? { referenceLanguage: profile.referenceLanguage } : {}),
      ...(includeRecording && profile.reference
        ? { reference: { durationMs: profile.reference.durationMs, sampleRate: profile.reference.sampleRate, sha256: profile.reference.sha256 } }
        : {}),
      checks: profile.checks,
      consent: profile.consent,
      enrollments,
    },
    files,
  };
}

/** Validate a bundle's shape and files; throws VOICE_REFERENCE_REJECTED. */
export function parseBundle(raw: unknown): VoiceBundle {
  const reject = (why: string): never => {
    throw new AppErrorException('VOICE_REFERENCE_REJECTED', `This is not a VideoDubber voice file: ${why}.`);
  };
  const b = raw as Partial<VoiceBundle> | null;
  if (!b || typeof b !== 'object' || b.format !== BUNDLE_FORMAT) reject('unknown format');
  if (b!.version !== BUNDLE_VERSION) reject(`version ${String(b!.version)} is not supported`);
  const p = b!.profile;
  if (!p || typeof p.name !== 'string' || !p.name.trim()) reject('no voice name');
  if (!voiceEngineInfo(p!.engine)?.cloning) reject(`engine "${String(p!.engine)}" cannot speak cloned voices`);
  if (!b!.files || typeof b!.files !== 'object') reject('no files');
  for (const [name, data] of Object.entries(b!.files!)) {
    if (!allowedFile(name)) reject(`unexpected file "${name}"`);
    if (typeof data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) reject(`"${name}" is not base64`);
    const bytes = Buffer.from(data, 'base64');
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) reject(`"${name}" is empty or too large`);
    if (name.endsWith('.npz') && bytes.subarray(0, 2).toString('latin1') !== 'PK') reject(`"${name}" is not voice data`);
    if (name.endsWith('.wav') && bytes.subarray(0, 4).toString('latin1') !== 'RIFF') reject(`"${name}" is not a WAV file`);
  }
  for (const [engine, e] of Object.entries(p!.enrollments ?? {})) {
    if (!b!.files![PROFILE_FILES.enrollment(engine as VoiceEngineId)]) reject(`voice data for ${engine} is missing`);
    if (!/^[0-9a-f]{64}$/.test(String(e?.fingerprint))) reject(`voice data for ${engine} has no fingerprint`);
  }
  if (Object.keys(p!.enrollments ?? {}).length === 0 && !b!.files![PROFILE_FILES.reference]) {
    reject('it holds neither voice data nor a recording');
  }
  if (p!.reference) {
    const rec = b!.files![PROFILE_FILES.reference];
    if (!rec) reject('the recording is missing');
    const sha = crypto.createHash('sha256').update(Buffer.from(rec!, 'base64')).digest('hex');
    if (sha !== p!.reference.sha256) reject('the recording does not match its checksum');
  }
  return b as VoiceBundle;
}

/** Make a new library voice from a parsed bundle, with the importer's own declaration. */
export async function importBundle(
  store: VoiceProfileStore,
  bundle: VoiceBundle,
  consent: VoiceConsent,
  now = new Date(),
): Promise<VoiceProfile> {
  const id = store.newId({ kind: 'library' });
  const dir = store.dirOf(id);
  await fsp.mkdir(dir, { recursive: true });
  try {
    for (const [name, data] of Object.entries(bundle.files)) {
      await fsp.writeFile(store.fileOf(id, name), Buffer.from(data, 'base64'));
    }
    const at = now.toISOString();
    const enrollments: VoiceProfile['enrollments'] = {};
    for (const [engine, e] of Object.entries(bundle.profile.enrollments) as [VoiceEngineId, { fingerprint: string; engineVersion: string; createdAt: string }][]) {
      enrollments[engine] = { file: PROFILE_FILES.enrollment(engine), fingerprint: e.fingerprint, engineVersion: e.engineVersion, createdAt: e.createdAt };
    }
    const original = bundle.profile.consent;
    const noteParts = [
      bundle.profile.note,
      original ? `Imported ${at.slice(0, 10)}; originally declared "${original.relation}" on ${String(original.acceptedAt).slice(0, 10)}.` : undefined,
    ].filter(Boolean);
    const profile: VoiceProfile = {
      id,
      name: bundle.profile.name.trim().slice(0, 80),
      createdAt: at,
      updatedAt: at,
      scope: { kind: 'library' },
      engine: bundle.profile.engine,
      source: { kind: 'file', fileName: 'imported .vdvoice' },
      ...(bundle.profile.referenceLanguage ? { referenceLanguage: bundle.profile.referenceLanguage } : {}),
      ...(bundle.profile.reference
        ? { reference: { file: PROFILE_FILES.reference, ...bundle.profile.reference } }
        : {}),
      checks: bundle.profile.checks ?? { speechMs: 0, warnings: [] },
      consent,
      enrollments,
      ...(noteParts.length ? { note: noteParts.join(' ').slice(0, 500) } : {}),
    };
    return await store.save(profile);
  } catch (err) {
    await fsp.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    throw err;
  }
}
