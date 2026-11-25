import { describe, expect, it } from 'vitest';

import { localModelUnreachable, overloadNote } from './localLlmTranslationProvider.js';

const fail = (code: string, message = code): Error => Object.assign(new Error(message), { code });

describe('a local model that could not be reached', () => {
  it('is "not running" only when the connection is refused, and never advises another engine', () => {
    const e = localModelUnreachable('http://127.0.0.1:65190/completion', fail('ECONNREFUSED'), 0.4);
    expect(e.code).toBe('ENGINE_UNAVAILABLE');
    expect(e.message).toContain('is not running');
    expect(e.appError.remediation).not.toMatch(/Argos/);
  });

  it('stopped answering, on an overloaded computer, says so: the model was there (Xuyên Không part 16)', () => {
    const e = localModelUnreachable('http://127.0.0.1:65190/completion', fail('ECONNRESET', 'socket hang up'), 0.08);
    expect(e.message).toContain('stopped answering');
    expect(e.message).toContain('short of memory (8 % free)');
    expect(e.appError.remediation).toMatch(/Let the other work finish/);
    expect(e.appError.remediation).not.toMatch(/Argos/);
  });

  it('with memory to spare, it is a restart, not an overload', () => {
    const e = localModelUnreachable('http://127.0.0.1:65190/completion', fail('ECONNRESET'), 0.5);
    expect(e.message).not.toContain('short of memory');
    expect(e.appError.remediation).toMatch(/restarts the model/);
    expect(overloadNote(0.15)).toBe('');
    expect(overloadNote(0.14)).toContain('14 % free');
  });
});
