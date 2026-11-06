import { describe, expect, it } from 'vitest';
import { decideRange } from './httpRange.js';

describe('decideRange', () => {
  it('serves the whole file when no Range is sent', () => {
    expect(decideRange(undefined, 1000)).toEqual({ kind: 'full' });
  });

  it('answers the probe WebKit sends before it will play a video', () => {
    // WKWebView asks for two bytes and only plays when it gets a 206 back.
    expect(decideRange('bytes=0-1', 1000)).toEqual({ kind: 'partial', start: 0, end: 1 });
  });

  it('handles an open-ended range (a seek)', () => {
    expect(decideRange('bytes=500-', 1000)).toEqual({ kind: 'partial', start: 500, end: 999 });
  });

  it('clamps an end past the file to the last byte', () => {
    expect(decideRange('bytes=900-5000', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 });
  });

  it('serves a suffix range (the moov atom at the end of an mp4)', () => {
    expect(decideRange('bytes=-100', 1000)).toEqual({ kind: 'partial', start: 900, end: 999 });
    expect(decideRange('bytes=-5000', 1000)).toEqual({ kind: 'partial', start: 0, end: 999 });
  });

  it('refuses a start at or past the end', () => {
    expect(decideRange('bytes=1000-', 1000)).toEqual({ kind: 'unsatisfiable' });
    expect(decideRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('refuses an inverted range', () => {
    expect(decideRange('bytes=50-10', 1000)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores what it does not understand rather than failing the request', () => {
    expect(decideRange('items=0-1', 1000)).toEqual({ kind: 'full' });
    expect(decideRange('bytes=0-1,5-9', 1000)).toEqual({ kind: 'full' });
    expect(decideRange('bytes=abc', 1000)).toEqual({ kind: 'full' });
    expect(decideRange('bytes=-', 1000)).toEqual({ kind: 'full' });
  });

  it('tolerates whitespace and case', () => {
    expect(decideRange('  Bytes = 10 - 19 ', 1000)).toEqual({ kind: 'partial', start: 10, end: 19 });
  });
});
