/**
 * Whether speech-to-text is checked against the video's own burned-in
 * subtitles (settings.subtitleCoverageCheck): the project's choice, else on
 * where such subtitles are the rule, in Chinese, Japanese and Korean video.
 * The check reads the subtitle band of every fifth of a second, which costs a
 * decode of the whole picture (a few minutes per hour of video), so it is not
 * paid for every other language by default; anyone can turn it on. Shared so
 * the screens show the same answer the runner acts on.
 */

/** Spoken languages whose video burns its subtitles in by habit. */
const SUBTITLED_BY_HABIT: ReadonlySet<string> = new Set(['zh', 'yue', 'ja', 'ko']);

/** Whether the subtitle check runs: the setting, else on for Chinese, Japanese and Korean. Pure. */
export function subtitleCheckOn(setting: boolean | undefined, sourceLanguage: string | undefined): boolean {
  if (typeof setting === 'boolean') return setting;
  const base = (sourceLanguage ?? '').split('-')[0]!.toLowerCase();
  return SUBTITLED_BY_HABIT.has(base);
}
