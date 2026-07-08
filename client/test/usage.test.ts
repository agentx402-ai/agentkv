// client/test/usage.test.ts
//
// The backend folds a machine-readable `usage`
// envelope into a paid op's 200 success body. This pins that the client SURFACES
// it on `set()`'s result and via the additive `getWithUsage()` read accessor —
// WITHOUT changing `get()`'s existing `Promise<T | null>` signature — and that
// every op still sends a fresh, non-empty `Idempotency-Key`.
import { hexToBytes } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveKeyMaterial, encrypt, hashKey } from "../src/crypto";
import { AgentKV } from "../src/index";
import type { UsageBlock } from "../src/types";

const PK_A = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

// The full reconciled shape the backend builds:
// service/op/price_usd (actually charged) + list_price_usd (un-discounted reference rate,
// REQUIRED) + credits_charged. price_usd < list_price_usd here models the credit-path 10x
// discount, so the test can't pass by accident if the client conflated the two fields.
const WRITE_USAGE: UsageBlock = {
  service: "kv",
  op: "write",
  price_usd: 0.0005,
  list_price_usd: 0.005,
  credits_charged: 5,
};

const READ_USAGE: UsageBlock = {
  service: "kv",
  op: "read",
  price_usd: 0.0003,
  list_price_usd: 0.003,
  credits_charged: 3,
};

describe("usage envelope (client mirror of the backend's usage envelope)", () => {
  const endpoint = "https://api.agentx402.ai";
  let kv: AgentKV;
  let calls: { url: string; init: RequestInit }[];

  beforeEach(() => {
    kv = new AgentKV({ privateKey: PK_A, endpoint });
    calls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(handler: (url: string, init: RequestInit) => Response) {
    vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const i = init ?? {};
      calls.push({ url, init: i });
      return handler(url, i);
    });
  }

  function idempotencyKeyOf(callIndex: number): string | null {
    return new Headers(calls[callIndex].init.headers).get("Idempotency-Key");
  }

  it("set() surfaces the full worker usage envelope on the result", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            ok: true,
            expires_at: "2099-01-01T00:00:00Z",
            usage: WRITE_USAGE,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await kv.set("session", { hello: "world" });

    expect(result.ok).toBe(true);
    // The amount ACTUALLY charged (credit-path discounted rate).
    expect(result.usage?.price_usd).toBe(0.0005);
    // The un-discounted reference rate — REQUIRED, must not collapse into price_usd.
    expect(result.usage?.list_price_usd).toBe(0.005);
    expect(result.usage?.credits_charged).toBe(5);
    expect(result.usage?.service).toBe("kv");
    expect(result.usage?.op).toBe("write");

    // A fresh, non-empty Idempotency-Key is sent on every op.
    const idem = idempotencyKeyOf(0);
    expect(idem).toBeTruthy();
    expect(idem).not.toBe("");
  });

  it("getWithUsage() returns both the decrypted value and the usage envelope", async () => {
    const original = { hello: "world", n: 7 };
    const km = deriveKeyMaterial(hexToBytes(PK_A));
    const ciphertext = await encrypt(
      km.value,
      JSON.stringify(original),
      hashKey(km.mac, "session"),
    );

    mockFetch(
      () =>
        new Response(
          JSON.stringify({
            value: ciphertext,
            expires_at: "x",
            usage: READ_USAGE,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const { value, usage } = await kv.getWithUsage("session");

    expect(value).toEqual(original);
    expect(usage?.price_usd).toBe(0.0003);
    expect(usage?.list_price_usd).toBe(0.003);
    expect(usage?.credits_charged).toBe(3);
    expect(usage?.service).toBe("kv");
    expect(usage?.op).toBe("read");

    const idem = idempotencyKeyOf(0);
    expect(idem).toBeTruthy();
    expect(idem).not.toBe("");
  });

  it("getWithUsage() returns a null value (no usage) on a 404 miss", async () => {
    mockFetch(
      () =>
        new Response(JSON.stringify({ error: "not found", code: "not_found" }), { status: 404 }),
    );
    const { value, usage } = await kv.getWithUsage("missing");
    expect(value).toBeNull();
    expect(usage).toBeUndefined();
  });

  it("get() keeps its existing T | null signature and behavior unaffected by usage", async () => {
    const original = { still: "works" };
    const km = deriveKeyMaterial(hexToBytes(PK_A));
    const ciphertext = await encrypt(
      km.value,
      JSON.stringify(original),
      hashKey(km.mac, "session"),
    );

    mockFetch(
      () =>
        new Response(JSON.stringify({ value: ciphertext, expires_at: "x", usage: READ_USAGE }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const out = await kv.get("session");
    expect(out).toEqual(original);
    // No usage leaking onto the plain get() result shape.
    expect((out as any).usage).toBeUndefined();
  });

  it("delete() never carries a usage block (kv:delete is a free op)", async () => {
    mockFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const result = await kv.delete("session");
    expect(result.ok).toBe(true);
    expect((result as any).usage).toBeUndefined();
  });
});
