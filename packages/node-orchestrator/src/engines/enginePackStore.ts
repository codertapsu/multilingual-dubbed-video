/**
 * Persistence + filesystem layout for installed engine packs.
 *
 * State lives in `<configDir>/engines.json`; pack files live under
 * `<configDir>/engines/<packId>/`. Writes are atomic (temp + rename). Reads
 * tolerate a missing/corrupt file by returning an empty install set.
 */
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { InstalledEnginePack } from '@videodubber/shared';

/** Shape of engines.json: packId -> install record. */
type EnginesFile = Record<string, InstalledEnginePack>;

/** Store for engine-pack install state + path resolution. */
export class EnginePackStore {
  private readonly filePath: string;
  /** Root dir that holds one subdir per installed pack. */
  readonly enginesDir: string;

  constructor(private readonly configDir: string) {
    this.filePath = path.join(configDir, 'engines.json');
    this.enginesDir = path.join(configDir, 'engines');
  }

  /** Absolute install directory for a pack id. */
  packDir(packId: string): string {
    return path.join(this.enginesDir, packId);
  }

  /** Load the raw install map (missing/corrupt -> empty). */
  async load(): Promise<EnginesFile> {
    try {
      const raw = await fsp.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as EnginesFile) : {};
    } catch {
      return {};
    }
  }

  /** All installed packs, verified to still exist on disk. */
  async list(): Promise<InstalledEnginePack[]> {
    const file = await this.load();
    const out: InstalledEnginePack[] = [];
    for (const rec of Object.values(file)) {
      // Drop stale records whose directory was deleted out-of-band.
      const exists = await fsp
        .stat(rec.path)
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (exists) out.push(rec);
    }
    return out;
  }

  /** Whether a pack is installed (and its dir still exists). */
  async isInstalled(packId: string): Promise<boolean> {
    const list = await this.list();
    return list.some((p) => p.id === packId);
  }

  /** Resolve an installed pack record, or undefined. */
  async get(packId: string): Promise<InstalledEnginePack | undefined> {
    return (await this.list()).find((p) => p.id === packId);
  }

  /** Record a freshly-installed pack. `installedAt` is supplied by the caller. */
  async add(record: InstalledEnginePack): Promise<void> {
    const file = await this.load();
    file[record.id] = record;
    await this.writeAtomic(file);
  }

  /** Remove a pack's record and delete its directory. */
  async remove(packId: string): Promise<void> {
    const file = await this.load();
    const rec = file[packId];
    delete file[packId];
    await this.writeAtomic(file);
    if (rec) {
      await fsp.rm(rec.path, { recursive: true, force: true }).catch(() => {
        /* best-effort */
      });
    }
  }

  private async writeAtomic(value: EnginesFile): Promise<void> {
    await fsp.mkdir(this.configDir, { recursive: true });
    const tmp = path.join(this.configDir, `.engines.${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fsp.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await fsp.rename(tmp, this.filePath);
  }
}
