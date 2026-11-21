#!/usr/bin/env node
/**
 * scripts/check-tauri-commands.mjs — the webview's command arguments must match
 * the Rust commands they call.
 *
 * WHY THIS EXISTS: Tauri matches a command's arguments BY NAME (a Rust
 * parameter `foo_bar` is the key `fooBar`). A key the command does not declare
 * is dropped without a word, and an `Option<>` parameter nobody sent arrives
 * as `None`. `setup_install_models` took `options` while the webview sent
 * `request`, from the first commit of both (2026-06-10) to 0.17.0: in the
 * desktop app every speech-model download posted `{}`, the installer had
 * nothing to do, and Settings' "Download" did nothing however often it was
 * clicked. The browser dev setup goes over HTTP with the right body, so no
 * test and no developer ever saw it.
 *
 * This reads every `#[tauri::command]` signature under apps/desktop/src-tauri/src
 * and every `this.call('<command>', { ... })` / `this.invoke('<command>', { ... })`
 * in apps/desktop/src/app/core/ipc/ipc.service.ts (the one place the webview
 * calls the shell), and fails on:
 *   - a key the command does not declare;
 *   - a required (non-Option) parameter the call does not send;
 *   - a command name with no `#[tauri::command]`.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUST_DIR = join(REPO_ROOT, 'apps', 'desktop', 'src-tauri', 'src');
const IPC_FILE = join(REPO_ROOT, 'apps', 'desktop', 'src', 'app', 'core', 'ipc', 'ipc.service.ts');

const camel = (s) => s.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

/** command name -> [{ key, optional }] */
const commands = new Map();
for (const file of readdirSync(RUST_DIR).filter((f) => f.endsWith('.rs'))) {
  const src = readFileSync(join(RUST_DIR, file), 'utf8');
  const re = /#\[tauri::command\][^\n]*\n(?:\s*#\[[^\n]*\n)*\s*pub(?:\(crate\))?\s+(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/g;
  for (const m of src.matchAll(re)) {
    const params = [];
    for (const raw of m[2].split(',')) {
      const p = raw.trim();
      const colon = p.indexOf(':');
      if (colon < 0) continue;
      const name = p.slice(0, colon).replace(/^mut\s+/, '').trim().replace(/^_+/, '');
      const type = p.slice(colon + 1).trim();
      // Injected by Tauri, never sent by the webview.
      if (/AppHandle|State<|Window|WebviewWindow|tauri::/.test(type)) continue;
      params.push({ key: camel(name), optional: type.startsWith('Option<') });
    }
    commands.set(m[1], params);
  }
}

const ipc = readFileSync(IPC_FILE, 'utf8');
const problems = [];
let calls = 0;
const callRe = /this\.(?:call|invoke)(?:<[^>]*>)?\(\s*'(\w+)'\s*(?:,\s*(\{[^}]*\}|[A-Za-z_]\w*))?/g;
for (const m of ipc.matchAll(callRe)) {
  calls++;
  const [, name, argsText] = m;
  const line = ipc.slice(0, m.index).split('\n').length;
  const params = commands.get(name);
  if (!params) {
    problems.push(`ipc.service.ts:${line}: '${name}' has no #[tauri::command] in src-tauri/src`);
    continue;
  }
  if (argsText === undefined || !argsText.startsWith('{')) continue; // a variable: cannot check statically
  const keys = argsText
    .slice(1, -1)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => part.split(':')[0].trim());
  if (keys.some((k) => k.startsWith('...'))) continue; // a spread: cannot check statically
  const declared = new Set(params.map((p) => p.key));
  for (const k of keys) {
    if (!declared.has(k)) {
      problems.push(
        `ipc.service.ts:${line}: '${name}' is sent "${k}", which the command does not declare ` +
          `(it takes: ${params.map((p) => p.key).join(', ') || 'nothing'}) — Tauri drops it silently`,
      );
    }
  }
  for (const p of params) {
    if (!p.optional && !keys.includes(p.key)) {
      problems.push(`ipc.service.ts:${line}: '${name}' needs "${p.key}", which the call does not send`);
    }
  }
}

if (problems.length > 0) {
  console.error(`check-tauri-commands: ${problems.length} problem(s)`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(`check-tauri-commands: OK - ${calls} call(s) match ${commands.size} command(s).`);
