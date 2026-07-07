// core/src/retry.ts
//
// Pure retry helpers factored out of `AgentKV#fetchWithRetry` / `AgentKV#retryDelay`.
// The original methods only ever read `this.maxRetries` (a plain number) and called
// `this.retryDelay` — no other instance state — so they extract cleanly into pure
// functions parameterized by `maxRetries`. `AgentKV` now delegates to these via thin
// private wrappers so every existing call site (`this.fetchWithRetry(...)`) is unchanged.

import { AgentXError } from "./errors";

/** Default per-attempt request timeout (ms). A hung-open connection would otherwise wedge an op forever. */
export const DEFAULT_TIMEOUT_MS = 30_000;

/** Tuning knobs for {@link fetchWithRetry}. All optional; sensible defaults. */
export interface RetryOptions {
  /** Per-ATTEMPT timeout in ms (via `AbortSignal.timeout`). Default 30_000. Pass 0 to disable. */
  timeoutMs?: number;
  /** Injectable `fetch` for proxies / instrumentation / tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Caller `AbortSignal` to cancel the whole operation (abort is surfaced immediately, never retried). */
  signal?: AbortSignal;
}

/** Combine 0+ AbortSignals into one that aborts when any input does. Undefined if none supplied. */
function combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => !!s);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  // AbortSignal.any is Node >=20.3 / modern browsers; fall back to a manual combiner for Node 20.0–20.2.
  if (typeof AbortSignal.any === "function") return AbortSignal.any(present);
  const ctrl = new AbortController();
  for (const s of present) {
    if (s.aborted) {
      ctrl.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}

/** Release a transient response's body so its socket returns to the pool before we retry. */
async function drainBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // best-effort — a body that can't be cancelled is not worth failing the retry over.
  }
}

/**
 * Issue a request with bounded retry on TRANSIENT failures only: a thrown
 * fetch (network error / lost response / per-attempt timeout) or a 5xx/429
 * response. `build()` is re-invoked per attempt so a caller can re-sign
 * per-attempt state (e.g. a fresh identity nonce) while a stable Idempotency-Key
 * (and pinned EIP-3009 nonce on paid ops) makes a retry of an already-processed
 * request dedupe server-side — so a lost response that the server already charged
 * is recovered without a second charge. NOT retried: any 2xx/4xx (incl. a 402
 * credit->pay handoff, 401, 404) — returned as-is; and a caller-initiated abort,
 * which is surfaced immediately. Honors `Retry-After` (delta-seconds or HTTP-date).
 * Each attempt is bounded by `opts.timeoutMs` (default 30s).
 */
export async function fetchWithRetry(
  url: string,
  build: () => RequestInit | Promise<RequestInit>,
  maxRetries: number,
  opts: RetryOptions = {},
): Promise<Response> {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      const init = await build();
      const timeoutSignal = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
      const signal = combineSignals([init.signal ?? undefined, opts.signal, timeoutSignal]);
      const res = await doFetch(url, { ...init, signal });
      // Retry TRANSIENT statuses: 5xx, and 429 (rate limited).
      const transient = (res.status >= 500 && res.status <= 599) || res.status === 429;
      if (transient && attempt < maxRetries) {
        await drainBody(res);
        await retryDelay(attempt, res);
        continue;
      }
      return res;
    } catch (err) {
      // A caller-initiated cancel is intentional, not transient — surface it immediately.
      if (opts.signal?.aborted) {
        throw err instanceof Error ? err : new AgentXError(String(err), "aborted", 0);
      }
      if (attempt < maxRetries) {
        await retryDelay(attempt);
        continue;
      }
      throw err instanceof Error ? err : new AgentXError(String(err), "network_error", 0);
    }
  }
}

/**
 * Short, bounded backoff between retries. Base is 50ms, 100ms, ... capped at 500ms, with
 * full jitter (each delay uniformly in [50%, 100%] of the base) to avoid a synchronized
 * retry herd under a 5xx/429 storm. If the response carries a `Retry-After` — delta-seconds
 * OR an HTTP-date — honor it up to a 2s cap so a re-sent paid authorization still stays
 * comfortably within its validBefore window (jitter is skipped when the server dictates a delay).
 */
export function retryDelay(attempt: number, res?: Response): Promise<void> {
  const base = Math.min(500, 50 * 2 ** attempt);
  let ms = Math.round(base * (0.5 + Math.random() * 0.5));
  const retryAfter = res?.headers.get("Retry-After");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      ms = Math.min(2000, secs * 1000); // delta-seconds form
    } else {
      const when = Date.parse(retryAfter); // HTTP-date form
      if (Number.isFinite(when)) ms = Math.min(2000, Math.max(0, when - Date.now()));
    }
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
