// core/test/retry.test.ts
//
// Focused unit tests for the extracted `fetchWithRetry`/`retryDelay`
// pure functions (previously private `AgentKV#fetchWithRetry`/`#retryDelay`
// methods keyed off `this.maxRetries`). These test the retry MECHANICS in
// isolation (transient-status detection, retry-count bound, Retry-After
// honoring, thrown-error passthrough) without any signing/idempotency
// machinery. The integration-level behavior — that `AgentKV` still reuses a
// stable Idempotency-Key / pinned nonce across an internal retry — continues
// to be covered by `client/test/retry.test.ts`, unchanged, now exercising the
// delegating wrapper around these functions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, retryDelay } from "../src/retry";

afterEach(() => vi.restoreAllMocks());

describe("fetchWithRetry", () => {
  it("retries a 5xx then succeeds", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n === 1 ? new Response("err", { status: 503 }) : new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", () => ({}), 2);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 then succeeds", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n === 1
        ? new Response("slow down", { status: 429 })
        : new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", () => ({}), 2);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a 4xx (deterministic) — exactly one attempt", async () => {
    const fetchMock = vi.fn(async () => new Response("bad", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", () => ({}), 2);
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a 402 (deterministic payment handoff) — exactly one attempt", async () => {
    const fetchMock = vi.fn(async () => new Response("pay up", { status: 402 }));
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", () => ({}), 2);
    expect(res.status).toBe(402);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a thrown fetch (lost response) then succeeds", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      if (n === 1) throw new TypeError("network error");
      return new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await fetchWithRetry("https://x", () => ({}), 2);
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws after exhausting retries (maxRetries=2 -> 3 attempts total)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("network down");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("https://x", () => ({}), 2)).rejects.toThrow(/network down/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("maxRetries=0 disables retry entirely (one attempt, surfaces the error)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("net down");
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("https://x", () => ({}), 0)).rejects.toThrow(/net down/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("wraps a non-Error throw into an AgentXError-shaped error after exhausting retries", async () => {
    const fetchMock = vi.fn(async () => {
      // eslint-disable-next-line no-throw-literal
      throw "plain string failure";
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchWithRetry("https://x", () => ({}), 0)).rejects.toMatchObject({
      message: "plain string failure",
      code: "network_error",
    });
  });

  it("re-invokes build() per attempt (e.g. so a caller can re-sign with a fresh nonce)", async () => {
    let n = 0;
    const fetchMock = vi.fn(async () => {
      n++;
      return n === 1 ? new Response("err", { status: 503 }) : new Response("ok", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const build = vi.fn(() => ({ headers: { "X-Attempt": String(n) } }));
    await fetchWithRetry("https://x", build, 2);
    expect(build).toHaveBeenCalledTimes(2);
  });
});

describe("retryDelay", () => {
  it("honors Retry-After (seconds) up to the 2s cap", async () => {
    vi.useFakeTimers();
    const res = new Response(null, { headers: { "Retry-After": "5" } });
    let resolved = false;
    retryDelay(0, res).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });

  it("ignores a malformed Retry-After and falls back to exponential backoff", async () => {
    vi.useFakeTimers();
    const res = new Response(null, { headers: { "Retry-After": "not-a-number" } });
    let resolved = false;
    retryDelay(0, res).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });

  it("caps exponential backoff at 500ms with no Retry-After", async () => {
    vi.useFakeTimers();
    let resolved = false;
    retryDelay(10).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });
});
