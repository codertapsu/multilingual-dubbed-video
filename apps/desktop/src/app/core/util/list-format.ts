/**
 * Small text helpers for the long lists (Projects, Download videos): search
 * that ignores case and Vietnamese accents, a file's name without its folder,
 * a date as short as it can be told apart, and a video length the way players
 * write it. Pure.
 */

/** Case- and accent-insensitive text, so "xuyen khong" finds "Xuyên Không". */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase();
}

/** The file name of a path (either slash), for a row that has no room for the whole path. */
export function fileName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

/** A video's length the way players show it: "2:30", "48:00", "8:12:00". */
export function clockDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor(total / 60) % 60;
  const s = total % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}

/**
 * A date as short as it can be told apart: the time today, the day this year,
 * the full date before. `locale` is the app's ("vi" writes "25 thg 11").
 */
export function shortDate(iso: string, locale: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const sameDay = d.toDateString() === now.toDateString();
  const opts: Intl.DateTimeFormatOptions = sameDay
    ? { hour: '2-digit', minute: '2-digit' }
    : d.getFullYear() === now.getFullYear()
      ? { day: 'numeric', month: 'short' }
      : { day: 'numeric', month: 'short', year: 'numeric' };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}
