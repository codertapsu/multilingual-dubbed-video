import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { VoiceProfile } from '@videodubber/shared';
import { acceptConsent, CONSENT_VERSION } from './consent.js';
import { exportBundle, importBundle, parseBundle } from './profileBundle.js';
import { VoiceProfileStore } from './profileStore.js';
import { safeFileName } from './profileRoutes.js';

const PROJECT = `proj_${'c'.repeat(32)}`;
const NPZ = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(64, 1)]);
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(64, 2)]);

describe('voice files (.vdvoice)', () => {
  let tmp: string;
  let store: VoiceProfileStore;

  beforeEach(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'vd-bundle-'));
    store = new VoiceProfileStore(path.join(tmp, 'config'), path.join(tmp, 'projects'));
  });
  afterEach(async () => {
    await fsp.rm(tmp, { recursive: true, force: true });
  });

  async function saved(scope: VoiceProfile['scope'] = { kind: 'library' }): Promise<VoiceProfile> {
    const id = store.newId(scope);
    await fsp.mkdir(store.dirOf(id), { recursive: true });
    await fsp.writeFile(store.fileOf(id, 'vieneu.npz'), NPZ);
    await fsp.writeFile(store.fileOf(id, 'reference.wav'), WAV);
    await fsp.writeFile(store.fileOf(id, 'preview.wav'), WAV);
    const { createHash } = await import('node:crypto');
    return store.save({
      id,
      name: 'Giọng: "kể/chuyện"',
      createdAt: '2026-11-18T10:00:00.000Z',
      updatedAt: '2026-11-18T10:00:00.000Z',
      scope,
      engine: 'vieneu',
      source: { kind: 'recording' },
      reference: { file: 'reference.wav', durationMs: 7000, sampleRate: 48000, sha256: createHash('sha256').update(WAV).digest('hex') },
      checks: { speechMs: 6500, warnings: [] },
      consent: acceptConsent({ accepted: true, relation: 'self', statementVersion: CONSENT_VERSION }, scope.kind),
      enrollments: { vieneu: { file: 'vieneu.npz', fingerprint: 'a'.repeat(64), engineVersion: '3.8.4', createdAt: '2026-11-18T10:00:00.000Z' } },
    });
  }

  it('round-trips a voice, and leaves the recording out unless asked', async () => {
    const p = await saved();
    const lean = await exportBundle(store, p.id, false);
    expect(Object.keys(lean.files).sort()).toEqual(['preview.wav', 'vieneu.npz']);
    expect(lean.profile.reference).toBeUndefined();

    const full = parseBundle(JSON.parse(JSON.stringify(await exportBundle(store, p.id, true))));
    expect(Object.keys(full.files).sort()).toEqual(['preview.wav', 'reference.wav', 'vieneu.npz']);

    const consent = acceptConsent({ accepted: true, relation: 'authorized', statementVersion: CONSENT_VERSION }, 'library');
    const imported = await importBundle(store, full, consent);
    expect(imported.id).not.toBe(p.id);
    expect(imported).toMatchObject({
      name: p.name,
      engine: 'vieneu',
      scope: { kind: 'library' },
      consent: { relation: 'authorized' },
      enrollments: { vieneu: { file: 'vieneu.npz', fingerprint: 'a'.repeat(64) } },
      reference: { file: 'reference.wav' },
    });
    expect(imported.note).toMatch(/originally declared "self"/);
    expect(await fsp.readFile(store.fileOf(imported.id, 'vieneu.npz'))).toEqual(NPZ);
  });

  it("never exports a voice made from a project's video", async () => {
    const p = await saved({ kind: 'project', projectId: PROJECT });
    await expect(exportBundle(store, p.id, true)).rejects.toMatchObject({ appError: { code: 'VOICE_REFERENCE_REJECTED' } });
  });

  it('rejects anything unexpected in a voice file', async () => {
    const good = JSON.parse(JSON.stringify(await exportBundle(store, (await saved()).id, true)));
    const bad = (mutate: (b: typeof good) => void) => {
      const b = JSON.parse(JSON.stringify(good));
      mutate(b);
      return () => parseBundle(b);
    };
    expect(bad((b) => (b.format = 'zip'))).toThrow(/unknown format/);
    expect(bad((b) => (b.files['evil.py'] = Buffer.from('print(1)').toString('base64')))).toThrow(/unexpected file/);
    expect(bad((b) => (b.files['../x.npz'] = b.files['vieneu.npz']))).toThrow(/unexpected file/);
    expect(bad((b) => (b.files['vieneu.npz'] = Buffer.from('cpickle').toString('base64')))).toThrow(/not voice data/);
    expect(bad((b) => (b.files['reference.wav'] = Buffer.from('RIFFxxxx-other').toString('base64')))).toThrow(/checksum/);
    expect(bad((b) => (b.profile.engine = 'piper'))).toThrow(/cannot speak cloned voices/);
    expect(bad((b) => delete b.files['vieneu.npz'])).toThrow(/missing/);
    expect(() => parseBundle(good)).not.toThrow();
  });

  it('names files safely', () => {
    expect(safeFileName('Giọng: "kể/chuyện"')).toBe('Giọng kể chuyện');
    expect(safeFileName('..\\..\\x')).toBe('x');
    expect(safeFileName('   ')).toBe('voice');
  });
});
