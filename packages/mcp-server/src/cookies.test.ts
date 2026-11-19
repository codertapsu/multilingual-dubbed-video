import { describe, expect, it } from 'vitest';

import { cookiesOfSite, parseCookieExport } from './cookies.js';

describe('parseCookieExport', () => {
  it('reads Netscape cookies.txt, HttpOnly lines included, and skips comments', () => {
    const text = [
      '\u{FEFF}# Netscape HTTP Cookie File',
      '',
      '#HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t1893456000\tSESSDATA\ta%2Cb',
      'www.bilibili.com\tFALSE\t/\tFALSE\t0\tbuvid3\tdev-1',
      '# a comment\twith\ttabs\tbut\tnot\ta\tcookie',
      'short\tline',
    ].join('\r\n');
    expect(parseCookieExport(text)).toEqual([
      { domain: '.bilibili.com', name: 'SESSDATA', value: 'a%2Cb' },
      { domain: 'www.bilibili.com', name: 'buvid3', value: 'dev-1' },
    ]);
  });

  it('reads the JSON form and ignores malformed entries', () => {
    expect(
      parseCookieExport(
        JSON.stringify([
          { name: 'SESSDATA', value: 'x', domain: '.bilibili.com', path: '/', httpOnly: true, secure: true },
          { name: 'broken' },
        ]),
      ),
    ).toEqual([{ name: 'SESSDATA', value: 'x', domain: '.bilibili.com' }]);
  });
});

describe('cookiesOfSite', () => {
  it('keeps the site and its subdomains, not a look-alike', () => {
    const all = [
      { name: 'a', value: '1', domain: '.bilibili.com' },
      { name: 'b', value: '2', domain: 'api.bilibili.com' },
      { name: 'c', value: '3', domain: 'notbilibili.com' },
      { name: 'd', value: '4', domain: 'bilibili.com.evil.io' },
    ];
    expect(cookiesOfSite(all, 'bilibili.com').map((c) => c.name)).toEqual(['a', 'b']);
  });
});
