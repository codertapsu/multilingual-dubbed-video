import { describe, expect, it } from 'vitest';

import { INITIATOR_HEADER, withInitiator } from './initiator';

describe('withInitiator', () => {
  it('says the window asked, keeping every other header and option', () => {
    const signal = new AbortController().signal;
    const init = withInitiator({ method: 'POST', body: '{}', signal, headers: { 'Content-Type': 'application/json', Accept: 'application/json' } });
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(init.signal).toBe(signal);
    expect(init.headers).toEqual({ 'content-type': 'application/json', accept: 'application/json', [INITIATOR_HEADER]: 'ui' });
  });

  it('works with no headers, a Headers object, or pairs, and cannot be spoofed by a caller', () => {
    expect(withInitiator().headers).toEqual({ 'x-vd-initiator': 'ui' });
    expect(withInitiator({ headers: new Headers({ 'X-Request-Id': 'r1' }) }).headers).toEqual({ 'x-request-id': 'r1', 'x-vd-initiator': 'ui' });
    expect(withInitiator({ headers: [['x-vd-initiator', 'mcp']] }).headers).toEqual({ 'x-vd-initiator': 'ui' });
  });
});
