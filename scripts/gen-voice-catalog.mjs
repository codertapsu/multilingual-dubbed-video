#!/usr/bin/env node
/**
 * Generate the voice catalog snapshots (packages/node-orchestrator/src/voices/catalog/*.json).
 *
 *   node scripts/gen-voice-catalog.mjs            # all engines
 *   node scripts/gen-voice-catalog.mjs piper      # one engine
 *
 * Every source is read at a PINNED revision (SOURCES below), never a branch, and
 * every file a voice downloads carries its sha256 and size: the app verifies
 * both before a voice counts as installed. The snapshots are committed and
 * reviewed like code, so the library renders instantly and offline; only the
 * voices themselves (and their previews) download, on demand. Bumping a source
 * = change its revision here, re-run, review the diff (licences especially).
 *
 * Previews that upstream does not host (VieNeu, Kokoro, Supertonic) are
 * rendered by scripts/render-voice-previews.mjs and published as assets of a
 * GitHub release; their manifest (scripts/voice-previews.json) is merged in
 * here when it exists.
 *
 * Platform-neutral Node (no twins needed): it only fetches and writes JSON.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'packages/node-orchestrator/src/voices/catalog');
const PREVIEWS_MANIFEST = path.join(ROOT, 'scripts/voice-previews.json');
const LICENSE_OVERRIDES = path.join(ROOT, 'scripts/voice-license-overrides.json');

/** Pinned upstream revisions. */
const SOURCES = {
  piper: { repo: 'rhasspy/piper-voices', revision: '0ca208afc2a2ee102b1e961e72e0a7e4907be3d0' },
  vieneuClassic: { repo: 'pnnbao97/VieNeu-TTS', revision: 'cfb28b25735ccb7d2fa49a3ea144914302495b40', tag: 'v3.0.5' },
  vieneu: { repo: 'pnnbao97/VieNeu-TTS', revision: '22dd2ef2a89bba24a77da6dbc84c75f7f4fda05b', tag: 'v3.8.4' },
  vieneuModel: { repo: 'pnnbao-ump/VieNeu-TTS-v3-Turbo', revision: '61b85e3d937fbbacb387714180e8182823512523' },
  zerotts: { repo: 'zeroweight-ai/ZeroTTS', revision: '18d6681518a4becaed3c125ceb3c7db59905fe86' },
  kokoro: { repo: 'onnx-community/Kokoro-82M-v1.0-ONNX', revision: '1939ad2a8e416c0acfeecc08a694d14ef25f2231' },
  kokoroCard: { repo: 'hexgrad/Kokoro-82M', revision: 'f3ff3571791e39611d31c381e3a41a3af07b4987' },
  supertonic: { repo: 'supertone-oss-archive/supertonic-3', revision: 'aafc6e32416a594460b32413efc49d7fe4ce6d46' },
};

const UA = { 'User-Agent': 'videodubber-voice-catalog/1 (+https://github.com/codertapsu/multilingual-dubbed-video)' };

// eslint.config.mjs lists the Node globals plain .mjs files may use, and fetch
// and AbortSignal are not among them (see release-status.mjs): reach them
// through globalThis.
const httpFetch = globalThis.fetch;
const timeoutSignal = (ms) => globalThis.AbortSignal.timeout(ms);

// ---------------------------------------------------------------- fetching

async function fetchWithRetry(url, init = {}, attempts = 4) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await httpFetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: timeoutSignal(60_000) });
      if (res.ok) return res;
      last = new Error(`HTTP ${res.status} for ${url}`);
      if (res.status === 404) throw last;
    } catch (err) {
      last = err;
      if (String(err).includes('HTTP 404')) throw err;
    }
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
  throw last;
}

const fetchJson = async (url) => (await fetchWithRetry(url)).json();
const fetchText = async (url) => (await fetchWithRetry(url)).text();
const fetchBuffer = async (url) => Buffer.from(await (await fetchWithRetry(url)).arrayBuffer());

/** Map with at most `n` promises in flight. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    }),
  );
  return out;
}

const hfResolve = (repo, revision, file) => `https://huggingface.co/${repo}/resolve/${revision}/${file.split('/').map(encodeURIComponent).join('/')}`;
const ghRaw = (repo, revision, file) => `https://raw.githubusercontent.com/${repo}/${revision}/${file}`;

/** Every file of a Hugging Face repo at a revision (follows the API's paging). */
async function hfTree(repo, revision) {
  const files = new Map();
  let url = `https://huggingface.co/api/models/${repo}/tree/${revision}?recursive=true`;
  while (url) {
    const res = await fetchWithRetry(url);
    for (const e of await res.json()) {
      if (e.type === 'file') files.set(e.path, { size: e.size, sha256: e.lfs?.oid });
    }
    const link = res.headers.get('link') ?? '';
    url = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
  }
  return files;
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** A pinned file entry; small non-LFS files are downloaded once to hash them. */
async function pinnedFile(repo, revision, tree, file, destPath) {
  const meta = tree.get(file);
  if (!meta) throw new Error(`${repo}@${revision.slice(0, 8)} has no ${file}`);
  const url = hfResolve(repo, revision, file);
  if (meta.sha256) return { url, sha256: meta.sha256, bytes: meta.size, destPath };
  const buf = await fetchBuffer(url);
  return { url, sha256: sha256(buf), bytes: buf.length, destPath };
}

// ---------------------------------------------------------------- helpers

/** "Hải Đăng" -> "hai-dang". */
function slug(name) {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

const mb = (bytes) => Math.round((bytes / 1e6) * 10) / 10;

/**
 * Read a Piper MODEL_CARD's dataset licence line into a category + label.
 * Cards follow one template ("* License: CC BY 4.0" under "## Dataset"); the
 * long tail ("See URL", "Unknown", custom text) lands in `unknown` with the
 * card as its source, and scripts/voice-license-overrides.json settles those
 * by hand once read.
 */
export function classifyPiperLicense(card) {
  const line = /^\s*\*?\s*License:\s*(.+)$/im.exec(card)?.[1]?.trim() ?? '';
  const text = line || card;
  const norm = text.replace(/[_-]/g, ' ');
  const has = (re) => re.test(norm);
  const version = /(\d\.\d)/.exec(text)?.[1];
  const v = version ? ` ${version}` : '';
  // Creative Commons licences are written both as codes and spelled out.
  const ccNc = /\bCC\s*BY\s*NC\b|Attribution\s*Non\s*Commercial/i;
  const ccSa = /\bCC\s*BY\s*SA\b|Attribution\s*Share\s*Alike/i;
  const ccNd = /\bND\b|No\s*Derivatives/i;
  const ccBy = /\bCC\s*BY\b|Creative\s*Commons\s*Attribution/i;
  if (has(ccNc)) return { category: 'non-commercial', label: `CC BY-NC${has(ccSa) || /\bSA\b/i.test(norm) ? '-SA' : has(ccNd) ? '-ND' : ''}${v}` };
  if (has(/non\s*commercial|research (only|purposes?)|academic use/i)) return { category: 'non-commercial', label: 'Non-commercial' };
  if (has(/\bCC\s*0\b|\bCC0\b|public\s*domain/i)) return { category: 'permissive', label: /public\s*domain/i.test(norm) ? 'Public domain' : 'CC0' };
  if (has(/unlicense/i)) return { category: 'permissive', label: 'Unlicense' };
  if (has(ccSa)) return { category: 'attribution', label: `CC BY-SA${v}` };
  if (has(ccBy)) return { category: 'attribution', label: `CC BY${v}` };
  if (has(/\bMIT\b/i)) return { category: 'permissive', label: 'MIT' };
  if (has(/\bApache\b/i)) return { category: 'permissive', label: 'Apache-2.0' };
  if (has(/\bBSD\b/i)) return { category: 'permissive', label: 'BSD' };
  if (has(/\bRAIL\b/i)) return { category: 'use-restricted', label: line.length <= 40 ? line : 'Open RAIL' };
  if (has(/A?L?GPL/)) return { category: 'attribution', label: /AGPL/i.test(norm) ? 'AGPL-3.0' : /LGPL/i.test(norm) ? 'LGPL' : `GPL${v}` };
  // "See URL", "See LICENSE file", "Unknown": the card points elsewhere. The
  // override file settles those a person has read; until then: not stated.
  return { category: 'unknown', label: /^see\b/i.test(line) ? 'See source' : 'Not stated' };
}

function readJsonIfExists(file) {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

const previews = readJsonIfExists(PREVIEWS_MANIFEST);
const licenseOverrides = readJsonIfExists(LICENSE_OVERRIDES);

function withPreview(voice) {
  const p = previews[voice.id];
  return p ? { ...voice, preview: p } : voice;
}

// ---------------------------------------------------------------- engines

/**
 * The curated per-language defaults (PIPER_VOICES in
 * packages/node-orchestrator/src/setup/catalog.ts; a test keeps them equal).
 */
const PIPER_RECOMMENDED = new Set([
  'vi_VN-vais1000-medium',
  'en_US-lessac-medium',
  'en_GB-alan-medium',
  'es_ES-davefx-medium',
  'fr_FR-siwis-medium',
  'de_DE-thorsten-medium',
  'zh_CN-huayan-medium',
]);

async function genPiper() {
  const { repo, revision } = SOURCES.piper;
  console.log(`piper: ${repo}@${revision.slice(0, 8)} …`);
  const [index, tree] = await Promise.all([fetchJson(hfResolve(repo, revision, 'voices.json')), hfTree(repo, revision)]);
  const ids = Object.keys(index).sort();
  const voices = await mapLimit(ids, 8, async (id) => {
    const v = index[id];
    const files = Object.keys(v.files);
    const onnx = files.find((f) => f.endsWith('.onnx'));
    const config = files.find((f) => f.endsWith('.onnx.json'));
    const dir = path.posix.dirname(onnx);
    const configUrl = hfResolve(repo, revision, config);
    const [onnxFile, configBuf, card] = await Promise.all([
      pinnedFile(repo, revision, tree, onnx, `${id}.onnx`),
      fetchBuffer(configUrl),
      fetchText(hfResolve(repo, revision, `${dir}/MODEL_CARD`)).catch(() => ''),
    ]);
    const configFile = { url: configUrl, sha256: sha256(configBuf), bytes: configBuf.length, destPath: `${id}.onnx.json` };
    const configJson = JSON.parse(configBuf.toString('utf8'));
    const datasetUrl = /URL:\s*(\S+)/i.exec(card)?.[1];
    const license = {
      ...classifyPiperLicense(card),
      sourceUrl: hfResolve(repo, revision, `${dir}/MODEL_CARD`).replace('/resolve/', '/blob/'),
      ...(datasetUrl ? { attribution: `${v.dataset} — ${datasetUrl}` } : { attribution: v.dataset }),
      ...(licenseOverrides[id] ?? {}),
    };
    const speakers =
      v.num_speakers > 1
        ? Object.entries(v.speaker_id_map ?? {})
            .map(([name, index]) => ({ index, name }))
            .sort((a, b) => a.index - b.index)
        : undefined;
    const samplePath = `${dir}/samples/speaker_0.mp3`;
    const sample = tree.get(samplePath);
    return {
      id,
      engine: 'piper',
      name: v.name,
      languages: [v.language.code.replace('_', '-')],
      sampleRate: configJson.audio?.sample_rate ?? 22050,
      quality: v.quality,
      ...(PIPER_RECOMMENDED.has(id) ? { recommended: true } : {}),
      ...(speakers ? { speakers } : {}),
      license,
      files: [onnxFile, configFile],
      sizeMb: mb(onnxFile.bytes + configFile.bytes),
      ...(sample?.sha256
        ? { preview: { url: hfResolve(repo, revision, samplePath), sha256: sample.sha256, bytes: sample.size } }
        : {}),
    };
  });
  return { engine: 'piper', sources: [SOURCES.piper], voices };
}

const VIENEU_STYLE = { tu_nhien: 'natural', doc_truyen: 'storytelling', tin_tuc: 'news' };
const VIENEU_REGION = { Bắc: 'north', Trung: 'central', Nam: 'south' };
const VIENEU_GENDER = { nữ: 'female', nam: 'male', female: 'female', male: 'male' };
const VIENEU_LICENSE = {
  category: 'permissive',
  label: 'Apache-2.0',
  sourceUrl: `https://huggingface.co/${SOURCES.vieneuModel.repo}`,
  attribution: 'VieNeu-TTS by pnnbao-ump; speakers consented (model card)',
};

/** The ids the app has shipped since 0.9: never change them. */
const CLASSIC_IDS = {
  'Ngọc Lan': 'vieneu-v3-ngoc-lan',
  'Ngọc Linh': 'vieneu-v3-ngoc-linh',
  'Trúc Ly': 'vieneu-v3-truc-ly',
  'Mỹ Duyên': 'vieneu-v3-my-duyen',
  'Xuân Vĩnh': 'vieneu-v3-xuan-vinh',
  'Thái Sơn': 'vieneu-v3-thai-son',
  'Gia Bảo': 'vieneu-v3-gia-bao',
  'Đức Trí': 'vieneu-v3-duc-tri',
  'Trọng Hữu': 'vieneu-v3-trong-huu',
  'Bình An': 'vieneu-v3-binh-an',
};

async function genVieneuClassic() {
  const { repo, revision } = SOURCES.vieneuClassic;
  console.log(`vieneu-classic: ${repo}@${revision.slice(0, 8)} (${SOURCES.vieneuClassic.tag}) …`);
  const data = await fetchJson(ghRaw(repo, revision, 'src/vieneu/assets/voices_v3_turbo.json'));
  const voices = Object.entries(data.presets).map(([name, p]) => {
    const id = CLASSIC_IDS[name];
    if (!id) throw new Error(`vieneu-classic: no stable id for "${name}"`);
    // "nữ, giọng dịu dàng" -> the part after the gender.
    const trait = String(p.description ?? '').split(',').slice(1).join(',').trim();
    return withPreview({
      id,
      engine: 'vieneu-classic',
      name,
      languages: ['vi-VN'],
      gender: VIENEU_GENDER[p.gender],
      ...(trait ? { tags: [trait] } : {}),
      sampleRate: 48000,
      license: VIENEU_LICENSE,
      files: [],
      sizeMb: 0,
      // The app's own default since 0.9 (vd_tts_engine/voices.py), not the
      // SDK's: a project with no voice set has always spoken as Ngọc Lan.
      ...(id === 'vieneu-v3-ngoc-lan' ? { recommended: true } : {}),
    });
  });
  voices.sort((a, b) => Object.values(CLASSIC_IDS).indexOf(a.id) - Object.values(CLASSIC_IDS).indexOf(b.id));
  return { engine: 'vieneu-classic', sources: [SOURCES.vieneuClassic], voices };
}

async function genVieneu() {
  const { repo, revision } = SOURCES.vieneu;
  console.log(`vieneu: ${repo}@${revision.slice(0, 8)} (${SOURCES.vieneu.tag}) …`);
  const data = await fetchJson(ghRaw(repo, revision, 'src/vieneu/assets/voices_v3_turbo.json'));
  const voices = Object.entries(data.presets).map(([name, p]) => {
    const tags = [VIENEU_STYLE[p.style] ?? p.style].filter(Boolean);
    if (p.featured) tags.push('featured');
    return withPreview({
      id: `vieneu38-${slug(name)}`,
      engine: 'vieneu',
      name,
      languages: ['vi-VN'],
      gender: VIENEU_GENDER[p.gender],
      ...(VIENEU_REGION[p.region] ? { accent: VIENEU_REGION[p.region] } : {}),
      tags,
      sampleRate: 48000,
      license: VIENEU_LICENSE,
      files: [],
      sizeMb: 0,
      ...(name === data.default_voice ? { recommended: true } : {}),
      _featured: p.featured ?? 99,
    });
  });
  voices.sort((a, b) => a._featured - b._featured || a.name.localeCompare(b.name, 'vi'));
  for (const v of voices) delete v._featured;
  return { engine: 'vieneu', sources: [SOURCES.vieneu, SOURCES.vieneuModel], voices };
}

const ZEROTTS_GENDER = { nữ: 'female', nam: 'male' };

async function genZerotts() {
  const { repo, revision } = SOURCES.zerotts;
  console.log(`zerotts: ${repo}@${revision.slice(0, 8)} …`);
  const [index, tree] = await Promise.all([fetchJson(hfResolve(repo, revision, 'voices/index.json')), hfTree(repo, revision)]);
  const voices = await mapLimit(index.voices, 4, async (v) => {
    const previewPath = `voices/${v.name}/preview.wav`;
    const sample = tree.get(previewPath);
    const tags = (v.tags ?? []).filter((t) => !ZEROTTS_GENDER[t]);
    return {
      id: `zerotts-${v.name}`,
      engine: 'zerotts',
      name: v.display_name,
      languages: ['vi-VN'],
      gender: ZEROTTS_GENDER[v.gender],
      tags,
      sampleRate: 48000,
      license: {
        category: 'permissive',
        label: 'MIT',
        sourceUrl: `https://huggingface.co/${repo}`,
        attribution: 'ZeroTTS by zeroweight.ai — "the shipped voices are for evaluation and demos"',
      },
      // The engine pack downloads every preset with the model; a voice needs nothing more.
      files: [],
      sizeMb: 0,
      ...(v.name === 'maichi' ? { recommended: true } : {}),
      ...(sample?.sha256
        ? { preview: { url: hfResolve(repo, revision, previewPath), sha256: sample.sha256, bytes: sample.size } }
        : {}),
    };
  });
  return { engine: 'zerotts', sources: [SOURCES.zerotts], voices };
}

const KOKORO_LANG = { a: 'en-US', b: 'en-GB', j: 'ja-JP', z: 'zh-CN', e: 'es-ES', f: 'fr-FR', h: 'hi-IN', i: 'it-IT', p: 'pt-BR' };

async function genKokoro() {
  const { repo, revision } = SOURCES.kokoro;
  console.log(`kokoro: ${repo}@${revision.slice(0, 8)} …`);
  const [tree, voicesMd] = await Promise.all([
    hfTree(repo, revision),
    fetchText(hfResolve(SOURCES.kokoroCard.repo, SOURCES.kokoroCard.revision, 'VOICES.md')),
  ]);
  // VOICES.md rows: | **af\_heart** | 🚺❤️ | | | **A** | `0ab5709b` | [CC BY source] |
  // The overall grade is the cell right before the hash; Spanish and
  // Portuguese rows carry no grade at all. A trailing link names a dataset
  // that is CC BY, which the voice inherits.
  const grade = new Map();
  const ccBy = new Map();
  for (const line of voicesMd.split('\n')) {
    const cells = line.split('|').slice(1, -1).map((c) => c.replace(/[*\\]/g, '').trim());
    if (!/^[a-z]{2}_[a-z]+$/.test(cells[0] ?? '')) continue;
    const hashAt = cells.findIndex((c) => /^`[0-9a-f]{8}`$/.test(c));
    const g = hashAt > 0 ? cells[hashAt - 1] : '';
    if (/^[A-F][+-]?$/.test(g)) grade.set(cells[0], g);
    const link = /\[([^\]]+)\]\((https?:[^)]+)\)/.exec(cells[hashAt + 1] ?? '');
    if (link) ccBy.set(cells[0], `${link[1]} — ${link[2]}`);
  }
  const files = [...tree.keys()].filter((f) => /^voices\/[a-z]{2}_[a-z]+\.bin$/.test(f)).sort();
  const voices = files.map((f) => {
    const code = path.posix.basename(f, '.bin');
    const lang = KOKORO_LANG[code[0]];
    const g = grade.get(code);
    const name = code.slice(3).replace(/^./, (c) => c.toUpperCase());
    return withPreview({
      id: `kokoro-${code}`,
      engine: 'kokoro',
      name,
      languages: [lang],
      gender: code[1] === 'f' ? 'female' : 'male',
      tags: g ? [`grade:${g}`] : [],
      sampleRate: 24000,
      license: ccBy.has(code)
        ? {
            category: 'attribution',
            label: 'Apache-2.0 + CC BY data',
            sourceUrl: `https://huggingface.co/${SOURCES.kokoroCard.repo}/blob/${SOURCES.kokoroCard.revision}/VOICES.md`,
            attribution: `Kokoro-82M by hexgrad; trained on ${ccBy.get(code)}`,
          }
        : {
            category: 'permissive',
            label: 'Apache-2.0',
            sourceUrl: `https://huggingface.co/${SOURCES.kokoroCard.repo}`,
            attribution: 'Kokoro-82M by hexgrad',
          },
      files: [],
      sizeMb: 0,
    });
  });
  // The best-graded voice of each locale is its recommended one.
  const rank = (g) => 'ABCDEF'.indexOf(g?.[0] ?? 'F') * 3 + (g?.[1] === '+' ? 0 : g?.[1] === '-' ? 2 : 1);
  for (const lang of new Set(voices.map((v) => v.languages[0]))) {
    const best = voices
      .filter((v) => v.languages[0] === lang)
      .sort((a, b) => rank(grade.get(a.id.slice('kokoro-'.length))) - rank(grade.get(b.id.slice('kokoro-'.length))))[0];
    if (best) best.recommended = true;
  }
  return { engine: 'kokoro', sources: [SOURCES.kokoro, SOURCES.kokoroCard], voices };
}

async function genSupertonic() {
  const { repo, revision } = SOURCES.supertonic;
  console.log(`supertonic: ${repo}@${revision.slice(0, 8)} …`);
  const [tree, readme] = await Promise.all([hfTree(repo, revision), fetchText(hfResolve(repo, revision, 'README.md'))]);
  // The model card's YAML header lists the 31 language codes.
  const header = /^---\n([\s\S]*?)\n---/.exec(readme)?.[1] ?? '';
  const langBlock = /language:\s*\n((?:\s+-\s*[a-z]{2,3}\s*\n)+)/.exec(header)?.[1] ?? '';
  const languages = [...langBlock.matchAll(/-\s*([a-z]{2,3})/g)].map((m) => m[1]);
  if (languages.length < 20) throw new Error(`supertonic: read only ${languages.length} languages from the card`);
  const styles = [...tree.keys()].filter((f) => /^voice_styles\/[FM]\d+\.json$/.test(f)).sort();
  const voices = styles.map((f) => {
    const style = path.posix.basename(f, '.json');
    return withPreview({
      id: `supertonic-${style.toLowerCase()}`,
      engine: 'supertonic',
      name: style,
      languages,
      gender: style.startsWith('F') ? 'female' : 'male',
      sampleRate: 44100,
      license: {
        category: 'use-restricted',
        label: 'OpenRAIL-M',
        sourceUrl: `https://huggingface.co/${repo}/blob/${revision}/LICENSE`,
        attribution: 'Supertonic 3 by Supertone (archived); use restrictions apply, incl. disclosing machine-generated speech',
      },
      files: [],
      sizeMb: 0,
      ...(style === 'F1' || style === 'M1' ? { recommended: true } : {}),
    });
  });
  return { engine: 'supertonic', sources: [SOURCES.supertonic], voices, languages };
}

/** OpenAI's built-in voices (cloud, opt-in with a key); multilingual. */
function genOpenai() {
  const names = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
  const voices = names.map((n) => ({
    id: `openai-${n}`,
    engine: 'openai',
    name: n.replace(/^./, (c) => c.toUpperCase()),
    languages: ['*'],
    sampleRate: 24000,
    license: {
      category: 'service-terms',
      label: 'OpenAI terms',
      sourceUrl: 'https://openai.com/policies/usage-policies',
    },
    files: [],
    sizeMb: 0,
    ...(n === 'alloy' ? { recommended: true } : {}),
  }));
  return { engine: 'openai', sources: [], voices };
}

const GENERATORS = {
  piper: genPiper,
  'vieneu-classic': genVieneuClassic,
  vieneu: genVieneu,
  zerotts: genZerotts,
  kokoro: genKokoro,
  supertonic: genSupertonic,
  openai: genOpenai,
};

async function main() {
  const wanted = process.argv.slice(2);
  const engines = wanted.length ? wanted : Object.keys(GENERATORS);
  mkdirSync(OUT_DIR, { recursive: true });
  for (const engine of engines) {
    const gen = GENERATORS[engine];
    if (!gen) throw new Error(`unknown engine "${engine}" (one of ${Object.keys(GENERATORS).join(', ')})`);
    const catalog = await gen();
    const out = {
      engine: catalog.engine,
      generatedAt: new Date().toISOString(),
      sources: catalog.sources,
      ...(catalog.languages ? { languages: catalog.languages } : {}),
      voices: catalog.voices,
    };
    const file = path.join(OUT_DIR, `${engine}.json`);
    writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
    const counts = catalog.voices.reduce((acc, v) => ((acc[v.license.category] = (acc[v.license.category] ?? 0) + 1), acc), {});
    console.log(`  ${catalog.voices.length} voices -> ${path.relative(ROOT, file)}  ${JSON.stringify(counts)}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
