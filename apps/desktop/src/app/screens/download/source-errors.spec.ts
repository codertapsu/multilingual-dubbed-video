import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import { SOURCE_ERROR_KEYS, sourceErrorKeys } from './source-errors';

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Tree)[part] : undefined), tree);
}

describe('sourceErrorKeys', () => {
  it('explains the four failures a site causes, each with what to do', () => {
    for (const code of ['SOURCE_RATE_LIMITED', 'SOURCE_LOGIN_REQUIRED', 'SOURCE_UNAVAILABLE', 'INVALID_VIDEO_LINK'] as const) {
      const keys = sourceErrorKeys({ code });
      expect(keys, code).not.toBeNull();
      expect(keys!.fix).not.toBe(keys!.message);
    }
  });

  it('leaves any other failure to the server message', () => {
    expect(sourceErrorKeys({ code: 'DISK_FULL' })).toBeNull();
    expect(sourceErrorKeys({ code: 'UNKNOWN' })).toBeNull();
    expect(sourceErrorKeys(null)).toBeNull();
    expect(sourceErrorKeys(undefined)).toBeNull();
  });

  // The keys come from a table, which the i18n checker cannot follow.
  it('hands out only keys both locales have', () => {
    expect(SOURCE_ERROR_KEYS.length).toBe(8);
    for (const key of SOURCE_ERROR_KEYS) {
      expect(typeof lookup(en as Tree, key), `en ${key}`).toBe('string');
      expect(typeof lookup(vi as Tree, key), `vi ${key}`).toBe('string');
    }
  });
});
