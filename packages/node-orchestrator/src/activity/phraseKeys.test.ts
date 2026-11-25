import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every phrase key the server writes into the activity list or the edit
 * history (`activity.text.*`, `history.summary.*`) exists in both of the app's
 * bundles. A missing one is not an error anywhere else: the app quietly shows
 * the English sentence instead, which is how a Vietnamese user would find it.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const i18n = path.resolve(src, '../../../apps/desktop/src/i18n');

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'test' ? [] : sources(full);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [full] : [];
  });
}

function lookup(tree: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined), tree);
}

describe('phrase keys the server writes', () => {
  const used = new Set<string>();
  for (const file of sources(src)) {
    for (const m of fs.readFileSync(file, 'utf8').matchAll(/['`]((?:activity\.text|history\.summary)\.[a-z0-9-]+)['`]/g)) used.add(m[1]!);
  }
  // Built from a name at run time (retranscribe.ts windowPhrase).
  for (const part of ['part-loops-removed', 'part-loops-kept', 'part-loops-left', 'part-unassigned']) used.add(`history.summary.${part}`);

  it('finds the keys at all', () => {
    expect(used.size).toBeGreaterThan(60);
  });

  for (const locale of ['en', 'vi']) {
    it(`are all in ${locale}.json`, () => {
      const tree = JSON.parse(fs.readFileSync(path.join(i18n, `${locale}.json`), 'utf8')) as unknown;
      const missing = [...used].filter((k) => typeof lookup(tree, k) !== 'string');
      expect(missing).toEqual([]);
    });
  }
});
