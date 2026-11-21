import { describe, expect, it } from 'vitest';

import { argosPackRows, argosPairKey } from './argos-rows';

// Names as Intl.DisplayNames(['vi']) gives them; injected so the test does not
// depend on the ICU data of the Node running it.
const VI: Record<string, string> = {
  en: 'Tiếng Anh',
  vi: 'Tiếng Việt',
  zh: 'Tiếng Trung',
  ja: 'Tiếng Nhật',
  de: 'Tiếng Đức',
};
const nameOf = (code: string): string => VI[code] ?? code;
const options = (filter = '') => ({ filter, nameOf, locale: 'vi' });

const installed = [{ from: 'en', to: 'vi' }];
const available = [
  { from: 'zh', to: 'en' },
  { from: 'en', to: 'vi' },
  { from: 'ja', to: 'en' },
  { from: 'de', to: 'en' },
];

describe('argosPackRows', () => {
  it('lists every pair once, installed ones first, named in the app language', () => {
    const rows = argosPackRows(installed, available, options());
    expect(rows.map((r) => r.key)).toEqual(['en->vi', 'de->en', 'ja->en', 'zh->en']);
    expect(rows[0]).toMatchObject({ installed: true, fromName: 'Tiếng Anh', toName: 'Tiếng Việt' });
    expect(rows.filter((r) => r.installed)).toHaveLength(1);
  });

  it('sorts in the alphabet of the app language', () => {
    // Đ comes after D, before E; a code-point sort puts it after Ý (and Z).
    const names: Record<string, string> = { de: 'Đức', it: 'Ý', en: 'Anh' };
    const rows = argosPackRows([], [{ from: 'it', to: 'vi' }, { from: 'de', to: 'vi' }, { from: 'en', to: 'vi' }], {
      filter: '',
      nameOf: (c) => names[c] ?? c,
      locale: 'vi',
    });
    expect(rows.map((r) => r.fromName)).toEqual(['Anh', 'Đức', 'Ý']);
  });

  it('filters without the diacritics, as Vietnamese is often typed', () => {
    expect(argosPackRows(installed, available, options('tieng nhat')).map((r) => r.key)).toEqual(['ja->en']);
    expect(argosPackRows(installed, available, options('duc')).map((r) => r.key)).toEqual(['de->en']);
  });

  it('matches every word anywhere in the row, codes included', () => {
    expect(argosPackRows(installed, available, options('anh viet')).map((r) => r.key)).toEqual(['en->vi']);
    expect(argosPackRows(installed, available, options('zh')).map((r) => r.key)).toEqual(['zh->en']);
    expect(argosPackRows(installed, available, options('khong co'))).toEqual([]);
  });

  it('keys a pair the way the rows track it', () => {
    expect(argosPairKey({ from: 'zh', to: 'en' })).toBe('zh->en');
  });
});
