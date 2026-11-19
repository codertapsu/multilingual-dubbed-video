import { describe, expect, it } from 'vitest';
import { redactDiagnostics } from './diagnostics';

// The bundle is pasted into public issue trackers: no key may survive it.
describe('redactDiagnostics', () => {
  it('removes API keys, whatever field or header carries them', () => {
    const out = redactDiagnostics(
      [
        'key sk-ant-api03-abcdefgh12345678',
        'apiKey: "mother-claude-0123456789"',
        '"motherClaudeKey": "mc_7f3a9c2e5b1d8f4a"',
        'x-api-key: Zm9vYmFyYmF6cXV4MTIz==',
        'Authorization: Bearer abcdefghijklmnop',
      ].join('\n'),
    );
    for (const secret of ['abcdefgh12345678', 'mother-claude-0123456789', 'mc_7f3a9c2e5b1d8f4a', 'Zm9vYmFyYmF6cXV4MTIz', 'abcdefghijklmnop']) {
      expect(out).not.toContain(secret);
    }
  });

  it('replaces home folders with ~', () => {
    expect(redactDiagnostics('C:\\Users\\Someone\\VideoDubber\\projects')).toBe('~\\VideoDubber\\projects');
  });
});
