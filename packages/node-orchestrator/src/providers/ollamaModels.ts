/**
 * Lazy on-demand management of Ollama models.
 *
 * Ollama models are large and optional, so the app doesn't bundle them — the
 * user pulls one when they're ready. This module lists pulled models and runs a
 * background pull whose progress the UI polls, so a "model-missing" readiness
 * verdict can offer a one-click "Pull <model>" instead of a guide.
 *
 * The daemon is the source of truth: we never persist a model list. The OpenAI-
 * compatible base URL (`.../v1`) lists models; the native API (`.../api/pull`)
 * does the streaming pull.
 */

/** Parse the OpenAI-compatible `/v1/models` body into a list of model ids. */
export function parseOllamaModelList(body: unknown): string[] {
  const data = (body as { data?: { id?: unknown }[] } | undefined)?.data;
  if (!Array.isArray(data)) return [];
  return data.map((m) => m?.id).filter((x): x is string => typeof x === 'string');
}

/** List the models currently pulled into the Ollama daemon (empty if down). */
export async function listOllamaModels(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/models`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    return parseOllamaModelList(await res.json().catch(() => ({})));
  } catch {
    return [];
  }
}

/** State of an in-flight (or finished) model pull. */
export interface PullState {
  status: 'idle' | 'pulling' | 'done' | 'error';
  percent: number;
  detail?: string;
  error?: string;
}

/** Native pull API base (`.../v1` -> host root). */
function nativeBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1\/?$/, '').replace(/\/$/, '');
}

/**
 * Runs and tracks background Ollama model pulls. `start()` kicks off a pull and
 * returns immediately; `status()` is polled by the UI until `done`/`error`.
 * Idempotent: starting a model that's already pulling is a no-op.
 */
export class OllamaPullManager {
  private readonly state = new Map<string, PullState>();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  status(model: string): PullState {
    return this.state.get(model) ?? { status: 'idle', percent: 0 };
  }

  /** Begin pulling `model` in the background (no-op if already pulling). */
  start(model: string): PullState {
    const current = this.state.get(model);
    if (current?.status === 'pulling') return current;
    const started: PullState = { status: 'pulling', percent: 0 };
    this.state.set(model, started);
    void this.run(model);
    return started;
  }

  /** Await the active pull for a model (for tests / synchronous callers). */
  async wait(model: string): Promise<PullState> {
    const inflight = this.inflight.get(model);
    if (inflight) await inflight;
    return this.status(model);
  }

  private readonly inflight = new Map<string, Promise<void>>();

  private run(model: string): Promise<void> {
    const task = this.pull(model).catch((err: unknown) => {
      this.state.set(model, {
        status: 'error',
        percent: this.status(model).percent,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.inflight.set(model, task);
    return task;
  }

  private async pull(model: string): Promise<void> {
    const res = await this.fetchImpl(`${nativeBase(this.baseUrl)}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
    });
    if (!res.ok || !res.body) {
      this.state.set(model, { status: 'error', percent: 0, error: `Ollama pull failed (HTTP ${res.status}).` });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) this.applyLine(model, line);
      }
    }
    if (buf.trim()) this.applyLine(model, buf.trim());

    if (this.status(model).status !== 'error') {
      this.state.set(model, { status: 'done', percent: 100, detail: 'success' });
    }
  }

  /** Apply one NDJSON progress line from the native pull stream. */
  private applyLine(model: string, line: string): void {
    let ev: { status?: string; completed?: number; total?: number; error?: string };
    try {
      ev = JSON.parse(line);
    } catch {
      return; // ignore a partial/garbage line
    }
    if (ev.error) {
      this.state.set(model, { status: 'error', percent: this.status(model).percent, error: ev.error });
      return;
    }
    const prev = this.status(model);
    const percent = typeof ev.total === 'number' && ev.total > 0 ? Math.round(((ev.completed ?? 0) / ev.total) * 100) : prev.percent;
    this.state.set(model, { status: 'pulling', percent, detail: ev.status ?? prev.detail });
  }
}
