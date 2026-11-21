import { describe, expect, it } from 'vitest';

import en from '../../../i18n/en.json';
import vi from '../../../i18n/vi.json';
import {
  GENERIC_ERROR_MESSAGE,
  PAGE_SETTLE_MS,
  TRANSLATED_ERROR_CODES,
  describeError,
  docsUrl,
  errorKeyStem,
  errorTitleKey,
  isTextEntry,
  planReveal,
  revealAllowed,
} from './error-view';

/** A leaf of a locale tree by dotted key, as TranslateService resolves it. */
function leaf(tree: unknown, key: string): unknown {
  return key.split('.').reduce<unknown>((node, k) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[k] : undefined), tree);
}

describe('every error code has words', () => {
  it('a title and a fix in English and Vietnamese, for each code', () => {
    expect(TRANSLATED_ERROR_CODES.length).toBeGreaterThan(30);
    for (const code of TRANSLATED_ERROR_CODES) {
      for (const [name, tree] of [['en', en], ['vi', vi]] as const) {
        for (const part of ['title', 'fix']) {
          const text = leaf(tree, `${errorKeyStem(code)}.${part}`);
          expect(typeof text === 'string' && text.trim().length > 0, `${name}: ${code}.${part}`).toBe(true);
        }
      }
    }
  });

  it('the Vietnamese is not the English left untranslated', () => {
    for (const code of TRANSLATED_ERROR_CODES) {
      const key = `${errorKeyStem(code)}.title`;
      expect(leaf(vi, key), code).not.toBe(leaf(en, key));
    }
  });

  it('a code this build does not know reads as UNKNOWN', () => {
    expect(errorKeyStem('WORKER_TIMEOUT')).toBe('error.codes.worker-timeout');
    expect(errorKeyStem('SOMETHING_NEW')).toBe('error.codes.unknown');
    expect(errorTitleKey({ code: 'DISK_FULL' })).toBe('error.codes.disk-full.title');
    expect(errorTitleKey(null)).toBe('error.codes.unknown.title');
  });
});

describe('describeError', () => {
  it('nothing to show for no error', () => {
    expect(describeError(null)).toBeNull();
    expect(describeError(undefined)).toBeNull();
  });

  it('a known code leads with its own words; the server English is technical detail', () => {
    const v = describeError({
      code: 'WORKER_UNAVAILABLE',
      message: 'Could not reach the orchestrator at http://127.0.0.1:5100.',
      cause: 'TypeError: Failed to fetch',
      remediation: 'The built-in backend did not start.',
      docsRef: 'docs/TROUBLESHOOTING.md',
    })!;
    expect(v.titleKey).toBe('error.codes.worker-unavailable.title');
    expect(v.fixKey).toBe('error.codes.worker-unavailable.fix');
    expect(v.message).toBeUndefined();
    expect(v.advice).toBeUndefined();
    expect(v.details).toEqual({
      message: 'Could not reach the orchestrator at http://127.0.0.1:5100.',
      remediation: 'The built-in backend did not start.',
      cause: 'TypeError: Failed to fetch',
      docsRef: 'docs/TROUBLESHOOTING.md',
    });
  });

  it('UNKNOWN shows what the server said, since the code says nothing', () => {
    const v = describeError({
      code: 'UNKNOWN',
      message: 'Choose a folder outside the current projects folder.',
      remediation: 'The projects are in D:\\VideoDubber\\projects now.',
    })!;
    expect(v.titleKey).toBe('error.codes.unknown.title');
    expect(v.message).toBe('Choose a folder outside the current projects folder.');
    expect(v.advice).toBe('The projects are in D:\\VideoDubber\\projects now.');
    expect(v.details).toEqual({});
  });

  it('a code from a newer backend is shown as it came, with the server message', () => {
    const v = describeError({ code: 'BRAND_NEW_CODE', message: 'Something specific.' })!;
    expect(v.code).toBe('BRAND_NEW_CODE');
    expect(v.titleKey).toBe('error.codes.unknown.title');
    expect(v.message).toBe('Something specific.');
  });

  it('a JS Error that reached the banner shows its message, never its stack', () => {
    const err = new TypeError('Failed to fetch');
    const v = describeError(err)!;
    expect(v.code).toBe('UNKNOWN');
    expect(v.message).toBe('Failed to fetch');
    // A stack names the file it was thrown in: this spec.
    expect(err.stack).toContain('error-view.spec');
    expect(JSON.stringify(v)).not.toContain('error-view.spec');
    expect(v.details.cause).toBeUndefined();
  });

  it('the generic fallback message is not repeated in English under the title', () => {
    const v = describeError({ code: 'UNKNOWN', message: GENERIC_ERROR_MESSAGE })!;
    expect(v.message).toBeUndefined();
    expect(v.details.message).toBeUndefined();
  });

  it('strings and shapeless objects still describe something', () => {
    expect(describeError('boom')).toMatchObject({ code: 'UNKNOWN', message: 'boom' });
    expect(describeError({ nothing: 1 })).toMatchObject({ code: 'UNKNOWN', titleKey: 'error.codes.unknown.title' });
  });

  it('the signature follows the content, not the object identity', () => {
    const a = describeError({ code: 'WORKER_TIMEOUT', message: 'Translation timed out.' })!;
    const b = describeError({ code: 'WORKER_TIMEOUT', message: 'Translation timed out.' })!;
    const c = describeError({ code: 'WORKER_TIMEOUT', message: 'Voice timed out.' })!;
    expect(a.signature).toBe(b.signature);
    expect(a.signature).not.toBe(c.signature);
  });
});

describe('docsUrl', () => {
  it('opens the guide online, whatever leading slash the ref has', () => {
    expect(docsUrl('docs/TROUBLESHOOTING.md#worker-timeout')).toBe(
      'https://github.com/codertapsu/multilingual-dubbed-video/blob/main/docs/TROUBLESHOOTING.md#worker-timeout',
    );
    expect(docsUrl('/docs/PROVIDERS.md')).toBe('https://github.com/codertapsu/multilingual-dubbed-video/blob/main/docs/PROVIDERS.md');
  });
});

describe('bringing a banner into view', () => {
  it('a field being typed in keeps focus; a button does not', () => {
    expect(isTextEntry({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(isTextEntry({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTextEntry({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTextEntry({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTextEntry({ tagName: 'INPUT', type: 'text', readOnly: true })).toBe(false);
    expect(isTextEntry({ tagName: 'BUTTON', type: 'submit' })).toBe(false);
    expect(isTextEntry({ tagName: 'BODY' })).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });

  const ctx = { allowed: true, readingBanner: false, typing: false };
  const off = { visible: false, behindModal: false };
  const seen = { visible: true, behindModal: false };

  it('one banner out of sight: scrolled to and focused; in sight: focused only', () => {
    expect(planReveal([off], ctx)).toEqual({ index: 0, scroll: true, focus: true });
    expect(planReveal([seen], ctx)).toEqual({ index: 0, scroll: false, focus: true });
  });

  it('of several at once, the one in sight wins (under the button just pressed); else the first', () => {
    // Settings: the page banner at the top is out of sight, the row's banner is under the click.
    expect(planReveal([off, seen, off], ctx)).toEqual({ index: 1, scroll: false, focus: true });
    expect(planReveal([off, off], ctx)).toEqual({ index: 0, scroll: true, focus: true });
  });

  it('never pulls focus out of a dialog, from typing, or from a banner being read', () => {
    expect(planReveal([{ visible: false, behindModal: true }], ctx)).toBeNull();
    expect(planReveal([{ visible: true, behindModal: true }, off], ctx)).toEqual({ index: 1, scroll: true, focus: true });
    expect(planReveal([off], { ...ctx, typing: true })).toEqual({ index: 0, scroll: true, focus: false });
    expect(planReveal([off], { ...ctx, readingBanner: true })).toBeNull();
    expect(planReveal([], ctx)).toBeNull();
  });

  it('a page the user just opened and has not touched does not jump to its old errors', () => {
    expect(planReveal([off], { ...ctx, allowed: false })).toBeNull();
    // Opened 1 s ago, nothing clicked since: the page's state, not news.
    expect(revealAllowed({ now: 11_000, navigatedAt: 10_000, gestureAt: 9_500 })).toBe(false);
    // A click since arriving: what fails now answers it.
    expect(revealAllowed({ now: 11_000, navigatedAt: 10_000, gestureAt: 10_500 })).toBe(true);
    // Settled: a failure in the background is news too.
    expect(revealAllowed({ now: 10_000 + PAGE_SETTLE_MS + 1, navigatedAt: 10_000, gestureAt: 0 })).toBe(true);
  });
});
