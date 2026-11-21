import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
// The routes, as text (raw-source.d.ts): importing them would pull in every screen.
import routesTs from '../../app.routes.ts?raw';
import { APP_NAME, windowTitle } from './window-title';

type Tree = { [key: string]: string | Tree };

function lookup(tree: Tree, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Tree)[part] : undefined), tree);
}

const translator = (tree: Tree) => (key: string) => {
  const value = lookup(tree, key);
  return typeof value === 'string' ? value : key;
};

describe('windowTitle', () => {
  it('names the screen in the chosen language', () => {
    expect(windowTitle('nav.title.download', translator(vi as Tree))).toBe('VideoDubber — Tải video');
    expect(windowTitle('nav.title.download', translator(en as Tree))).toBe('VideoDubber — Download videos');
  });

  it('is the app name on a screen without a title, or with a key the locales lack', () => {
    expect(windowTitle(undefined, translator(en as Tree))).toBe(APP_NAME);
    expect(windowTitle('nav.title.nowhere', translator(en as Tree))).toBe(APP_NAME);
  });
});

describe('route titles', () => {
  const keys = [...routesTs.matchAll(/title:\s*'([^']+)'/g)].map((m) => m[1]!);

  it('are i18n keys, never English text', () => {
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) expect(key).toMatch(/^nav\.title\.[a-z-]+$/);
  });

  // A route title is not read through `| translate`, so the i18n checker cannot see these.
  it('are in both locales', () => {
    for (const key of keys) {
      expect(typeof lookup(en as Tree, key), `en ${key}`).toBe('string');
      expect(typeof lookup(vi as Tree, key), `vi ${key}`).toBe('string');
    }
  });
});
