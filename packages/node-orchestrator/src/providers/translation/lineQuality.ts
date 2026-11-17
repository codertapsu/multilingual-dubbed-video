/**
 * Per-line quality checks for a translated DUB line — what a voice can say.
 *
 * The pipeline used to validate only whole-line echoes (a line returned as its
 * own source). Everything subtler shipped: an audit of four real zh→vi dubs
 * (2026-11) found "Khu vực bán hàng của鸿蒙" and "Nữ Th娲" (Han characters
 * inside Vietnamese), "盘古大神" (a name left in Chinese), "Kunlun Xu" (pinyin a
 * Vietnamese voice cannot pronounce as the Hán-Việt "Côn Lôn Khư"), a Thai
 * letter in "Mุ่ง", and "thầy/cô" (a hedge the voice reads slash and all). Each
 * check here maps to one of those failures; every caller (the translation
 * step's repair pass, review-and-refine, auto-fit shortening) uses the same
 * verdict, so no pass can accept a line another would reject.
 *
 * Pure and dependency-free: no orchestrator imports, so the translation
 * modules can all depend on it without a cycle.
 */
import type { TranscriptSegment } from '@videodubber/shared';

/** One failed check (persisted on the segment as `qualityFlags`). */
export type QualityFlag = NonNullable<TranscriptSegment['qualityFlags']>[number];

/** What a line is checked against. */
export interface LineCheckContext {
  sourceText: string;
  sourceLanguage: string;
  targetLanguage: string;
}

/** Case/punctuation/width-insensitive comparison key for echo detection. */
export function normalizeForCompare(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .normalize('NFC');
}

/** CJK detection (Han/Kana/Hangul) — the scripts a spoken vi/en dub can't say. */
export const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** True when a reply line is effectively "not translated": absent, empty, or
 * the source text echoed back (compared punctuation/case-insensitively). Only
 * meaningful when source and target languages differ.
 *
 * Identical-to-source is only damning when the source actually needed
 * transforming: a CJK-script source in a non-CJK dub can NEVER legitimately
 * survive verbatim (the voice can't say it), while short Latin lines often do
 * ("OK", "2023", "Anna!", "iPhone 15", "No, no, no!"). So: CJK echo → always a
 * failure; otherwise only a substantial line (≥15 normalized chars) counts —
 * flagging those short lines would burn retries and pressure the model into
 * mutating already-correct output. */
export function looksUntranslated(seg: { sourceText: string }, text: string | undefined): boolean {
  if (text === undefined || text.trim().length === 0) return true;
  const src = normalizeForCompare(seg.sourceText);
  if (src.length < 2 || normalizeForCompare(text) !== src) return false;
  if (CJK_RE.test(seg.sourceText)) return true;
  return src.length >= 15;
}

const baseLanguage = (code: string): string => code.split('-')[0]!.toLowerCase();

/** Scripts a spoken line in each target language may contain besides Latin. */
const TARGET_SCRIPTS: Record<string, readonly string[]> = {
  zh: ['Han'],
  ja: ['Han', 'Hiragana', 'Katakana'],
  ko: ['Hangul', 'Han'],
  ru: ['Cyrillic'],
  uk: ['Cyrillic'],
  bg: ['Cyrillic'],
  sr: ['Cyrillic'],
  th: ['Thai'],
  el: ['Greek'],
  ar: ['Arabic'],
  fa: ['Arabic'],
  he: ['Hebrew'],
  hi: ['Devanagari'],
  bn: ['Bengali'],
  km: ['Khmer'],
  lo: ['Lao'],
  my: ['Myanmar'],
};

/** Targets written in Latin script only (a non-Latin letter is a leak). */
const LATIN_TARGETS = new Set([
  'vi', 'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'pl', 'tr', 'cs', 'ro', 'sv', 'da', 'fi', 'no', 'hu', 'id',
  'ms', 'tl',
]);

/** Every script the checks can name; anything else (Common/Inherited) is neutral. */
const KNOWN_SCRIPTS = [
  'Latin', 'Han', 'Hiragana', 'Katakana', 'Hangul', 'Thai', 'Cyrillic', 'Greek', 'Arabic', 'Hebrew',
  'Devanagari', 'Bengali', 'Khmer', 'Lao', 'Myanmar',
] as const;
const SCRIPT_RES = new Map(KNOWN_SCRIPTS.map((s) => [s, new RegExp(`\\p{Script=${s}}`, 'u')]));

/** The named scripts of the LETTERS and script-specific marks in `text`. */
function scriptsIn(text: string): Set<string> {
  const found = new Set<string>();
  // Script-specific combining marks matter: a Thai tone mark on a Latin "M"
  // ("Mุ่ง") is Script=Thai, while Vietnamese diacritics are Inherited.
  for (const ch of text.normalize('NFC')) {
    if (!/[\p{L}\p{M}]/u.test(ch)) continue;
    for (const [name, re] of SCRIPT_RES) {
      if (re.test(ch)) {
        found.add(name);
        break;
      }
    }
  }
  return found;
}

/**
 * Scripts in `text` that the target language cannot be spoken in. Latin is
 * always allowed (names, brands, numbers-with-units). For a target the table
 * does not know, only the SOURCE's own non-Latin script counts as a leak.
 */
export function wrongScripts(text: string, ctx: LineCheckContext): string[] {
  const target = baseLanguage(ctx.targetLanguage);
  const present = scriptsIn(text);
  present.delete('Latin');
  if (present.size === 0) return [];
  let allowed: Set<string>;
  if (LATIN_TARGETS.has(target)) allowed = new Set();
  else if (TARGET_SCRIPTS[target]) allowed = new Set(TARGET_SCRIPTS[target]);
  else {
    // Unknown target: we cannot say which scripts are right, but the source's
    // own script surviving into a different language is still a leak.
    if (baseLanguage(ctx.sourceLanguage) === target) return [];
    const sourceScripts = scriptsIn(ctx.sourceText);
    sourceScripts.delete('Latin');
    return [...present].filter((s) => sourceScripts.has(s));
  }
  return [...present].filter((s) => !allowed.has(s));
}

// ---- Pinyin detection (zh → Latin-script targets) ----------------------------

/** Tone-marked pinyin vowels that Vietnamese never uses (macron, caron, ü-tones). */
const PINYIN_ONLY_MARKS = /[āēīōūǖǎěǐǒǔǚǘǜ]/iu;

const PINYIN_INITIALS = [
  'zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h', 'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w',
];
const PINYIN_FINALS = [
  'iang', 'iong', 'uang', 'ueng', 'ang', 'eng', 'ing', 'ong', 'iao', 'ian', 'uai', 'uan', 'ai', 'ei', 'ao', 'ou',
  'an', 'en', 'er', 'ia', 'ie', 'iu', 'in', 'ua', 'uo', 'ui', 'un', 'ue', 'a', 'o', 'e', 'i', 'u',
];
/**
 * Pinyin writes a syllable with no initial only when it starts with a/o/e
 * (i/u/ü-initial ones are spelled with y/w: "yi", "wu", "yu"). Allowing bare
 * i/u/v here let English words segment ("video" → v·i·de·o).
 */
const PINYIN_ZERO_INITIAL = ['a', 'o', 'e', 'ai', 'ei', 'ao', 'ou', 'an', 'en', 'ang', 'eng', 'er'];
/**
 * Loose pinyin syllable inventory: every initial × final pairing, including
 * some Mandarin never uses. Looser only means "more tokens CAN segment", and a
 * token still has to fail the Vietnamese-syllable test below to be flagged.
 */
const PINYIN_SYLLABLES: ReadonlySet<string> = new Set([
  ...PINYIN_INITIALS.flatMap((i) => PINYIN_FINALS.map((f) => i + f)),
  ...PINYIN_ZERO_INITIAL,
]);
const MAX_PINYIN_SYLLABLE = Math.max(...[...PINYIN_SYLLABLES].map((s) => s.length));

/** Split a lowercase ASCII token into loose pinyin syllables, or undefined. */
export function segmentPinyin(token: string): string[] | undefined {
  const n = token.length;
  // best[i] = a segmentation of token[i..] (fewest syllables), memoised.
  const memo = new Map<number, string[] | undefined>();
  const solve = (i: number): string[] | undefined => {
    if (i === n) return [];
    if (memo.has(i)) return memo.get(i);
    let best: string[] | undefined;
    for (let len = Math.min(MAX_PINYIN_SYLLABLE, n - i); len >= 1; len--) {
      const syl = token.slice(i, i + len);
      if (!PINYIN_SYLLABLES.has(syl)) continue;
      const rest = solve(i + len);
      if (rest && (!best || rest.length + 1 < best.length)) best = [syl, ...rest];
    }
    memo.set(i, best);
    return best;
  };
  return solve(0);
}

/** Bare (diacritic-less) vowel clusters that occur in real Vietnamese syllables. */
const VI_BARE_NUCLEI = new Set([
  'a', 'e', 'i', 'o', 'u', 'y', 'ai', 'ao', 'au', 'ay', 'eo', 'ia', 'iu', 'oa', 'oe', 'oi', 'ua', 'ue', 'ui', 'uy',
  'oai', 'oay', 'uay', 'uya',
]);
/**
 * Clusters that only occur OPEN: ending in a glide (ai, ao, eo, ui…), or the
 * diphthongs that turn into iê/uô once a consonant closes them ("kia" but
 * "tiên", "mua" but "muốn") — so bare "tian"/"tuan" are never Vietnamese.
 */
const VI_OPEN_ONLY_NUCLEI = new Set(['ai', 'ao', 'au', 'ay', 'eo', 'ia', 'iu', 'oi', 'ua', 'ui', 'oai', 'oay', 'uay', 'uya']);
const VI_SYLLABLE_RE = /^(ngh|ng|nh|gh|gi|kh|ph|th|tr|ch|qu|[bcdghklmnprstvx])?([aeiouy]+)(ch|ng|nh|[cmnpt])?$/;

/**
 * Could this diacritic-less token be ONE written Vietnamese syllable? Plenty
 * are ("anh", "con", "ta", "sao"), and they must never be flagged. Spelling
 * rules that pinyin breaks: k only before e/i/y, c never before them, g/ng
 * never before e/i (that is gh/ngh), no f/j/w/z at all, and only the vowel
 * clusters Vietnamese writes without diacritics ("ie", "uo", "ou", "ei" always
 * carry a mark in real Vietnamese: iê, uô/ươ).
 */
export function isPlausibleVietnameseSyllable(token: string): boolean {
  const m = VI_SYLLABLE_RE.exec(token);
  if (!m) return false;
  const initial = m[1] ?? '';
  const nucleus = m[2]!;
  if (!VI_BARE_NUCLEI.has(nucleus)) return false;
  if (m[3] && VI_OPEN_ONLY_NUCLEI.has(nucleus)) return false;
  const front = /^[eiy]/.test(nucleus);
  if (initial === 'k' && !front) return false;
  if (initial === 'c' && front) return false;
  if ((initial === 'gh' || initial === 'ngh') && !/^[ei]/.test(nucleus)) return false;
  if ((initial === 'g' || initial === 'ng') && /^[ei]/.test(nucleus)) return false;
  return true;
}

/** Laughter that segments as pinyin ("haha" = ha·ha) but is fine in any dub. */
const INTERJECTION_RE = /^(ha|he|hi|ho|hu)\1+h?$/;

/**
 * True for a romanized-Chinese token: carries a pinyin-only tone mark, or is
 * plain ASCII that segments into pinyin syllables yet is not one written
 * Vietnamese syllable ("Kunlun", "Hongmeng", "Pangu", "Nuwa", "Tian", "Feng").
 * Vietnamese writes one syllable per word, so a multi-syllable romanized word
 * is never the Hán-Việt form the voice needs.
 */
export function isPinyinToken(raw: string): boolean {
  const token = raw.normalize('NFC');
  if (PINYIN_ONLY_MARKS.test(token)) return true;
  // Short all-caps tokens are acronyms ("CEO", "TV"), not names.
  if (token.length <= 5 && token === token.toUpperCase()) return false;
  const lower = token.toLowerCase();
  if (!/^[a-z]+$/.test(lower) || lower.length < 2) return false;
  if (isPlausibleVietnameseSyllable(lower)) return false;
  if (INTERJECTION_RE.test(lower)) return false;
  return segmentPinyin(lower) !== undefined;
}

/** Latin-letter words of a line (hyphenated parts are separate words). */
function latinWords(text: string): string[] {
  return text
    .normalize('NFC')
    .split(/[^\p{L}\p{M}]+/u)
    .filter((w) => w.length > 0 && /\p{Script=Latin}/u.test(w));
}

/**
 * Loanwords and brands a Vietnamese line writes in Latin letters that happen
 * to read as pinyin. Measured: every one of these was flagged ("Tối nay chơi
 * game không", "Đi taxi", "Nike"), and a flagged line can never be shortened
 * or polished, since every pass refuses a line with a flag. Lowercase they are
 * exempt anyway (a name is capitalized); this list covers a sentence start and
 * brand names. Chinese words with a Hán-Việt form (taichi → Thái Cực, tofu →
 * đậu phụ) are deliberately absent.
 */
const VI_LATIN_LOANWORDS: ReadonlySet<string> = new Set([
  'anime', 'bida', 'boba', 'cafe', 'camera', 'casino', 'coca', 'cola', 'demo', 'fan', 'ferrari', 'game', 'gamer',
  'karaoke', 'mafia', 'manga', 'meme', 'menu', 'mini', 'mode', 'nike', 'ninja', 'panda', 'piano', 'queen', 'radio',
  'ramen', 'sake', 'samurai', 'sofa', 'soju', 'super', 'sushi', 'taxi', 'tea', 'tiger', 'toyota', 'wifi', 'yamaha',
  'yoga', 'youtube', 'zalo',
]);

/**
 * True when a Vietnamese line carries a pinyin NAME. Names are capitalized;
 * a hyphenated transliteration ("Na-er-gơ") counts as one name from its
 * capitalized head. A pinyin-only tone mark is pinyin wherever it is.
 */
function hasPinyinName(line: string): boolean {
  for (const compound of line.normalize('NFC').split(/[^\p{L}\p{M}-]+/u)) {
    const parts = compound.split('-').filter((w) => w.length > 0 && /\p{Script=Latin}/u.test(w));
    if (parts.some((p) => PINYIN_ONLY_MARKS.test(p))) return true;
    const head = parts[0];
    if (!head || head[0] === head[0]!.toLowerCase()) continue; // "chơi game": a loanword, not a name
    if (parts.length === 1 && VI_LATIN_LOANWORDS.has(head.toLowerCase())) continue;
    if (parts.some(isPinyinToken)) return true;
  }
  return false;
}

/** Any Latin letter beyond ASCII — Vietnamese tones/hooks/breves, đ. */
const VI_DIACRITIC_RE = /[À-ɏḀ-ỿ]/u;

/** A slash between two words: a hedge ("thầy/cô", "anh/chị"), not a fraction. */
const ALTERNATIVES_RE = /([\p{L}\p{M}]+)\s*\/\s*([\p{L}\p{M}]+)/gu;
/** Unit symbols before a slash: "60 km/h", "100 km/giờ", "3 m/s" are rates, not hedges. */
const UNIT_BEFORE_SLASH = /^(km|m|cm|mm|kg|g|mg|l|ml|kw|kwh|mph|vnd|vnđ|usd|đ)$/iu;

/** A hedge offering alternatives ("thầy/cô"), not a unit rate ("km/h"). */
function hasAlternatives(line: string): boolean {
  for (const m of line.matchAll(ALTERNATIVES_RE)) {
    const [, before, after] = m;
    if (UNIT_BEFORE_SLASH.test(before!) || after!.length === 1) continue;
    return true;
  }
  return false;
}

/**
 * Check one translated dub line. Returns the failed checks (empty = clean).
 * Order is by severity, most severe first (see {@link qualityScore}).
 */
export function checkDubLine(text: string | undefined, ctx: LineCheckContext): QualityFlag[] {
  const flags: QualityFlag[] = [];
  const line = (text ?? '').trim();
  const crossLanguage = baseLanguage(ctx.sourceLanguage) !== baseLanguage(ctx.targetLanguage);
  if (line.length === 0 || (crossLanguage && looksUntranslated(ctx, line))) {
    return ['untranslated'];
  }
  if (wrongScripts(line, ctx).length > 0) flags.push('wrong-script');
  const target = baseLanguage(ctx.targetLanguage);
  // Vietnamese only: it reads Chinese names in Hán-Việt ("Côn Lôn Khư"), which
  // its voice can say. Every other Latin-script language writes them in pinyin
  // — and the check flagged ordinary English ("like", "she", "we", "win").
  if (target === 'vi' && baseLanguage(ctx.sourceLanguage) === 'zh' && hasPinyinName(line)) {
    flags.push('pinyin');
  }
  if (target === 'vi') {
    const words = latinWords(line);
    if (words.length >= 4 && !words.some((w) => VI_DIACRITIC_RE.test(w))) flags.push('no-diacritics');
  }
  if (hasAlternatives(line)) flags.push('alternatives');
  return flags;
}

const SEVERITY: Record<QualityFlag, number> = {
  untranslated: 16,
  'wrong-script': 8,
  pinyin: 4,
  'no-diacritics': 2,
  alternatives: 1,
};

/** Badness of a set of failed checks (0 = clean); lower is better. */
export function qualityScore(flags: readonly QualityFlag[]): number {
  return flags.reduce((sum, f) => sum + SEVERITY[f], 0);
}

/** One candidate translation of a line with its check result. */
export interface LineCandidate {
  text: string;
  flags: QualityFlag[];
}

/**
 * The best of several candidates: fewest/least severe failures, ties to the
 * EARLIEST (the original line wins a tie against a rewrite that fixed
 * nothing, so a repair attempt never churns text for no gain).
 */
export function pickBestCandidate(candidates: readonly LineCandidate[]): LineCandidate | undefined {
  let best: LineCandidate | undefined;
  for (const c of candidates) {
    if (!best || qualityScore(c.flags) < qualityScore(best.flags)) best = c;
  }
  return best;
}

/** Plain-language description of what is wrong, for a repair prompt. */
export function describeFlags(flags: readonly QualityFlag[], targetLanguage: string): string {
  const vi = baseLanguage(targetLanguage) === 'vi';
  const parts = flags.map((f) => {
    switch (f) {
      case 'untranslated':
        return 'it is not translated (empty, or still the source text)';
      case 'wrong-script':
        return vi
          ? 'it contains characters that are not Vietnamese (Chinese/Japanese/Korean/Thai/Cyrillic) — write every name in Hán-Việt with Vietnamese letters'
          : 'it contains characters from a script the target language is not written in';
      case 'pinyin':
        return vi
          ? 'it contains a pinyin (romanized Chinese) name — use its Hán-Việt reading instead (e.g. 长安 → Trường An, never "Chang\'an")'
          : 'it contains a pinyin (romanized Chinese) name — use the standard target-language form';
      case 'no-diacritics':
        return 'it has no Vietnamese diacritics at all — it must be natural Vietnamese with full tone marks';
      case 'alternatives':
        return 'it offers alternatives with "/" — choose exactly ONE form; the line is spoken aloud';
    }
  });
  return parts.join('; ');
}
