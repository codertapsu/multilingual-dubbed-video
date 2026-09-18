import type { PreflightResult, SystemProfileResponse } from '../models/setup';
import type { EnginesResponse, StorageInfo } from '../models';
import type { WorkersHealth } from '../models/view-models';

/** Everything the Help screen managed to collect; every field is optional
 *  because a diagnostic taken while the backend is DOWN is the most valuable
 *  one there is, and it must not fail to render for want of a section. */
export interface DiagnosticsInput {
  appVersion: string | null;
  inTauri: boolean;
  locale: string;
  userAgent: string;
  system: SystemProfileResponse | null;
  workers: WorkersHealth | null;
  preflight: PreflightResult | null;
  engines: EnginesResponse | null;
  storage: StorageInfo | null;
  installedWhisperModels: readonly string[] | null;
  /** Errors the user has seen this session, newest last. */
  recentErrors: readonly string[];
}

/**
 * Home directories, in the three shapes the three platforms produce. Replaced
 * with `~` so a pasted diagnostic does not publish the user's real name — which
 * on Windows is frequently their full legal name.
 */
const HOME_DIR_PATTERNS: readonly RegExp[] = [
  /\/Users\/[^/\s"']+/g,
  /\/home\/[^/\s"']+/g,
  /[A-Za-z]:\\Users\\[^\\\s"']+/g,
];

/**
 * Secrets that must never survive into a pasted bundle.
 *
 * Nothing in the app logs these TODAY. They are stripped anyway because a
 * diagnostics bundle is a new exfiltration surface whose whole purpose is to be
 * pasted into a public issue tracker, and the next person to add a log line
 * will not be thinking about that.
 */
const SECRET_PATTERNS: readonly { re: RegExp; replacement: string }[] = [
  { re: /\bsk-[A-Za-z0-9_-]{8,}/g, replacement: 'sk-REDACTED' },
  { re: /\bSESSDATA=[^;\s]+/gi, replacement: 'SESSDATA=REDACTED' },
  { re: /\bBearer\s+[A-Za-z0-9._-]{8,}/gi, replacement: 'Bearer REDACTED' },
  { re: /\bAuthorization:\s*\S+/gi, replacement: 'Authorization: REDACTED' },
  { re: /\b(api[_-]?key|token)["']?\s*[:=]\s*["']?[A-Za-z0-9._-]{8,}/gi, replacement: '$1=REDACTED' },
];

/**
 * Redact a diagnostics blob: home directories to `~`, then credentials.
 *
 * Order matters — a path rewrite must not be able to re-expose a key by
 * splitting it, so paths go first and secrets last.
 */
export function redactDiagnostics(text: string): string {
  let out = text;
  for (const re of HOME_DIR_PATTERNS) out = out.replace(re, '~');
  for (const { re, replacement } of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

function bulletList(lines: readonly string[]): string {
  return lines.length > 0 ? lines.map((l) => `  - ${l}`).join('\n') : '  (none)';
}

/**
 * Render a support-ready, redacted plain-text diagnostic.
 *
 * WHY plain text and not JSON: it is going to be pasted into a GitHub issue by
 * someone who is already frustrated, and it has to be readable there without a
 * fold. Nothing leaves the machine unless the user pastes it.
 *
 * Pure (no injector, no clock) so the exact output can be asserted.
 */
export function buildDiagnostics(input: DiagnosticsInput, now: Date): string {
  const p = input.system?.profile;
  const sections: string[] = [
    '### VideoDubber diagnostics',
    `Collected: ${now.toISOString()}`,
    `App version: ${input.appVersion ?? 'unknown'} (${input.inTauri ? 'desktop' : 'browser dev'})`,
    `UI language: ${input.locale}`,
    `User agent: ${input.userAgent}`,
    '',
    '#### Machine',
    p
      ? [
          `  OS: ${p.platform} ${p.arch}${p.appleSilicon ? ' (Apple silicon)' : ''}`,
          `  CPU: ${p.cpuModel} (${p.cpuCores} cores)`,
          `  RAM: ${Math.round(p.totalRamMb / 1024)} GB total, ${Math.round(p.freeRamMb / 1024)} GB free`,
          `  GPU: ${p.gpus.length > 0 ? p.gpus.map((g) => `${g.name}${g.driverVersion ? ` (driver ${g.driverVersion})` : ''}`).join(', ') : `none detected (probe: ${p.gpuProbe ?? 'n/a'})`}`,
          `  Recommended model: ${input.system?.recommendation.whisperModel ?? 'n/a'} (tier ${input.system?.recommendation.tier ?? 'n/a'})`,
        ].join('\n')
      : '  (unavailable — the backend did not answer)',
    '',
    '#### Services',
    input.workers
      ? (Object.entries(input.workers) as [string, { available: boolean; detail?: string }][])
          .map(([name, h]) => `  ${h.available ? 'ok  ' : 'DOWN'} ${name}${h.detail ? ` — ${h.detail}` : ''}`)
          .join('\n')
      : '  (unavailable — the backend did not answer)',
    '',
    '#### Self-check',
    input.preflight
      ? bulletList(
          input.preflight.checks.map(
            (c) => `[${c.status}] ${c.label}${c.detail ? ` — ${c.detail}` : ''}`,
          ),
        )
      : '  (not run)',
    '',
    '#### Installed',
    `  Speech models: ${input.installedWhisperModels?.join(', ') || 'none'}`,
    `  Engine packs: ${input.engines?.installed.map((e) => `${e.id}${e.version ? `@${e.version}` : ''}`).join(', ') || 'none'}`,
    input.storage
      ? `  Data root: ${input.storage.root} (${Math.round(input.storage.totalBytes / 1024 / 1024)} MB used, ${input.storage.freeBytes === null ? 'free space unknown' : `${Math.round(input.storage.freeBytes / 1024 / 1024 / 1024)} GB free`})`
      : '  Data root: (unavailable)',
    '',
    '#### Recent errors',
    bulletList(input.recentErrors),
  ];
  return redactDiagnostics(sections.join('\n'));
}
