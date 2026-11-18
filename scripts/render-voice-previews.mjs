#!/usr/bin/env node
/**
 * Render the voice previews upstream does not host (VieNeu 3.8, Kokoro,
 * Supertonic) and write their manifest.
 *
 * Each voice says a short greeting in its own language (in Vietnamese when it
 * speaks it: the app's audience is Vietnamese first), through a running
 * orchestrator with the engines installed (POST /voices/:id/speak), as a 64
 * kbps mono MP3 of about 30 KB. The files are published as assets of a GitHub
 * release that is NEVER marked Latest (the updater follows Latest), and
 * scripts/voice-previews.json maps each voice to its asset's URL, size and
 * sha256, which gen-voice-catalog.mjs merges into the catalogs. The app
 * downloads a preview only when the user plays it, and checks size and digest.
 *
 *   node scripts/render-voice-previews.mjs --orchestrator http://127.0.0.1:5291 \
 *        --release voice-previews-1 [--out <dir>] [--engines vieneu,kokoro,supertonic]
 *        [--match <id regex>] [--force]
 *   (--out defaults to <tmp>/vd-voice-previews, outside the repo.)
 *   gh release create voice-previews-1 --prerelease --latest=false \
 *        --title "Voice previews" --notes "<what they are>" <dir>/*.mp3
 *   node scripts/gen-voice-catalog.mjs && node scripts/check-voice-catalog.mjs
 *
 * Platform-neutral Node (no twins): fetch + ffmpeg (argv, on PATH).
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_DIR = path.join(ROOT, 'packages/node-orchestrator/src/voices/catalog');
const MANIFEST = path.join(ROOT, 'scripts/voice-previews.json');

/** What each voice says, by language (base subtag). */
const GREETINGS = {
  vi: 'Xin chào! Đây là giọng đọc của tôi. Mong bạn sẽ thích cách tôi kể câu chuyện này.',
  en: 'Hello! This is my voice. I hope you enjoy the way I tell this story.',
  ja: 'こんにちは。これは私の声です。この物語を楽しんでいただけたら嬉しいです。',
  zh: '你好！这是我的声音。希望你喜欢我讲这个故事的方式。',
  es: '¡Hola! Esta es mi voz. Espero que te guste cómo cuento esta historia.',
  fr: "Bonjour ! Voici ma voix. J'espère que vous aimerez ma façon de raconter cette histoire.",
  hi: 'नमस्ते! यह मेरी आवाज़ है। मुझे उम्मीद है कि आपको मेरी कहानी सुनाने का तरीका पसंद आएगा।',
  it: 'Ciao! Questa è la mia voce. Spero che ti piaccia il modo in cui racconto questa storia.',
  pt: 'Olá! Esta é a minha voz. Espero que goste da forma como conto esta história.',
  ko: '안녕하세요! 이것은 제 목소리입니다. 제가 들려드리는 이야기가 마음에 드시길 바랍니다.',
};

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** owner/repo of the origin remote. */
function originRepo() {
  const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
  if (!m) throw new Error(`cannot read owner/repo from ${url}`);
  return m[1];
}

const base = arg('orchestrator', 'http://127.0.0.1:5291').replace(/\/$/, '');
const outDir = path.resolve(arg('out', path.join(os.tmpdir(), 'vd-voice-previews')));
const tag = arg('release');
const engines = arg('engines', 'vieneu,kokoro,supertonic').split(',');
const force = process.argv.includes('--force');
/** Only voice ids matching this (e.g. "^kokoro-[jz]" to redo Japanese and Chinese). */
const match = new RegExp(arg('match', ''));
if (!tag) {
  console.error('--release <tag> is required (the GitHub release the files will be published in)');
  process.exit(2);
}
const repo = arg('repo', originRepo());
mkdirSync(outDir, { recursive: true });
const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {};

let made = 0;
for (const engine of engines) {
  const file = path.join(CATALOG_DIR, `${engine}.json`);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const voices = Array.isArray(raw) ? raw : raw.voices;
  for (const v of voices) {
    if (!match.test(v.id)) continue;
    if (!force && (v.preview || manifest[v.id])) continue;
    const tags = (v.languages ?? []).map(String);
    const baseOf = (tag) => tag.split(/[-_]/)[0];
    const lang = tags.some((t) => baseOf(t) === 'vi') ? 'vi' : tags.map(baseOf).find((l) => GREETINGS[l]);
    if (!lang) {
      console.warn(`skip ${v.id}: no greeting for ${tags.join(',')}`);
      continue;
    }
    // The voice's own tag (en-GB, not en): Kokoro picks its accent from it.
    const language = tags.find((t) => baseOf(t) === lang) ?? lang;
    // Through globalThis: eslint.config.mjs does not list fetch/AbortSignal
    // as globals for plain .mjs files (as in gen-voice-catalog.mjs).
    const res = await globalThis.fetch(`${base}/voices/${encodeURIComponent(v.id)}/speak`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: GREETINGS[lang], language }),
      signal: globalThis.AbortSignal.timeout(15 * 60_000),
    });
    if (!res.ok) {
      console.warn(`skip ${v.id}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      continue;
    }
    const name = `${v.id.replace(/[^\w.-]/g, '_')}.mp3`;
    const wav = path.join(outDir, `${name}.wav`);
    writeFileSync(wav, Buffer.from(await res.arrayBuffer()));
    const mp3 = path.join(outDir, name);
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', wav, '-ac', '1', '-ar', '24000', '-c:a', 'libmp3lame', '-b:a', '64k', mp3]);
    rmSync(wav, { force: true });
    const bytes = readFileSync(mp3);
    manifest[v.id] = {
      url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    };
    made++;
    console.log(`${v.id} (${lang}): ${bytes.length} bytes`);
  }
}
const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(MANIFEST, `${JSON.stringify(sorted, null, 1)}\n`);
console.log(`${made} preview(s) rendered into ${outDir}; manifest: ${path.relative(ROOT, MANIFEST)}`);
