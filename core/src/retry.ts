// core/src/retry.ts
//
// Pure retry helpers factored out of `AgentKV#fetchWithRetry` / `AgentKV#retryDelay`.
// The original methods only ever read `this.maxRetries` (a plain number) and called
// `this.retryDelay` — no other instance state — so they extract cleanly into pure
// functions parameterized by `maxRetries`. `AgentKV` now delegates to these via thin
// private wrappers so every existing call site (`this.fetchWithRetry(...)`) is unchanged.

import { AgentXError } from "./errors";

/**
 * Issue a request with bounded retry on TRANSIENT failures only: a thrown
 * fetch (network error / lost response) or a 5xx/429 response. `build()` is
 * re-invoked per attempt so a caller can re-sign per-attempt state (e.g. a
 * fresh identity nonce) while a stable Idempotency-Key (and pinned EIP-3009
 * nonce on paid ops) makes a retry of an already-processed request dedupe
 * server-side — so a lost response that the server already charged is
 * recovered without a second charge. NOT retried: any 2xx/4xx (incl. a 402
 * credit->pay handoff, 401, 404) — those are returned as-is for the caller's
 * normal handling. Honors `Retry-After` if the server sends it.
 */
export async function fetchWithRetry(
  url: string,
  build: () => RequestInit | Promise<RequestInit>,
  maxRetries: number,
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, await build());
      // Retry TRANSIENT statuses: 5xx, and 429 (rate limited).
      const transient = (res.status >= 500 && res.status <= 599) || res.status === 429;
      if (transient && attempt < maxRetries) {
        await retryDelay(attempt, res);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < maxRetries) {
        await retryDelay(attempt);
        continue;
      }
      throw err instanceof Error ? err : new AgentXError(String(err), "network_error", 0);
    }
  }
}

/**
 * Short, bounded backoff (50ms, 100ms, ... capped 500ms) between retries. If the response
 * carries a `Retry-After` (delta-seconds), honor it up to a 2s cap so a re-sent paid
 * authorization still stays comfortably within its validBefore window.
 */
export function retryDelay(attempt: number, res?: Response): Promise<void> {
  let ms = Math.min(500, 50 * 2 ** attempt);
  const retryAfter = res?.headers.get("Retry-After");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) ms = Math.min(2000, secs * 1000);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}
