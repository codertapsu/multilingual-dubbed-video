/**
 * Vocal/M&E source separation, backed by the `separation-audio` engine pack.
 *
 * Splits the original audio into a vocal stem and a music+effects (M&E) bed so
 * the dub can replace only the voices and keep the original score (the
 * "replace-vocals" mix mode). The pack runs a small FastAPI server (`vd_separator`)
 * exposing `POST /separate { audioPath, outputDir } -> { vocalsPath, accompanimentPath }`.
 *
 * Implements {@link SeparationService}; returns null when the pack isn't
 * installed so the mixer falls back to ducking the full original track.
 */
import { AppErrorException } from '@videodubber/shared';
import type { SeparationService } from '../../media.js';
import type { EngineManager } from '../../engines/engineManager.js';
import type { EnginePackStore } from '../../engines/enginePackStore.js';
import { pickInstalledPack } from '../../engines/packSelection.js';
import { postWorkerJson } from '../workerHttp.js';

export class AudioSeparatorProvider implements SeparationService {
  constructor(
    private readonly engines: EngineManager,
    private readonly store: EnginePackStore,
    private readonly timeoutMs: number,
  ) {}

  async separate(
    audioPath: string,
    outputDir: string,
    signal?: AbortSignal,
  ): Promise<{ vocalsPath: string; accompanimentPath: string } | null> {
    const packId = await pickInstalledPack(this.store, 'audio-separator');
    if (!packId) return null; // not installed -> caller falls back to ducking

    const baseUrl = (await this.engines.ensureRunning(packId, { exclusive: true })).replace(/\/$/, '');
    const data = await postWorkerJson<{ vocalsPath?: string; accompanimentPath?: string }>(
      `${baseUrl}/separate`,
      { audioPath, outputDir },
      { timeoutMs: this.timeoutMs, workerName: 'Vocal separation engine', signal },
    );
    if (!data.vocalsPath || !data.accompanimentPath) {
      throw new AppErrorException('ENGINE_UNAVAILABLE', 'Separation engine returned an incomplete result.');
    }
    return { vocalsPath: data.vocalsPath, accompanimentPath: data.accompanimentPath };
  }
}
