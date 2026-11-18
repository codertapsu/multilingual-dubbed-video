/**
 * Voice previews, playable before anything is installed.
 *
 * The webview never fetches from the internet (its content security policy
 * allows media only from the orchestrator), so GET /voices/:id/preview comes
 * here: the sample the catalog pins is downloaded once, checked against its
 * sha256 and size, and kept in `<configDir>/cache/voice-previews/<sha256>.<ext>`.
 * A file that fails the check is discarded, never served. The cache is
 * "temporary cache" for the storage screen: freeing it costs a re-download.
 */
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { VoicePreview } from '@videodubber/shared';
import { AppErrorException } from '@videodubber/shared';
import { renameReplacing } from '../fsRename.js';

const PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;
const OFFLINE = {
  remediation:
    'Previews download once from the voice maker and then play offline. Check the internet connection and try again; installing the voice does not depend on its preview.',
  docsRef: 'docs/VOICES.md#previews',
};

export const PREVIEW_CONTENT_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
};

/** The cached file's extension, from the URL (".mp3" when unknown). */
export function previewExtension(url: string): string {
  const ext = path.posix.extname(new URL(url).pathname).toLowerCase();
  return PREVIEW_CONTENT_TYPES[ext] ? ext : '.mp3';
}

export class VoicePreviewCache {
  private readonly dir: string;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    configDir: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.dir = path.join(configDir, 'cache', 'voice-previews');
  }

  /** Path of the verified preview file, downloading it on first use. */
  ensure(preview: VoicePreview): Promise<string> {
    if (!/^[0-9a-f]{64}$/.test(preview.sha256)) {
      return Promise.reject(new AppErrorException('UNKNOWN', 'This voice preview has no pinned checksum.'));
    }
    const dest = path.join(this.dir, `${preview.sha256}${previewExtension(preview.url)}`);
    const pending = this.inflight.get(dest);
    if (pending) return pending;
    const job = this.fetchVerified(preview, dest).finally(() => this.inflight.delete(dest));
    this.inflight.set(dest, job);
    return job;
  }

  private async fetchVerified(preview: VoicePreview, dest: string): Promise<string> {
    const existing = await fsp.stat(dest).catch(() => undefined);
    if (existing?.isFile() && existing.size === preview.bytes) return dest;
    if (preview.bytes > PREVIEW_MAX_BYTES) {
      throw new AppErrorException('UNKNOWN', `Voice preview is unexpectedly large (${preview.bytes} bytes).`);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(preview.url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    } catch (err) {
      throw new AppErrorException('UNKNOWN', `Could not download the voice preview: ${(err as Error).message}`, OFFLINE);
    }
    if (!res.ok) {
      throw new AppErrorException('UNKNOWN', `Could not download the voice preview (HTTP ${res.status}).`, OFFLINE);
    }
    const body = Buffer.from(await res.arrayBuffer());
    const digest = createHash('sha256').update(body).digest('hex');
    if (body.length !== preview.bytes || digest !== preview.sha256) {
      throw new AppErrorException('UNKNOWN', 'The downloaded voice preview did not match its checksum and was discarded.', OFFLINE);
    }
    await fsp.mkdir(this.dir, { recursive: true });
    const tmp = `${dest}.${process.pid}.${Date.now()}.download`;
    await fsp.writeFile(tmp, body);
    await renameReplacing(tmp, dest);
    return dest;
  }
}
