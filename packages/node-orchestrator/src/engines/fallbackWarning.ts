/**
 * What a run's warning says when a preferred engine was passed over for the
 * next installed one (EngineManager.onFallback). Each cause has its own
 * advice: "reinstall it" is right only when the engine itself would not start.
 * Telling the user to reinstall a working GPU engine because another dub held
 * the card (2026-11-21), or because the card was too full for a 27B model by
 * 220 MiB (claude-dubber, 2026-11-27), sent them the wrong way. Pure.
 */
import type { EngineFallback } from './engineManager.js';

export function fallbackWarning(f: EngineFallback): { code: 'gpu-fallback'; message: string; key: string; params: { pack: string } } {
  const message =
    f.reason === 'busy'
      ? `The GPU was busy (${f.busyWith ?? 'another job'}), so "${f.packId}" ran on the next installed runtime, usually the CPU build (slower).`
      : f.reason === 'memory'
        ? `"${f.packId}" did not have enough free graphics memory to start, so the next installed runtime was used. ` +
          'Nothing needs reinstalling: closing other programs that use the graphics card leaves it more room.'
        : `"${f.packId}" could not start, so the next installed runtime was used (usually the CPU build). If it keeps happening, reinstall it in Settings → Engines.`;
  return { code: 'gpu-fallback', message, key: `warning.gpu-fallback-${f.reason}`, params: { pack: f.packId } };
}
