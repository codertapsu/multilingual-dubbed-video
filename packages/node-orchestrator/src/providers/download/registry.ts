import { AppErrorException } from '@videodubber/shared';

import { createBilibiliProvider } from './bilibili/bilibiliProvider.js';
import type { ProviderDescriptor, SourceProvider } from './types.js';

/**
 * The source providers this build knows about.
 *
 * Adding Douyin (or anything else) means writing one module implementing
 * {@link SourceProvider} and adding one line here. Everything above — the
 * routes, the job service, the screen — dispatches through this list and needs
 * no change.
 */
export function createProviders(configDir: string): SourceProvider[] {
  return [createBilibiliProvider({ configDir })];
}

/**
 * Pick the provider that recognises a pasted input.
 *
 * First match wins, so registry order is the tie-break. `matches` is required
 * to be cheap and offline precisely so this can run every provider without a
 * network round trip.
 */
export function providerFor(
  providers: readonly SourceProvider[],
  input: string,
): SourceProvider | undefined {
  return providers.find((p) => p.matches(input));
}

/** Look a provider up by id, for the per-provider routes. */
export function providerById(
  providers: readonly SourceProvider[],
  id: string,
): SourceProvider | undefined {
  return providers.find((p) => p.id === id);
}

/**
 * Resolve the provider for an input, or explain what IS supported.
 *
 * A bare "that link is not supported" is useless when the answer depends on
 * which providers this build happens to carry, so name them.
 */
export function requireProviderFor(
  providers: readonly SourceProvider[],
  input: string,
): SourceProvider {
  const provider = providerFor(providers, input);
  if (provider) return provider;
  const names = providers.map((p) => p.id).join(', ') || 'none';
  throw new AppErrorException('INVALID_VIDEO_LINK', 'That link is not from a supported site.', {
    remediation: `Paste a link from one of: ${names}. Copy the full address from the browser address bar.`,
  });
}

/** Provider list for the UI, including credential status where applicable. */
export async function describeProviders(
  providers: readonly SourceProvider[],
): Promise<ProviderDescriptor[]> {
  return Promise.all(
    providers.map(async (p) => ({
      id: p.id,
      supportsSession: p.session !== undefined,
      ...(p.session ? { session: await p.session.describe() } : {}),
    })),
  );
}

/** Apply any persisted credentials at boot, best-effort. */
export async function loadProviderSessions(providers: readonly SourceProvider[]): Promise<void> {
  await Promise.all(
    providers.map(async (p) => {
      // One provider's unreadable credential file must not stop the others
      // from loading theirs, nor block the server from starting.
      try {
        await p.session?.load();
      } catch {
        /* a missing or corrupt credential simply means "anonymous" */
      }
    }),
  );
}
