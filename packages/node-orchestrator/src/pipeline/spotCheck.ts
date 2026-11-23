/**
 * Spot-checking a transcript against its audio (docs/plans/
 * production-requests-2026-11-23.md 1.6): a minute of every half hour is
 * decoded again without context and compared with the lines there by their
 * character bigrams.
 *
 * WHY: the garbled join of P3/P4 in the 27.8-hour series left 5.3 hours of a
 * transcript that did not match its audio, found only by listening. Measured
 * on that run, aligned windows agree 0.83-0.97 and garbled ones 0.01-0.05, so
 * a window below 0.3 fails; one window per hour would have caught that span
 * about five times. Around a failure more windows are checked to find where
 * the mismatch starts and ends. Windows where neither side has 20 CJK
 * characters (music, a battle) are skipped: there is nothing to compare.
 *
 * Pure except {@link runSpotCheck}, which takes the decode as a dependency.
 */
import { AppErrorException, type TranscriptSegment } from '@videodubber/shared';
import { normalizeLine } from './loopRepair.js';
import type { SpeechRegion } from './segmentTiming.js';
import { normalizeRegions, speechMsIn } from './sttChecks.js';

/** Each check decodes this much. */
export const SPOT_WINDOW_MS = 60_000;
/** One window in every this much of the video (two per hour). */
export const SPOT_EVERY_MS = 30 * 60_000;
/** A window agreeing less than this with the lines fails. */
export const SPOT_MIN_OVERLAP = 0.3;
/** Fewer CJK characters than this on both sides: nothing to compare. */
export const SPOT_MIN_CHARS = 20;
/** Without the setting, the check runs on videos longer than this. */
export const SPOT_DEFAULT_FROM_MS = 2 * 3_600_000;
/** Where in its half hour a window goes: the minute with the most speech, searched in these steps. */
const SEARCH_STEP_MS = 10_000;
/**
 * Halvings of the gap between a failed and a passed window, per side of a
 * mismatch: from half an hour to about 4 minutes, 6 windows for a span.
 */
const REFINE_STEPS = 3;
/** At most this many windows on top of the regular ones. */
const MAX_EXTRA_WINDOWS = 24;

/** Whether the check runs: the project's setting, else on for videos over 2 hours. Pure. */
export function spotCheckOn(setting: boolean | undefined, totalMs: number): boolean {
  return setting ?? totalMs > SPOT_DEFAULT_FROM_MS;
}

/**
 * Traditional characters common in dialogue, each with its simplified form. A
 * decode without context can answer in either script; both sides are compared
 * in the simplified one, or a window in the other script would look garbled.
 */
const TRADITIONAL_TO_SIMPLIFIED = new Map(
  (
    '們们 這这 說说 個个 麼么 來来 時时 對对 會会 過过 還还 讓让 嗎吗 為为 裡里 裏里 後后 沒没 見见 開开 從从 ' +
    '點点 話话 學学 間间 問问 頭头 現现 動动 認认 樣样 經经 發发 長长 實实 東东 國国 給给 兒儿 邊边 種种 無无 ' +
    '難难 歡欢 謝谢 請请 聽听 進进 關关 應应 機机 爺爷 媽妈 帶带 該该 錢钱 電电 處处 親亲 愛爱 師师 總总 將将 ' +
    '錯错 殺杀 戰战 書书 當当 陽阳 張张 體体 員员 氣气 業业 樂乐 歲岁 飯饭 願愿 隻只 夠够 隊队 辦办 報报 場场 ' +
    '號号 雖虽 聲声 熱热 腦脑 驚惊 嚇吓 罵骂 輕轻 鬆松 傷伤 醫医 藥药 準准 備备 讀读 寫写 筆笔 紙纸 層层 樓楼 ' +
    '門门 園园 車车 馬马 魚鱼 鳥鸟 龍龙 鳳凤 飛飞 風风 雲云 葉叶 華华 傳传 統统 條条 記记 計计 許许 論论 議议 ' +
    '設设 證证 試试 誰谁 語语 調调 識识 護护 變变 歷历 劇剧 劉刘 趙赵 陳陈 楊杨 黃黄 孫孙 鄭郑 羅罗 韓韩 蘇苏 ' +
    '陸陆 齊齐 衛卫 軍军 騎骑 劍剑 槍枪 萬万 與与 爾尔 覺觉 臉脸 寶宝 貝贝 買买 賣卖 鐘钟 陣阵 隨随 險险 雙双 ' +
    '顏颜 類类 題题 須须 預预 領领 頂顶 順顺 頓顿 煩烦 燒烧 爭争 狀状 獨独 獲获 環环 產产 畫画 盡尽 監监 禮礼 ' +
    '稱称 窮穷 節节 簡简 級级 結结 絕绝 線线 練练 組组 細细 終终 維维 網网 緊紧 續续 罷罢 義义 聞闻 腳脚 興兴 ' +
    '舉举 莊庄 術术 衝冲 裝装 規规 視视 觀观 詞词 詩诗 誤误 課课 談谈 謀谋 講讲 貨货 責责 貴贵 費费 資资 賊贼 ' +
    '趕赶 跡迹 躍跃 輛辆 輸输 轉转 辭辞 農农 運运 達达 遠远 選选 遲迟 鄉乡 醜丑 釋释 針针 鋒锋 錄录 鏡镜 閉闭 ' +
    '閃闪 閣阁 隱隐 雜杂 雞鸡 離离 靈灵 響响 頁页 項项 飲饮 餓饿 館馆 驗验 鬥斗 鬧闹 麗丽 黨党 齒齿 傢家 夥伙 ' +
    '幫帮 兩两 幾几 遊游 塊块 婦妇 敵敌 勝胜 敗败 帥帅 營营 擊击 揮挥 淚泪 夢梦 聖圣 儀仪 宮宫 廟庙 縣县 鎮镇 ' +
    '職职 務务 價价 賺赚 虧亏 債债 幣币 銀银 鐵铁 彈弹 別别 剛刚 著着 説说 爲为 臺台 髮发 啟启 歸归 戲戏 蓋盖 ' +
    '罰罚 謊谎 慘惨 憐怜 滅灭 煙烟 燈灯 牆墙 糧粮 補补 襲袭 訴诉 誠诚 豐丰 貓猫 賞赏 質质 軟软 輩辈 鄰邻 鋼钢 ' +
    '閒闲 陰阴 靜静 飽饱 餘余 髒脏 鳴鸣 於于 麵面'
  )
    .split(' ')
    .map((pair) => [...pair] as [string, string]),
);

/** The traditional-to-simplified pairs (for the tests). */
export const SCRIPT_PAIRS: ReadonlyMap<string, string> = TRADITIONAL_TO_SIMPLIFIED;

/** Text as the check compares it: no punctuation or spaces, lower case, simplified script. Pure. */
export function spotText(text: string): string {
  let out = '';
  for (const ch of normalizeLine(text)) out += TRADITIONAL_TO_SIMPLIFIED.get(ch) ?? ch;
  return out;
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Chinese, Japanese and Korean characters in a text. Pure. */
export function cjkChars(text: string): number {
  let n = 0;
  for (const ch of text) if (CJK.test(ch)) n += 1;
  return n;
}

/** Languages written in CJK characters (the check compares those). */
const CJK_LANGUAGES = new Set(['zh', 'ja', 'ko', 'yue', 'cmn']);

/**
 * Whether the spot check can compare this transcript: its language is
 * written in CJK characters, or most of its letters are. Pure.
 */
export function comparableTranscript(language: string | undefined, lines: readonly Pick<TranscriptSegment, 'sourceText'>[]): boolean {
  if (language && CJK_LANGUAGES.has(language.split('-')[0]!.toLowerCase())) return true;
  let cjk = 0;
  let letters = 0;
  for (const l of lines) {
    for (const ch of l.sourceText) {
      if (CJK.test(ch)) {
        cjk += 1;
        letters += 1;
      } else if (/\p{L}/u.test(ch)) {
        letters += 1;
      }
    }
  }
  return letters > 0 && cjk / letters >= 0.5;
}

/**
 * How much two texts agree, 0..1: the Dice coefficient of their character
 * bigrams (counted with repeats). Two decodes of the same minute differ in a
 * word here and there; a garbled transcript shares almost no pairs. Pure.
 */
export function bigramOverlap(a: string, b: string): number {
  const grams = (s: string): Map<string, number> => {
    const chars = [...s];
    const m = new Map<string, number>();
    for (let i = 0; i + 1 < chars.length; i++) {
      const g = chars[i]! + chars[i + 1]!;
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let na = 0;
  let nb = 0;
  let both = 0;
  for (const n of ga.values()) na += n;
  for (const [g, n] of gb) {
    nb += n;
    both += Math.min(n, ga.get(g) ?? 0);
  }
  return na + nb === 0 ? 0 : (2 * both) / (na + nb);
}

/** The text of the lines whose middle is inside [fromMs, toMs). Pure. */
export function linesTextIn(lines: readonly Pick<TranscriptSegment, 'startMs' | 'endMs' | 'sourceText'>[], fromMs: number, toMs: number): string {
  return lines
    .filter((l) => {
      const mid = (l.startMs + l.endMs) / 2;
      return mid >= fromMs && mid < toMs;
    })
    .map((l) => l.sourceText)
    .join('');
}

/** A minute of the video to check. */
export interface SpotWindow {
  fromMs: number;
  toMs: number;
}

/** How a window compared. */
export interface SpotScore {
  /** 0..1; absent when skipped. */
  overlap?: number;
  skipped?: 'little-text' | 'decode-failed';
}

/** Compare a window's lines with its second decode. Pure. */
export function scoreSpot(transcriptText: string, decodedText: string): SpotScore {
  const a = spotText(transcriptText);
  const b = spotText(decodedText);
  if (cjkChars(a) < SPOT_MIN_CHARS && cjkChars(b) < SPOT_MIN_CHARS) return { skipped: 'little-text' };
  return { overlap: bigramOverlap(a, b) };
}

/**
 * The minute of [fromMs, toMs] with the most speech (the speech map), or its
 * middle minute without a map; undefined when shorter than a minute. Pure.
 */
export function bestWindow(fromMs: number, toMs: number, regions?: readonly SpeechRegion[]): SpotWindow | undefined {
  const span = toMs - fromMs;
  if (span < SPOT_WINDOW_MS) return undefined;
  if (!regions || regions.length === 0) {
    const start = fromMs + Math.floor((span - SPOT_WINDOW_MS) / 2);
    return { fromMs: start, toMs: start + SPOT_WINDOW_MS };
  }
  let best = fromMs;
  let bestSpeech = -1;
  for (let s = fromMs; s + SPOT_WINDOW_MS <= toMs; s += SEARCH_STEP_MS) {
    const speech = speechMsIn(regions, s, s + SPOT_WINDOW_MS);
    if (speech > bestSpeech) {
      bestSpeech = speech;
      best = s;
    }
  }
  return { fromMs: best, toMs: best + SPOT_WINDOW_MS };
}

/** The regular windows: one per half hour, the minute with the most speech in it. Pure. */
export function planSpotWindows(totalMs: number, regions?: readonly SpeechRegion[]): SpotWindow[] {
  const out: SpotWindow[] = [];
  for (let from = 0; from < totalMs; from += SPOT_EVERY_MS) {
    const w = bestWindow(from, Math.min(from + SPOT_EVERY_MS, totalMs), regions);
    if (w) out.push(w);
  }
  return out;
}

/** A checked window. */
export interface SpotResult extends SpotWindow, SpotScore {
  failed: boolean;
}

/** Where the transcript does not match the audio: consecutive failed windows. */
export interface MismatchSpan {
  /** The first failed window's start, the last one's end. */
  fromMs: number;
  toMs: number;
  /** Failed windows in it. */
  failed: number;
  /** The best agreement among them (0..1, below the threshold). */
  best: number;
}

/**
 * Consecutive failed windows, in time order. A passed window ends a span; a
 * skipped one (music, no decode) does not, since it says nothing. Pure.
 */
export function mismatchSpans(results: readonly SpotResult[]): MismatchSpan[] {
  const spans: MismatchSpan[] = [];
  let open: MismatchSpan | undefined;
  for (const r of [...results].sort((a, b) => a.fromMs - b.fromMs)) {
    if (r.failed) {
      if (open) {
        open.toMs = Math.max(open.toMs, r.toMs);
        open.failed += 1;
        open.best = Math.max(open.best, r.overlap ?? 0);
      } else {
        open = { fromMs: r.fromMs, toMs: r.toMs, failed: 1, best: r.overlap ?? 0 };
        spans.push(open);
      }
    } else if (r.overlap !== undefined) {
      open = undefined;
    }
  }
  return spans;
}

/** What {@link runSpotCheck} needs. */
export interface SpotCheckDeps {
  /** Decode [fromMs, toMs) of the audio again, without context; the text heard. */
  decode(fromMs: number, toMs: number, signal: AbortSignal): Promise<readonly Pick<TranscriptSegment, 'sourceText'>[]>;
  /** After each window: windows done, and planned so far. */
  progress?(done: number, total: number): Promise<void> | void;
}

/**
 * Check the regular windows, then halve the gap on each side of every
 * mismatch (up to {@link REFINE_STEPS} times, {@link MAX_EXTRA_WINDOWS} in
 * all) to find where it starts and ends. A failed decode skips its window; a
 * cancel (the signal) is thrown.
 */
export async function runSpotCheck(
  lines: readonly Pick<TranscriptSegment, 'startMs' | 'endMs' | 'sourceText'>[],
  totalMs: number,
  speechMap: readonly SpeechRegion[] | undefined,
  deps: SpotCheckDeps,
  signal: AbortSignal,
): Promise<{ results: SpotResult[]; spans: MismatchSpan[] }> {
  const regions = speechMap ? normalizeRegions(speechMap) : undefined;
  const results: SpotResult[] = [];
  let planned = 0;
  let done = 0;
  const check = async (w: SpotWindow): Promise<SpotResult> => {
    let score: SpotScore;
    try {
      const heard = await deps.decode(w.fromMs, w.toMs, signal);
      score = scoreSpot(linesTextIn(lines, w.fromMs, w.toMs), heard.map((h) => h.sourceText).join(''));
    } catch (err) {
      if (signal.aborted) throw err;
      score = { skipped: 'decode-failed' };
    }
    const result: SpotResult = { ...w, ...score, failed: score.overlap !== undefined && score.overlap < SPOT_MIN_OVERLAP };
    results.push(result);
    done += 1;
    await deps.progress?.(done, planned);
    return result;
  };

  const regular = planSpotWindows(totalMs, regions);
  planned = regular.length;
  for (const w of regular) {
    throwIfAborted(signal);
    await check(w);
  }

  // Densify around each mismatch: on each side, halve the gap between its
  // outermost failed window and the nearest window that passed (or the
  // video's edge), checking a minute near the middle.
  let extra = 0;
  const passed = (): SpotResult[] => results.filter((r) => !r.failed && r.overlap !== undefined);
  /** One more window in [lo, hi] near its middle; undefined when the gap is too small or the budget spent. */
  const probe = async (lo: number, hi: number): Promise<SpotResult | undefined> => {
    if (extra >= MAX_EXTRA_WINDOWS || hi - lo < 2 * SPOT_WINDOW_MS) return undefined;
    const mid = (lo + hi) / 2;
    const w = bestWindow(Math.max(lo, mid - SPOT_EVERY_MS / 6), Math.min(hi, mid + SPOT_EVERY_MS / 6), regions);
    if (!w) return undefined;
    throwIfAborted(signal);
    extra += 1;
    planned += 1;
    return check(w);
  };
  for (const span of mismatchSpans(results)) {
    // Before it: from the last pass (or the start) to its first failure.
    let lo = Math.max(0, ...passed().filter((r) => r.toMs <= span.fromMs).map((r) => r.toMs));
    let hi = span.fromMs;
    for (let step = 0; step < REFINE_STEPS; step++) {
      const r = await probe(lo, hi);
      if (!r || r.overlap === undefined) break;
      if (r.failed) hi = r.fromMs;
      else lo = r.toMs;
    }
    // After it: from its last failure to the next pass (or the end).
    lo = span.toMs;
    hi = Math.min(totalMs, ...passed().filter((r) => r.fromMs >= span.toMs).map((r) => r.fromMs));
    for (let step = 0; step < REFINE_STEPS; step++) {
      const r = await probe(lo, hi);
      if (!r || r.overlap === undefined) break;
      if (r.failed) lo = r.toMs;
      else hi = r.fromMs;
    }
  }
  return { results: [...results].sort((a, b) => a.fromMs - b.fromMs), spans: mismatchSpans(results) };
}

/** A pause stops the check like the rest of the step (pausePipelineState). */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new AppErrorException('CANCELLED', 'Pipeline run was cancelled.');
}
