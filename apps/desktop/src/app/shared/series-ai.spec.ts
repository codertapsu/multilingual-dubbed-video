import { afterEach, describe, expect, it } from 'vitest';

import { SERIES_AI_KEY, defaultSeriesAi, rememberSeriesAi } from './series-ai';

const options = [
  { id: 'anthropic-translate', label: 'Claude', ready: true, viaMotherClaude: true },
  { id: 'openai-translate', label: 'OpenAI', ready: true },
  { id: 'gemini-translate', label: 'Gemini', ready: false },
];

function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

describe('series AI default', () => {
  afterEach(() => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it('starts from Claude through Mother Claude, then keeps the last choice while it is set up', () => {
    (globalThis as { localStorage?: Storage }).localStorage = fakeStorage();
    expect(defaultSeriesAi(options)).toBe('anthropic-translate');
    rememberSeriesAi('openai-translate');
    expect(defaultSeriesAi(options)).toBe('openai-translate');
    // A remembered AI that is no longer set up is passed over.
    rememberSeriesAi('gemini-translate');
    expect(globalThis.localStorage.getItem(SERIES_AI_KEY)).toBe('gemini-translate');
    expect(defaultSeriesAi(options)).toBe('anthropic-translate');
  });

  it('works without storage, and offers nothing when no AI is set up', () => {
    expect(defaultSeriesAi(options)).toBe('anthropic-translate');
    expect(() => rememberSeriesAi('openai-translate')).not.toThrow();
    expect(defaultSeriesAi(options.map((o) => ({ ...o, ready: false })))).toBe('');
  });
});
