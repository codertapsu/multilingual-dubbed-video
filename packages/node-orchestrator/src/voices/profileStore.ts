/**
 * Voice profiles on disk: the voices a user made (cloning).
 *
 *   library voices   <configDir>/voices/profiles/<id>/
 *   project voices   <projectsDir>/<projectId>/voices/<id>/
 *
 * Each folder holds profile.json (the VoiceProfile, with its consent record),
 * the reference recording when the user kept it (reference.wav), one
 * enrollment per engine (<engine>.npz) and a preview (preview.wav). A project
 * voice lives inside its project, so deleting the project deletes it; its id
 * names the project ("vp_<projectId>.<random>") so it can be found without an
 * index. Deleting a voice deletes its folder, consent record included.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { AppErrorException, type VoiceEngineId, type VoiceProfile } from '@videodubber/shared';
import { writeJsonAtomic } from '../workspace/projectStore.js';

const LIBRARY_ID = /^vp_[0-9a-f]{16}$/;
const PROJECT_ID = /^vp_(proj_[0-9a-f]{32})\.([0-9a-f]{8})$/;

export const PROFILE_FILES = {
  json: 'profile.json',
  reference: 'reference.wav',
  preview: 'preview.wav',
  enrollment: (engine: VoiceEngineId) => `${engine}.npz`,
} as const;

/** The project a profile id belongs to, or undefined for a library voice. */
export function projectOfProfileId(id: string): string | undefined {
  return PROJECT_ID.exec(id)?.[1];
}

export function isValidProfileId(id: string): boolean {
  return LIBRARY_ID.test(id) || PROJECT_ID.test(id);
}

export class VoiceProfileStore {
  constructor(
    private readonly configDir: string,
    private readonly projectsDir: string,
  ) {}

  libraryRoot(): string {
    return path.join(this.configDir, 'voices', 'profiles');
  }

  projectRoot(projectId: string): string {
    return path.join(this.projectsDir, projectId, 'voices');
  }

  newId(scope: VoiceProfile['scope']): string {
    return scope.kind === 'project'
      ? `vp_${scope.projectId}.${crypto.randomBytes(4).toString('hex')}`
      : `vp_${crypto.randomBytes(8).toString('hex')}`;
  }

  /** The folder of a profile id; throws for an id that is not one. */
  dirOf(id: string): string {
    if (!isValidProfileId(id)) {
      throw new AppErrorException('TTS_VOICE_MISSING', `"${id}" is not a voice profile.`);
    }
    const project = projectOfProfileId(id);
    return project ? path.join(this.projectRoot(project), id) : path.join(this.libraryRoot(), id);
  }

  fileOf(id: string, name: string): string {
    return path.join(this.dirOf(id), name);
  }

  async get(id: string): Promise<VoiceProfile | undefined> {
    if (!isValidProfileId(id)) return undefined;
    try {
      const profile = JSON.parse(await fsp.readFile(this.fileOf(id, PROFILE_FILES.json), 'utf8')) as VoiceProfile;
      return profile.id === id ? profile : undefined;
    } catch {
      return undefined;
    }
  }

  async require(id: string): Promise<VoiceProfile> {
    const profile = await this.get(id);
    if (!profile) throw new AppErrorException('TTS_VOICE_MISSING', `The voice profile "${id}" does not exist (it may have been deleted).`);
    return profile;
  }

  /** Library voices, plus one project's own when `projectId` is given. */
  async list(projectId?: string): Promise<VoiceProfile[]> {
    const roots = [this.libraryRoot(), ...(projectId ? [this.projectRoot(projectId)] : [])];
    const out: VoiceProfile[] = [];
    for (const root of roots) {
      const names = await fsp.readdir(root).catch(() => [] as string[]);
      for (const name of names) {
        const profile = await this.get(name);
        if (profile) out.push(profile);
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async save(profile: VoiceProfile): Promise<VoiceProfile> {
    await fsp.mkdir(this.dirOf(profile.id), { recursive: true });
    await writeJsonAtomic(this.fileOf(profile.id, PROFILE_FILES.json), profile);
    return profile;
  }

  /** Delete a voice: its recording, voice data, preview and consent record. */
  async delete(id: string): Promise<boolean> {
    const dir = this.dirOf(id);
    const existed = await fsp.stat(dir).then(() => true, () => false);
    await fsp.rm(dir, { recursive: true, force: true });
    return existed;
  }
}
