/**
 * scripts/eval-translation.ts — A/B EN<->VI translation eval harness.
 *
 * The deep-research pass found NO published EN<->VI head-to-head for
 * TranslateGemma vs Argos/NLLB, and NO published VI->EN number at all. So before
 * marketing TranslateGemma as "better than Argos", run this: it drives the REAL
 * provider classes (same prompts, same gemma-turn handling) against whatever
 * engines you point it at, and reports a dependency-free chrF score per direction
 * plus a side-by-side dump for human A/B.
 *
 * chrF is a rough proxy (character n-gram F2). For a real eval use a bigger
 * parallel set (FLORES+ devtest, PhoMT) and a learned metric (COMET / MetricX).
 *
 * Usage (start the engines first):
 *   # Argos (the bundled translation worker on :5102) — always tried.
 *   # Ollama with a TranslateGemma model pulled:
 *   EVAL_OLLAMA=1 OLLAMA_MODEL=translategemma:4b pnpm eval:translation
 *   # A running llama-server (managed pack or your own), base URL = host root:
 *   EVAL_LLAMACPP_URL=http://127.0.0.1:8080 pnpm eval:translation
 *   # Your own test set (JSONL of {"dir":"en-vi"|"vi-en","src":"...","ref":"..."}):
 *   pnpm eval:translation -- --testset path/to/set.jsonl
 *
 * Needs the workspace built once (`pnpm build`) so `@videodubber/shared` resolves.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { TranslationInput, TranslationProvider } from '@videodubber/shared';
import { ArgosTranslationProvider } from '../packages/node-orchestrator/src/providers/translation/argosProvider.js';
import { LocalLlmTranslationProvider } from '../packages/node-orchestrator/src/providers/translation/localLlmTranslationProvider.js';

interface Pair {
  dir: 'en-vi' | 'vi-en';
  src: string;
  ref: string;
}

/**
 * A tiny SAMPLE set so the harness runs out of the box — REPLACE it with FLORES+
 * / PhoMT (via --testset) for any decision-grade number. References are basic
 * conversational Vietnamese; chrF on 8 sentences is indicative, not conclusive.
 */
const SAMPLE: Pair[] = [
  { dir: 'en-vi', src: 'Hello, how are you?', ref: 'Xin chào, bạn khỏe không?' },
  { dir: 'en-vi', src: 'Thank you very much for your help.', ref: 'Cảm ơn bạn rất nhiều vì đã giúp đỡ.' },
  { dir: 'en-vi', src: 'What time does the train leave?', ref: 'Tàu khởi hành lúc mấy giờ?' },
  { dir: 'en-vi', src: 'The weather is really nice today.', ref: 'Hôm nay thời tiết thật đẹp.' },
  { dir: 'en-vi', src: 'Could you please speak more slowly?', ref: 'Bạn có thể nói chậm hơn được không?' },
  { dir: 'vi-en', src: 'Tôi muốn một tách cà phê.', ref: 'I would like a cup of coffee.' },
  { dir: 'vi-en', src: 'Nhà ga ở đâu vậy?', ref: 'Where is the train station?' },
  { dir: 'vi-en', src: 'Bộ phim này thực sự rất thú vị.', ref: 'This movie was really interesting.' },
];

/** Standard chrF (character n-gram F-beta, macro-averaged over n=1..6, beta=2). */
function chrF(hyp: string, ref: string, maxN = 6, beta = 2): number {
  const grams = (s: string, k: number): Map<string, number> => {
    const t = s.replace(/\s+/g, '').toLowerCase();
    const m = new Map<string, number>();
    for (let i = 0; i + k <= t.length; i++) {
      const g = t.slice(i, i + k);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ps: number[] = [];
  const rs: number[] = [];
  for (let k = 1; k <= maxN; k++) {
    const h = grams(hyp, k);
    const r = grams(ref, k);
    let match = 0;
    let hTot = 0;
    let rTot = 0;
    for (const [g, c] of h) {
      hTot += c;
      if (r.has(g)) match += Math.min(c, r.get(g)!);
    }
    for (const [, c] of r) rTot += c;
    ps.push(hTot ? match / hTot : 0);
    rs.push(rTot ? match / rTot : 0);
  }
  const avg = (a: number[]): number => a.reduce((x, y) => x + y, 0) / a.length;
  const P = avg(ps);
  const R = avg(rs);
  if (P + R === 0) return 0;
  const b2 = beta * beta;
  return 100 * (((1 + b2) * P * R) / (b2 * P + R));
}

function loadTestset(): Pair[] {
  const i = process.argv.indexOf('--testset');
  if (i >= 0 && process.argv[i + 1]) {
    const lines = readFileSync(process.argv[i + 1]!, 'utf8').split('\n').filter((l) => l.trim());
    return lines.map((l) => JSON.parse(l) as Pair);
  }
  return SAMPLE;
}

/** The engines to compare — only those the environment points at are included. */
function buildEngines(): { name: string; provider: TranslationProvider }[] {
  const timeout = 120_000;
  const engines: { name: string; provider: TranslationProvider }[] = [];

  const argosUrl = process.env.EVAL_ARGOS_URL ?? 'http://127.0.0.1:5102';
  engines.push({ name: 'argos', provider: new ArgosTranslationProvider(argosUrl, timeout) });

  if (process.env.EVAL_OLLAMA === '1' || process.env.OLLAMA_URL) {
    const baseUrl = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434/v1';
    const model = process.env.OLLAMA_MODEL ?? 'translategemma:4b';
    engines.push({
      name: `ollama:${model}`,
      provider: new LocalLlmTranslationProvider({ id: 'ollama', backend: 'ollama', model, resolveBaseUrl: async () => baseUrl, timeoutMs: timeout }),
    });
  }

  if (process.env.EVAL_LLAMACPP_URL) {
    const baseUrl = process.env.EVAL_LLAMACPP_URL;
    engines.push({
      name: 'llama-cpp:translategemma',
      provider: new LocalLlmTranslationProvider({ id: 'llama-cpp', backend: 'llama-cpp', model: 'translategemma', resolveBaseUrl: async () => baseUrl, timeoutMs: timeout }),
    });
  }

  return engines;
}

async function translateAll(provider: TranslationProvider, pairs: Pair[], dir: 'en-vi' | 'vi-en'): Promise<string[]> {
  const sub = pairs.filter((p) => p.dir === dir);
  if (sub.length === 0) return [];
  const [source, target] = dir === 'en-vi' ? ['en', 'vi'] : ['vi', 'en'];
  const input: TranslationInput = {
    sourceLanguage: source,
    targetLanguage: target,
    segments: sub.map((p, i) => ({ id: `seg_${i}`, sourceText: p.src })),
  };
  const out = await provider.translateSegments(input);
  return out.segments.map((s) => s.translatedText);
}

async function main(): Promise<void> {
  const pairs = loadTestset();
  const engines = buildEngines();
  const dirs: ('en-vi' | 'vi-en')[] = ['en-vi', 'vi-en'];

  const rows: string[] = ['| engine | EN→VI chrF | VI→EN chrF |', '|---|---|---|'];
  const dump: string[] = [`# Translation A/B — ${pairs.length} pairs\n`];

  for (const { name, provider } of engines) {
    const means: Record<string, number | null> = {};
    for (const dir of dirs) {
      const sub = pairs.filter((p) => p.dir === dir);
      try {
        const hyps = await translateAll(provider, pairs, dir);
        if (hyps.length === 0) {
          means[dir] = null;
          continue;
        }
        const scores = sub.map((p, i) => chrF(hyps[i] ?? '', p.ref));
        means[dir] = scores.reduce((a, b) => a + b, 0) / scores.length;
        dump.push(`\n## ${name} — ${dir}\n`);
        sub.forEach((p, i) => {
          dump.push(`- src: ${p.src}\n  - hyp: ${hyps[i]}\n  - ref: ${p.ref}\n  - chrF: ${chrF(hyps[i] ?? '', p.ref).toFixed(1)}`);
        });
      } catch (err) {
        means[dir] = null;
        dump.push(`\n## ${name} — ${dir}: FAILED (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    const fmt = (v: number | null): string => (v === null ? '—' : v.toFixed(1));
    rows.push(`| ${name} | ${fmt(means['en-vi'])} | ${fmt(means['vi-en'])} |`);
  }

  const report = `${rows.join('\n')}\n`;
  process.stdout.write(`\n${report}\n`);
  writeFileSync('eval-translation-output.md', `${dump.join('\n')}\n\n${report}`);
  process.stdout.write('Per-sentence dump written to eval-translation-output.md\n');
  process.stdout.write('\nNOTE: chrF on a tiny sample is indicative only. For a decision, use FLORES+/PhoMT + COMET/MetricX, and a human A/B of dub-style lines.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
