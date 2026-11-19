import path from 'node:path';

import { requireProviderFor } from './registry.js';
import type { ResolvedSourceVideo, SourceProvider } from './types.js';

/**
 * Looking a link up before downloading it (the Download screen's preview card
 * and part picker). The downloads themselves are the queue's (queue.ts):
 * many at once, kept on disk, resumed after a restart.
 *
 * Provider-agnostic: everything here dispatches through the registry, so a new
 * source needs no change to the routes or the screen.
 */
export async function resolveVideo(
  input: string,
  deps: { providers: readonly SourceProvider[] },
): Promise<ResolvedSourceVideo> {
  return requireProviderFor(deps.providers, input).resolve(input);
}

/**
 * Where downloads land: `downloads` beside the projects folder
 * (`<root>\projects` → `<root>\downloads`), so they move with it (Settings →
 * Projects folder), sit on the same drive (a project made from one hard-links
 * it instead of copying), and are counted in Storage.
 */
export function downloadsDirFor(projectsDir: string): string {
  return path.join(path.dirname(projectsDir), 'downloads');
}
