import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppErrorException } from '@videodubber/shared';

import { downloadsDirFor, resolveVideo } from './downloadService.js';
import type { PreparedDownload, ResolvedSourceVideo, SourceProvider } from './types.js';

/** A stand-in provider: the seam lets the lookup be tested without a real site. */
function fakeProvider(overrides: Partial<SourceProvider> = {}): SourceProvider {
  return {
    id: 'fake',
    matches: (input) => input.startsWith('fake:'),
    resolve: (): Promise<ResolvedSourceVideo> =>
      Promise.resolve({
        providerId: 'fake',
        title: 'A fake video',
        durationSec: 10,
        parts: [{ id: 'p1', page: 1, title: 'One', durationSec: 10 }],
        requestedPage: 1,
        qualities: [{ id: 'hd', label: 'HD' }],
      }),
    prepare: (): Promise<PreparedDownload> => Promise.reject(new Error('not used here')),
    ...overrides,
  };
}

describe('resolveVideo', () => {
  it('dispatches to the provider that recognises the input', async () => {
    const info = await resolveVideo('fake:abc', { providers: [fakeProvider()] });
    expect(info.providerId).toBe('fake');
    expect(info.title).toBe('A fake video');
  });

  it('names the supported sources when nothing matches', async () => {
    // "Unsupported link" is useless when what IS supported depends on which
    // providers the build carries, so the message has to list them.
    await expect(resolveVideo('https://example.com/x', { providers: [fakeProvider()] })).rejects.toThrow(
      /not from a supported site/,
    );
    try {
      await resolveVideo('https://example.com/x', { providers: [fakeProvider()] });
      expect.unreachable('an unsupported link must reject');
    } catch (err) {
      expect((err as AppErrorException).appError.remediation).toContain('fake');
    }
  });

  it('picks the first provider that matches, so registry order is the tie-break', async () => {
    const first = fakeProvider({ id: 'first', matches: () => true });
    const second = fakeProvider({ id: 'second', matches: () => true });
    const info = await resolveVideo('anything', { providers: [first, second] });
    expect(info.providerId).toBe('fake'); // resolve() of `first` is used
  });
});

describe('downloadsDirFor', () => {
  it('puts downloads beside the projects folder, so they move with it', () => {
    expect(downloadsDirFor(path.join('D:', 'dubs', 'projects'))).toBe(path.join('D:', 'dubs', 'downloads'));
  });
});
