// client/test/retry.test.ts
//
// Bounded internal retry for lost-response dedup. A "lost response" (server
// processed + charged, but the HTTP response was dropped) surfaces as a thrown
// fetch; the client retries reusing the op's STABLE Idempotency-Key (set/get) or
// PINNED EIP-3009 nonce (paid/deposit) so the server dedupes instead of charging
// twice. These tests assert the client-side signals that make that server-side
// dedup possible (same key / same pinned nonce across attempts), plus the
// triggers/non-triggers and recordSpend-exactly-once.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKV } from "../src/index";
import { nonceFromIdempotencyKey } from "../src/payment";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const endpoint = "https://api.agentx402.ai";

// SHAPE SOURCE OF TRUTH: the backend's x402 `requirements()` builder (kept in sync by
// hand — client and backend can't share an import). The backend emits { scheme, network, asset, amount,
// payTo, maxTimeoutSeconds (=600), extra:{name,version} }; `resource` is an extra field the
// backend never sends, kept to prove the client ignores unknown requirement fields.
function challengeHeader(amountAtomic: number): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: String(amountAtomic),
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x0000000000000000000000000000000000000001",
          resource: "/kv/k", // extra field (worker omits) — client must ignore it
          maxTimeoutSeconds: 600, // matches the worker's MAX_TIMEOUT_SECONDS
          extra: { name: "USDC", version: "2" },
        },
      ],
    }),
  );
}

interface Captured {
  url: string;
  headers: Headers;
  paymentNonce?: string;
}

function mockFetch(calls: Captured[], handler: (cap: Captured, n: number) => Response) {
  vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const cap: Captured = { url: typeof input === "string" ? input : input.url, headers };
    const paySig = headers.get("PAYMENT-SIGNATURE");
    if (paySig) cap.paymentNonce = JSON.parse(atob(paySig)).payload.authorization.nonce;
    calls.push(cap);
    return handler(cap, calls.length);
  });
}

const ok = () => new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
const notFound = () =>
  new Response(JSON.stringify({ error: "nf", code: "not_found" }), { status: 404 });
const challenge402 = (amt: number) =>
  new Response(JSON.stringify({ error: "x", code: "payment_required" }), {
    status: 402,
    headers: { "PAYMENT-REQUIRED": challengeHeader(amt) },
  });

afterEach(() => vi.restoreAllMocks());

describe("internal retry: lost-response dedup", () => {
  it("credit write retries a thrown fetch with the SAME Idempotency-Key but a FRESH identity nonce", async () => {
    const calls: Captured[] = [];
    let threw = false;
    mockFetch(calls, () => {
      if (!threw) {
        threw = true;
        throw new TypeError("network error (lost response)");
      }
      return ok();
    });
    const kv = new AgentKV({ privateKey: PK, endpoint });
    expect(await kv.set("k", { a: 1 })).toEqual({ ok: true, expires_at: "x" });
    expect(calls.length).toBe(2);
    const key = calls[0].headers.get("Idempotency-Key");
    expect(key).toBeTruthy();
    expect(calls[1].headers.get("Idempotency-Key")).toBe(key); // stable -> server dedupes
    expect(calls[0].headers.get("X-AgentKV-Nonce")).toBeTruthy();
    expect(calls[1].headers.get("X-AgentKV-Nonce")).not.toBe(
      calls[0].headers.get("X-AgentKV-Nonce"),
    ); // fresh
  });

  it("paid write retries with the SAME pinned EIP-3009 nonce (settle exactly once server-side)", async () => {
    const calls: Captured[] = [];
    let payThrew = false;
    mockFetch(calls, (cap) => {
      if (!cap.headers.get("PAYMENT-SIGNATURE")) return challenge402(5000); // $0.005 write
      if (!payThrew) {
        payThrew = true;
        throw new TypeError("network error");
      }
      return ok();
    });
    const kv = new AgentKV({ privateKey: PK, endpoint });
    expect(await kv.set("k", { a: 1 })).toEqual({ ok: true, expires_at: "x" });
    const pays = calls.filter((c) => c.paymentNonce);
    expect(pays.length).toBe(2);
    // The nonce is actually PINNED to the op's stable key (not merely re-sent): this
    // is what dedupes a cross-process caller retry on-chain. Asserting equality across
    // attempts alone would pass even with a random nonce (the signature is built once),
    // so assert the deterministic value — dropping the pin makes this fail.
    expect(pays[0].paymentNonce).toBe(
      nonceFromIdempotencyKey(pays[0].headers.get("Idempotency-Key")!),
    );
    expect(pays[1].paymentNonce).toBe(pays[0].paymentNonce); // same auth re-sent on retry
  });

  it("deposit retries a lost response with the SAME pinned nonce (no double-mint)", async () => {
    const calls: Captured[] = [];
    let payThrew = false;
    mockFetch(calls, (cap) => {
      if (!cap.headers.get("PAYMENT-SIGNATURE")) return challenge402(1_000_000); // $1
      if (!payThrew) {
        payThrew = true;
        throw new TypeError("network error");
      }
      return new Response(JSON.stringify({ credits_added: 10000, balance: 10000 }), {
        status: 200,
      });
    });
    const kv = new AgentKV({ privateKey: PK, endpoint });
    expect(await kv.deposit(1)).toEqual({ credits_added: 10000, balance: 10000 });
    const pays = calls.filter((c) => c.paymentNonce);
    expect(pays.length).toBe(2);
    // Deposit dedupes on the EIP-3009 nonce (the route ignores Idempotency-Key), so
    // assert it is PINNED to the stable per-deposit key — dropping the pin (random
    // nonce) makes this fail. The retry re-sends the same auth -> replayDeposit /
    // AuthorizationUsedError mints exactly once. NB: two SEPARATE deposit() calls mint
    // distinct keys, so caller-level retries do NOT dedupe — only the internal retry.
    expect(pays[0].paymentNonce).toBe(
      nonceFromIdempotencyKey(pays[0].headers.get("Idempotency-Key")!),
    );
    expect(pays[1].paymentNonce).toBe(pays[0].paymentNonce); // same auth re-sent on retry
  });

  it("get() sends a stable Idempotency-Key by default and reuses it across a transient retry", async () => {
    const calls: Captured[] = [];
    let threw = false;
    mockFetch(calls, () => {
      if (!threw) {
        threw = true;
        throw new TypeError("net");
      }
      return notFound(); // terminal -> get() returns null (no decrypt needed)
    });
    const kv = new AgentKV({ privateKey: PK, endpoint });
    expect(await kv.get("missing")).toBeNull();
    expect(calls.length).toBe(2);
    const key = calls[0].headers.get("Idempotency-Key");
    expect(key).toBeTruthy();
    expect(calls[1].headers.get("Idempotency-Key")).toBe(key);
    expect(calls[1].headers.get("X-AgentKV-Nonce")).not.toBe(
      calls[0].headers.get("X-AgentKV-Nonce"),
    );
  });

  it("two separate get()s use DISTINCT idempotency keys (separately charged)", async () => {
    const calls: Captured[] = [];
    mockFetch(calls, () => notFound());
    const kv = new AgentKV({ privateKey: PK, endpoint });
    await kv.get("a");
    await kv.get("b");
    expect(calls.length).toBe(2);
    expect(calls[0].headers.get("Idempotency-Key")).not.toBe(
      calls[1].headers.get("Idempotency-Key"),
    );
  });

  it("retries a 5xx then succeeds", async () => {
    const calls: Captured[] = [];
    let n = 0;
    mockFetch(calls, () => (++n === 1 ? new Response("err", { status: 503 }) : ok()));
    const kv = new AgentKV({ privateKey: PK, endpoint });
    expect(await kv.set("k", 1)).toEqual({ ok: true, expires_at: "x" });
    expect(calls.length).toBe(2);
  });

  it("does NOT retry a 4xx (deterministic) — exactly one attempt", async () => {
    const calls: Captured[] = [];
    mockFetch(
      calls,
      () =>
        new Response(JSON.stringify({ error: "bad", code: "invalid_request" }), { status: 400 }),
    );
    const kv = new AgentKV({ privateKey: PK, endpoint });
    await expect(kv.set("k", 1)).rejects.toThrow();
    expect(calls.length).toBe(1);
  });

  it("throws after exhausting retries; the same Idempotency-Key is reused on every attempt", async () => {
    const calls: Captured[] = [];
    mockFetch(calls, () => {
      throw new TypeError("network down");
    });
    const kv = new AgentKV({ privateKey: PK, endpoint });
    await expect(kv.set("k", 1)).rejects.toThrow(/network down/);
    expect(calls.length).toBe(3); // 1 + 2 default retries
    expect(new Set(calls.map((c) => c.headers.get("Idempotency-Key"))).size).toBe(1);
  });

  it("retries: 0 disables internal retry (one attempt, surfaces the error)", async () => {
    const calls: Captured[] = [];
    mockFetch(calls, () => {
      throw new TypeError("net down");
    });
    const kv = new AgentKV({ privateKey: PK, endpoint, retries: 0 });
    await expect(kv.set("k", 1)).rejects.toThrow(/net down/);
    expect(calls.length).toBe(1);
  });

  it("records spend exactly once even when the paid op retried", async () => {
    const calls: Captured[] = [];
    let payThrew = false;
    mockFetch(calls, (cap) => {
      if (!cap.headers.get("PAYMENT-SIGNATURE")) return challenge402(5000); // $0.005
      if (!payThrew) {
        payThrew = true;
        throw new TypeError("net");
      }
      return ok();
    });
    // Cap = exactly two $0.005 writes. If the retried first write recorded $0.005
    // twice, the cap would already sit at $0.010 and the second write would throw.
    const kv = new AgentKV({ privateKey: PK, endpoint, maxSessionSpendUsd: 0.01 });
    await kv.set("a", 1); // retries once -> must record $0.005 ONCE
    await expect(kv.set("b", 2)).resolves.toEqual({ ok: true, expires_at: "x" }); // 2nd still fits
  });

  it("does NOT retry a 402 from the pay fetch (e.g. an expired/invalid auth) — surfaces it", async () => {
    const calls: Captured[] = [];
    let payN = 0;
    mockFetch(calls, (cap) => {
      if (!cap.headers.get("PAYMENT-SIGNATURE")) return challenge402(5000); // credit -> 402 challenge
      payN++;
      if (payN === 1) throw new TypeError("net"); // first pay attempt: lost response -> retry
      // The retry re-sends the auth; the server rejects it (validBefore expiry /
      // invalid). 402 is deterministic, so the retry loop must NOT re-retry it — the
      // short retry bound is what keeps a re-sent auth inside validBefore in practice.
      return new Response(JSON.stringify({ error: "expired", code: "payment_invalid" }), {
        status: 402,
      });
    });
    const kv = new AgentKV({ privateKey: PK, endpoint });
    await expect(kv.set("k", 1)).rejects.toThrow();
    expect(calls.filter((c) => c.headers.get("PAYMENT-SIGNATURE")).length).toBe(2); // threw + 402, not retried again
  });
});

describe("internal retry: free identity ops route through fetchWithRetry", () => {
  it("delete retries a 5xx and re-signs identity with a FRESH nonce each attempt", async () => {
    const calls: Captured[] = [];
    let n = 0;
    mockFetch(calls, () => {
      n++;
      if (n === 1) return new Response("{}", { status: 503 });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const kv = new AgentKV({ privateKey: PK, endpoint });
    await kv.delete("k");
    expect(calls.length).toBe(2); // the 503 was retried
    // Fresh identity nonce per attempt so the retry is not a server-side replay.
    expect(calls[0].headers.get("X-AgentKV-Nonce")).toBeTruthy();
    expect(calls[1].headers.get("X-AgentKV-Nonce")).not.toBe(
      calls[0].headers.get("X-AgentKV-Nonce"),
    );
  });

  it("balance retries a 5xx and returns the body balance", async () => {
    const calls: Captured[] = [];
    let n = 0;
    mockFetch(calls, () => {
      n++;
      if (n === 1) return new Response("{}", { status: 500 });
      return new Response(JSON.stringify({ balance: 42 }), { status: 200 });
    });
    const kv = new AgentKV({ privateKey: PK, endpoint });
    expect(await kv.balance()).toBe(42);
    expect(calls.length).toBe(2);
  });

  it("listKeys retries a 5xx", async () => {
    const calls: Captured[] = [];
    let n = 0;
    mockFetch(calls, () => {
      n++;
      if (n === 1) return new Response("{}", { status: 502 });
      return new Response(JSON.stringify({ items: [], cursor: null }), { status: 200 });
    });
    const kv = new AgentKV({ privateKey: PK, endpoint });
    expect(await kv.listKeys()).toEqual({ keys: [], cursor: null });
    expect(calls.length).toBe(2);
  });
});
