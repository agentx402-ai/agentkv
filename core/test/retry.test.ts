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

  it("uses an injected fetch implementation instead of global fetch", async () => {
    const seen: string[] = [];
    const myFetch = (async (url: string | URL | Request) => {
      seen.push(String(url));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const res = await fetchWithRetry("https://injected", () => ({}), 0, { fetchImpl: myFetch });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["https://injected"]);
  });

  it("aborts a hung request after the per-attempt timeout, then retries", async () => {
    let attempts = 0;
    const hangUntilAbort = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        attempts++;
        init?.signal?.addEventListener("abort", () => reject(new Error("request-aborted")), {
          once: true,
        });
      })) as typeof fetch;
    await expect(
      fetchWithRetry("https://slow", () => ({}), 1, { timeoutMs: 20, fetchImpl: hangUntilAbort }),
    ).rejects.toThrow(/abort/i);
    expect(attempts).toBe(2); // maxRetries=1 -> 2 attempts, each timed out
  });

  it("surfaces a caller-initiated abort immediately without retrying", async () => {
    const ctrl = new AbortController();
    ctrl.abort(new Error("cancelled"));
    let attempts = 0;
    const f = ((_url: unknown, init?: RequestInit) => {
      attempts++;
      if (init?.signal?.aborted) return Promise.reject(new Error("aborted"));
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as typeof fetch;
    await expect(
      fetchWithRetry("https://x", () => ({}), 3, { signal: ctrl.signal, fetchImpl: f }),
    ).rejects.toThrow();
    expect(attempts).toBe(1);
  });
});

describe("retryDelay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

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
  });

  it("honors Retry-After in HTTP-date form up to the 2s cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    // 1s in the future (whole second — HTTP-date has no sub-second precision) -> ~1000ms, under the 2s cap.
    const when = new Date("2026-01-01T00:00:01.000Z").toUTCString();
    const res = new Response(null, { headers: { "Retry-After": when } });
    let resolved = false;
    retryDelay(0, res).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it("ignores a malformed Retry-After and falls back to jittered exponential backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // pin full base (no downward jitter)
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
  });

  it("caps exponential backoff at 500ms with no Retry-After", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1); // pin full base
    vi.useFakeTimers();
    let resolved = false;
    retryDelay(10).then(() => {
      resolved = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });

  it("applies full jitter (down to 50% of base) so retries don't synchronize", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // minimum jitter -> 50% of base
    vi.useFakeTimers();
    let resolved = false;
    retryDelay(10).then(() => {
      resolved = true;
    }); // base 500 -> 250ms
    await vi.advanceTimersByTimeAsync(249);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
  });
});
