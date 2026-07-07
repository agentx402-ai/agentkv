// client/test/prepay.test.ts
//
// Discounted Prepay: watermark-driven single-shot top-off, synchronous
// single-flight, challenge-template cache, nonce pinning, separate top-off budget.
//
// All tests mock `fetch` and assert by decoding captured PAYMENT-SIGNATURE
// headers (base64 JSON -> payload.authorization.value / .nonce).
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKV } from "../src/index";
import { nonceFromIdempotencyKey } from "../src/payment";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const endpoint = "https://api.agentx402.ai";

// A valid v2 PAYMENT-REQUIRED challenge for a write op (op price = $0.01).
// SHAPE SOURCE OF TRUTH: the backend's x402 `requirements()` builder. The two packages
// can't share an import (like the duplicated chainIdFromCaip2), so this fixture is kept
// in sync BY HAND. The worker emits exactly { scheme, network, asset, amount, payTo,
// maxTimeoutSeconds (= MAX_TIMEOUT_SECONDS = 600), extra:{name,version} } — no `resource`,
// no `maxAmountRequired`. `resource` below is retained deliberately as an EXTRA field the
// worker never sends, to prove the client tolerates/ignores unknown requirement fields.
function challengeHeader(amountAtomic = 10000): string {
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
          resource: "/kv/session", // extra field (worker omits) — client must ignore it
          maxTimeoutSeconds: 600, // matches the worker's MAX_TIMEOUT_SECONDS
          extra: { name: "USDC", version: "2" },
        },
      ],
    }),
  );
}

interface Captured {
  url: string;
  init: RequestInit;
  headers: Headers;
  paymentValue?: string; // authorization.value (atomic, as string)
  paymentNonce?: string; // authorization.nonce
}

/**
 * Install a fetch mock. `handler` receives the captured call and returns a
 * Response; captured calls (with decoded PAYMENT-SIGNATURE) are pushed to `calls`.
 */
function mockFetch(
  calls: Captured[],
  handler: (cap: Captured, n: number) => Response | Promise<Response>,
) {
  vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    const i = init ?? {};
    const headers = new Headers(i.headers);
    const cap: Captured = { url, init: i, headers };
    const paySig = headers.get("PAYMENT-SIGNATURE");
    if (paySig) {
      const decoded = JSON.parse(atob(paySig));
      cap.paymentValue = decoded.payload.authorization.value;
      cap.paymentNonce = decoded.payload.authorization.nonce;
    }
    calls.push(cap);
    return handler(cap, calls.length);
  });
}

function paymentCalls(calls: Captured[]): Captured[] {
  return calls.filter((c) => c.paymentValue !== undefined);
}

// A base64 PAYMENT-RESPONSE header exactly as the worker emits it (index.ts respond()):
// { success, payer, amount, txHash }. txHash is "" when the server served the op from
// existing credits (the attached top-off was NOT settled) and a real hash only when it
// actually settled USDC on-chain.
function paymentResponseHeader(txHash: string): string {
  return btoa(
    JSON.stringify({
      success: true,
      payer: "0x0000000000000000000000000000000000000002",
      amount: "20000000",
      txHash,
    }),
  );
}

// sessionSpentUsd is private with no getter — read it directly for spend-accounting asserts.
function sessionSpent(kv: AgentKV): number {
  return (kv as unknown as { sessionSpentUsd: number }).sessionSpentUsd;
}

afterEach(() => vi.restoreAllMocks());

describe("prepay: constructor validation (Step 4a)", () => {
  it("throws invalid_config when topoff < $1", () => {
    expect(
      () => new AgentKV({ privateKey: PK, endpoint, prepay: { watermark: 10, topoff: 0.5 } }),
    ).toThrowError(/prepay\.topoff must be >= \$1/);
  });

  it("throws invalid_config when watermark < 0", () => {
    expect(
      () => new AgentKV({ privateKey: PK, endpoint, prepay: { watermark: -1, topoff: 20 } }),
    ).toThrowError(/prepay\.watermark must be >= 0/);
  });

  it("throws invalid_config for a sub-atomic fractional topoff", () => {
    // $1.0000005 -> 1_000_000.5 atomic, not an integer.
    expect(
      () => new AgentKV({ privateKey: PK, endpoint, prepay: { watermark: 0, topoff: 1.0000005 } }),
    ).toThrowError(/prepay\.topoff must be >= \$1/);
  });

  it("accepts a valid prepay config", () => {
    expect(
      () => new AgentKV({ privateKey: PK, endpoint, prepay: { watermark: 10, topoff: 20 } }),
    ).not.toThrow();
  });

  it("accepts a whole-atomic fractional topoff like $33.30 (IEEE-754 float tolerance)", () => {
    // 33.3 * 1e6 === 33299999.999999996 in IEEE-754; strict-equality validation wrongly
    // rejected this exactly-whole-atomic ($33,300,000 µUSDC) amount. The relative-epsilon
    // check accepts it while still rejecting genuine sub-atomic fractions (tested above).
    expect(
      () => new AgentKV({ privateKey: PK, endpoint, prepay: { watermark: 10, topoff: 33.3 } }),
    ).not.toThrow();
    expect(
      () => new AgentKV({ privateKey: PK, endpoint, prepay: { watermark: 10, topoff: 1.005 } }),
    ).not.toThrow();
  });

  it("rejects prepay in account-key mode without a topoffPayer (no signing wallet can top off)", () => {
    const AK = `ak_${"0".repeat(64)}`;
    const ENC = `0x${"11".repeat(32)}` as const;
    expect(
      () =>
        new AgentKV({
          accountKey: AK,
          encryptionKey: ENC,
          endpoint,
          prepay: { watermark: 10, topoff: 20 },
        }),
    ).toThrowError(/prepay in account-key mode requires a topoffPayer hook/);
  });
});

describe("prepay: proactive single-shot top-off (a)", () => {
  it("after balance falls below watermark, the next set sends a $20 top-off PAYMENT-SIGNATURE", async () => {
    const calls: Captured[] = [];
    mockFetch(calls, (cap) => {
      // Every op succeeds; report a low balance: 5000 credits = $0.50, well below the
      // $10 watermark (= 100,000 credits at the correct 10,000-credit/$ rate).
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: { "X-AgentKV-Credits-Remaining": "5000", "PAYMENT-REQUIRED": challengeHeader() },
      });
    });

    const kv = new AgentKV({
      privateKey: PK,
      endpoint,
      prepay: { watermark: 10, topoff: 20 },
    });

    // 1st set: no balance known yet AND no template -> identity path. Response
    // reports low balance + caches the template.
    await kv.set("session", "v1");
    expect(paymentCalls(calls)).toHaveLength(0);

    // 2nd set: knownCredits=5000 < 10000 watermark AND template cached -> proactive
    // single-shot top-off of $20.
    await kv.set("session", "v2");
    const pays = paymentCalls(calls);
    expect(pays).toHaveLength(1);
    expect(pays[0].paymentValue).toBe("20000000"); // $20 atomic
  });

  it("a STALE cached template rejected with 402 self-heals via the identity path (no throw)", async () => {
    // If the cached challengeTemplate has drifted (or the price changed), the proactive
    // top-off's PAYMENT-SIGNATURE is rejected with a 402. The op must NOT throw: it falls
    // through to the identity/credit path, which re-signs the top-off against the FRESH
    // challenge and completes on THIS call.
    const calls: Captured[] = [];
    mockFetch(calls, (cap, n) => {
      if (n === 1) {
        // Prime: identity path -> low balance + cache the template.
        return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
          status: 200,
          headers: { "X-AgentKV-Credits-Remaining": "5000", "PAYMENT-REQUIRED": challengeHeader() },
        });
      }
      if (n === 2) {
        // Proactive top-off with the (stale) cached template -> REJECTED 402, but the
        // server returns a fresh PAYMENT-REQUIRED to retry against.
        expect(cap.paymentValue).toBe("20000000"); // it DID attempt the top-off
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_invalid" }),
          {
            status: 402,
            headers: { "PAYMENT-REQUIRED": challengeHeader() },
          },
        );
      }
      if (n === 3) {
        // Fall-through identity path -> insufficient credits, 402 + fresh challenge.
        return new Response(
          JSON.stringify({ error: "insufficient", code: "insufficient_credits" }),
          {
            status: 402,
            headers: {
              "X-AgentKV-Credits-Remaining": "5000",
              "PAYMENT-REQUIRED": challengeHeader(),
            },
          },
        );
      }
      // n === 4: hard-402 fallback top-off settles on-chain.
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: {
          "X-AgentKV-Credits-Remaining": "205000",
          "PAYMENT-RESPONSE": paymentResponseHeader("0xsettled"),
        },
      });
    });

    const kv = new AgentKV({
      privateKey: PK,
      endpoint,
      prepay: { watermark: 10, topoff: 20 },
    });

    await kv.set("session", "prime"); // call 1: caches template + knownCredits=5000
    // Must resolve (self-heal), not throw on the stale-template 402.
    const result = await kv.set("session", "v2");
    expect(result).toBeDefined();
    // 4 calls: prime, rejected proactive top-off, identity 402, successful fallback top-off.
    expect(calls).toHaveLength(4);
    // Exactly two payment attempts: the rejected proactive one and the settled fallback.
    const pays = paymentCalls(calls);
    expect(pays).toHaveLength(2);
    expect(pays[0].paymentValue).toBe("20000000");
    expect(pays[1].paymentValue).toBe("20000000");
    // Both top-off attempts pin the SAME EIP-3009 nonce (idempotency-keyed) so a partial
    // settle on the first can't double-charge on the fallback.
    expect(pays[0].paymentNonce).toBe(pays[1].paymentNonce);
  });
});

describe("prepay: synchronous single-flight across an await (b) (CRITICAL)", () => {
  it("two concurrent set()s below watermark emit exactly ONE top-off", async () => {
    const calls: Captured[] = [];
    mockFetch(calls, async () => {
      // Force a microtask yield inside the fetch handler so that, if the
      // watermark-check-and-flag-set were NOT synchronous, both ops would observe
      // the stale flag and each fire a top-off.
      await Promise.resolve();
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: { "X-AgentKV-Credits-Remaining": "5000", "PAYMENT-REQUIRED": challengeHeader() },
      });
    });

    const kv = new AgentKV({
      privateKey: PK,
      endpoint,
      prepay: { watermark: 10, topoff: 20 },
    });

    // Prime: one set so knownCredits=5000 and template are cached.
    await kv.set("session", "prime");
    calls.length = 0;

    // Fire two concurrent sets while below watermark.
    await Promise.all([kv.set("session", "a"), kv.set("session", "b")]);

    // Exactly ONE top-off PAYMENT-SIGNATURE across both concurrent ops.
    expect(paymentCalls(calls)).toHaveLength(1);
  });
});

describe("prepay: PAYG default unchanged (c)", () => {
  it("with NO prepay config, a 402 pays the OP price, never a top-off", async () => {
    const calls: Captured[] = [];
    let n = 0;
    mockFetch(calls, () => {
      n++;
      if (n === 1) {
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          {
            status: 402,
            headers: { "PAYMENT-REQUIRED": challengeHeader(10000) },
          },
        );
      }
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
    });

    const kv = new AgentKV({ privateKey: PK, endpoint }); // no prepay
    await kv.set("session", "v");

    const pays = paymentCalls(calls);
    expect(pays).toHaveLength(1);
    expect(pays[0].paymentValue).toBe("10000"); // op price ($0.01), NOT a top-off
  });
});

describe("prepay: hard-402 fallback pays a top-off (d)", () => {
  it("in prepay mode a 402 retry pays the TOP-OFF amount, not the op price", async () => {
    const calls: Captured[] = [];
    let n = 0;
    mockFetch(calls, () => {
      n++;
      if (n === 1) {
        // Cold start: identity path 402 (no template cached yet, no proactive).
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": challengeHeader(10000),
              "X-AgentKV-Credits-Remaining": "0",
            },
          },
        );
      }
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: { "X-AgentKV-Credits-Remaining": "20000" },
      });
    });

    const kv = new AgentKV({
      privateKey: PK,
      endpoint,
      prepay: { watermark: 10, topoff: 20 },
    });

    await kv.set("session", "v");
    const pays = paymentCalls(calls);
    expect(pays).toHaveLength(1);
    expect(pays[0].paymentValue).toBe("20000000"); // $20 top-off, NOT the $0.01 op price
  });
});

describe("prepay: per-op cap does not block a top-off (e)", () => {
  it("maxSpendUsd:1 with topoff:20 still performs the $20 top-off", async () => {
    const calls: Captured[] = [];
    mockFetch(calls, () => {
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: { "X-AgentKV-Credits-Remaining": "5000", "PAYMENT-REQUIRED": challengeHeader() },
      });
    });

    const kv = new AgentKV({
      privateKey: PK,
      endpoint,
      maxSpendUsd: 1, // per-op cap well below the $20 top-off
      prepay: { watermark: 10, topoff: 20 },
    });

    await kv.set("session", "prime"); // caches template + low balance
    calls.length = 0;
    await kv.set("session", "v"); // proactive top-off

    const pays = paymentCalls(calls);
    expect(pays).toHaveLength(1);
    expect(pays[0].paymentValue).toBe("20000000"); // top-off not blocked by maxSpendUsd
  });

  it("a top-off over maxSessionSpendUsd downgrades to pay-per-op (op price), not throw", async () => {
    const calls: Captured[] = [];
    let _n = 0;
    mockFetch(calls, () => {
      _n++;
      // Op only succeeds when paid (no credits): identity attempt 402s, paid retry 200s.
      const headers = new Headers(calls[calls.length - 1]?.headers);
      const isPaid = headers.has("PAYMENT-SIGNATURE");
      if (!isPaid) {
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": challengeHeader(10000),
              "X-AgentKV-Credits-Remaining": "5000",
            },
          },
        );
      }
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
    });

    const kv = new AgentKV({
      privateKey: PK,
      endpoint,
      maxSessionSpendUsd: 5, // a $20 top-off would exceed this
      prepay: { watermark: 10, topoff: 20 },
    });

    // Prime so template + low balance are cached (this op pays op price too).
    await kv.set("session", "prime");
    calls.length = 0;

    await kv.set("session", "v");
    const pays = paymentCalls(calls);
    // Downgrade: paid the op price ($0.01), NOT the $20 top-off, and did not throw.
    expect(pays).toHaveLength(1);
    expect(pays[0].paymentValue).toBe("10000");
  });
});

describe("prepay: cached template, no preflight (f)", () => {
  it("a proactive single-shot reuses the cached template and issues exactly ONE request", async () => {
    const calls: Captured[] = [];
    mockFetch(calls, () => {
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: { "X-AgentKV-Credits-Remaining": "5000", "PAYMENT-REQUIRED": challengeHeader() },
      });
    });

    const kv = new AgentKV({
      privateKey: PK,
      endpoint,
      prepay: { watermark: 10, topoff: 20 },
    });

    await kv.set("session", "prime"); // caches template + low balance
    calls.length = 0;

    await kv.set("session", "v"); // proactive single-shot
    // Exactly ONE request — no separate challenge/preflight fetch.
    expect(calls).toHaveLength(1);
    expect(calls[0].paymentValue).toBe("20000000");
  });
});

describe("prepay: nonce pinning (single-shot retry reuses the auth)", () => {
  it("the proactive top-off's EIP-3009 nonce is pinned to nonceFromIdempotencyKey(idempotencyKey)", async () => {
    const calls: Captured[] = [];
    mockFetch(calls, () => {
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: { "X-AgentKV-Credits-Remaining": "5000", "PAYMENT-REQUIRED": challengeHeader() },
      });
    });

    const kv = new AgentKV({
      privateKey: PK,
      endpoint,
      prepay: { watermark: 10, topoff: 20 },
    });

    await kv.set("session", "prime");
    calls.length = 0;

    await kv.set("session", "v", { idempotencyKey: "stable-top" });
    const pays = paymentCalls(calls);
    expect(pays).toHaveLength(1);
    expect(pays[0].paymentNonce).toBe(nonceFromIdempotencyKey("stable-top"));
  });
});

describe("prepay: async mode (g)", () => {
  it("async mode fires a detached deposit (not awaited in the op path), single-flight-guarded", async () => {
    const calls: Captured[] = [];
    let resolveDeposit: (() => void) | undefined;
    const depositGate = new Promise<void>((r) => {
      resolveDeposit = r;
    });

    mockFetch(calls, async (cap) => {
      if (cap.url.includes("/credits/deposit")) {
        // Hold the deposit open so we can prove the op returned without awaiting it.
        if (cap.headers.has("PAYMENT-SIGNATURE")) {
          await depositGate;
          return new Response(JSON.stringify({ credits_added: 20000, balance: 20000 }), {
            status: 200,
          });
        }
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challengeHeader(20000000) },
        });
      }
      // Regular op succeeds; reports low balance.
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: { "X-AgentKV-Credits-Remaining": "5000", "PAYMENT-REQUIRED": challengeHeader() },
      });
    });

    const kv = new AgentKV({
      privateKey: PK,
      endpoint,
      prepay: { watermark: 10, topoff: 20, async: true },
    });

    await kv.set("session", "prime"); // caches low balance + template
    calls.length = 0;

    // This set should return promptly even though the detached deposit is gated.
    await kv.set("session", "v");
    // The op itself is a plain identity set (no PAYMENT-SIGNATURE on the op).
    const opCalls = calls.filter((c) => !c.url.includes("/credits/deposit"));
    expect(opCalls).toHaveLength(1);
    expect(opCalls[0].paymentValue).toBeUndefined();

    // A detached deposit was kicked off (single-flight).
    const depositReqs = calls.filter((c) => c.url.includes("/credits/deposit"));
    expect(depositReqs.length).toBeGreaterThanOrEqual(1);

    // Release the deposit and let it settle.
    resolveDeposit?.();
    await depositGate;
    await new Promise((r) => setTimeout(r, 0));
  });

  it("async top-off bypasses the per-op cap and never causes an unhandled rejection (maxSpendUsd < topoff)", async () => {
    const calls: Captured[] = [];
    mockFetch(calls, async (cap) => {
      if (cap.url.includes("/credits/deposit")) {
        if (cap.headers.has("PAYMENT-SIGNATURE")) {
          return new Response(JSON.stringify({ credits_added: 20000, balance: 20000 }), {
            status: 200,
          });
        }
        return new Response("{}", {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challengeHeader(20000000) },
        });
      }
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: { "X-AgentKV-Credits-Remaining": "5000", "PAYMENT-REQUIRED": challengeHeader() },
      });
    });

    // Catch any unhandled rejection the detached top-off might throw.
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    try {
      const kv = new AgentKV({
        privateKey: PK,
        endpoint,
        maxSpendUsd: 1, // BELOW topoff ($20): the old code threw SpendCapError in the detached deposit
        prepay: { watermark: 10, topoff: 20, async: true },
      });
      await kv.set("session", "prime"); // knownCredits undefined -> no top-off; caches 5000
      await kv.set("session", "v"); // knownCredits 5000 < watermark 10000 -> fires the async top-off
      await new Promise((r) => setTimeout(r, 10)); // let the detached deposit (and any rejection) settle
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }

    // The detached top-off reached the deposit endpoint — the per-op cap was bypassed...
    const depositReqs = calls.filter((c) => c.url.includes("/credits/deposit"));
    expect(depositReqs.length).toBeGreaterThanOrEqual(1);
    // ...and no SpendCapError (or other rejection) escaped as an unhandled rejection.
    expect(unhandled).toHaveLength(0);
  });
});

describe("prepay: proactive top-off session-spend accounting (L3)", () => {
  const prepay = { watermark: 10, topoff: 20 } as const;

  it("set(): a proactive top-off SERVED FROM CREDITS (empty txHash) does NOT record session spend", async () => {
    const calls: Captured[] = [];
    mockFetch(
      calls,
      () =>
        new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
          status: 200,
          headers: {
            "X-AgentKV-Credits-Remaining": "5000", // < $10 watermark -> keeps claiming top-offs
            "PAYMENT-REQUIRED": challengeHeader(),
            "PAYMENT-RESPONSE": paymentResponseHeader(""), // op taken on credits; nothing settled
          },
        }),
    );

    const kv = new AgentKV({ privateKey: PK, endpoint, prepay });
    await kv.set("session", "v1"); // prime: caches template + low balance (cold-start identity path)
    await kv.set("session", "v2"); // proactive top-off attached, but the server settled NOTHING

    expect(paymentCalls(calls)).toHaveLength(1); // the top-off WAS still sent...
    expect(sessionSpent(kv)).toBe(0); // ...but must NOT be counted (no USDC moved)
  });

  it("set(): a proactive top-off that SETTLES (non-empty txHash) records the top-off spend", async () => {
    const calls: Captured[] = [];
    mockFetch(
      calls,
      () =>
        new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
          status: 200,
          headers: {
            "X-AgentKV-Credits-Remaining": "5000",
            "PAYMENT-REQUIRED": challengeHeader(),
            "PAYMENT-RESPONSE": paymentResponseHeader(`0x${"ab".repeat(32)}`), // real settle
          },
        }),
    );

    const kv = new AgentKV({ privateKey: PK, endpoint, prepay });
    await kv.set("session", "v1");
    await kv.set("session", "v2");

    expect(sessionSpent(kv)).toBe(20); // a top-off that actually settled IS recorded
  });

  it("get(): a proactive top-off served from credits (empty txHash) does NOT record session spend", async () => {
    const calls: Captured[] = [];
    let ciphertext = "";
    mockFetch(calls, (cap) => {
      // Capture the ciphertext the client encrypts on the priming set() so the get()
      // can echo back a value THIS client can decrypt.
      if (cap.init.method === "POST" && typeof cap.init.body === "string") {
        try {
          ciphertext = JSON.parse(cap.init.body).value as string;
        } catch {
          /* not the encrypted body */
        }
      }
      const body =
        cap.init.method === "POST" ? { ok: true, expires_at: "x" } : { value: ciphertext };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "X-AgentKV-Credits-Remaining": "5000",
          "PAYMENT-REQUIRED": challengeHeader(),
          "PAYMENT-RESPONSE": paymentResponseHeader(""), // unsettled
        },
      });
    });

    const kv = new AgentKV({ privateKey: PK, endpoint, prepay });
    await kv.set("session", "hello"); // prime template + low balance + capture ciphertext
    const got = await kv.get<string>("session"); // proactive top-off on the read path, unsettled

    expect(got).toBe("hello"); // round-trips (decryptable)
    expect(paymentCalls(calls).some((c) => c.init.method === "GET")).toBe(true); // top-off sent on GET
    expect(sessionSpent(kv)).toBe(0); // unsettled -> not counted
  });

  // The hard-402 fallback attaches a full top-off too (cold start / concurrent race).
  // It must obey the same settlement gate, or the L3 over-count survives there.
  it("set() hard-402 fallback: a TOP-OFF served from credits (empty txHash) does NOT record spend", async () => {
    const calls: Captured[] = [];
    let n = 0;
    mockFetch(calls, () => {
      n++;
      if (n === 1) {
        // Cold-start identity attempt -> 402 challenge (no template cached yet).
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": challengeHeader(10000),
              "X-AgentKV-Credits-Remaining": "0",
            },
          },
        );
      }
      // Paid retry: a concurrent op minted credits, so the server serves THIS op from
      // credits and settles nothing (empty txHash) despite the attached $20 top-off.
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: {
          "X-AgentKV-Credits-Remaining": "20000",
          "PAYMENT-RESPONSE": paymentResponseHeader(""),
        },
      });
    });

    const kv = new AgentKV({ privateKey: PK, endpoint, prepay });
    await kv.set("session", "v"); // cold start -> hard-402 top-off fallback, unsettled

    expect(paymentCalls(calls)).toHaveLength(1);
    expect(paymentCalls(calls)[0].paymentValue).toBe("20000000"); // the $20 top-off WAS sent
    expect(sessionSpent(kv)).toBe(0); // ...but not counted (nothing settled)
  });

  it("set() hard-402 fallback: a TOP-OFF that SETTLES (real txHash) IS recorded", async () => {
    const calls: Captured[] = [];
    let n = 0;
    mockFetch(calls, () => {
      n++;
      if (n === 1) {
        return new Response(
          JSON.stringify({ error: "payment required", code: "payment_required" }),
          {
            status: 402,
            headers: {
              "PAYMENT-REQUIRED": challengeHeader(10000),
              "X-AgentKV-Credits-Remaining": "0",
            },
          },
        );
      }
      // Paid retry: credits were genuinely short, so the server settled the top-off.
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: {
          "X-AgentKV-Credits-Remaining": "20000",
          "PAYMENT-RESPONSE": paymentResponseHeader(`0x${"cd".repeat(32)}`),
        },
      });
    });

    const kv = new AgentKV({ privateKey: PK, endpoint, prepay });
    await kv.set("session", "v");

    expect(sessionSpent(kv)).toBe(20); // a settled fallback top-off IS recorded
  });
});

describe("prepay: watermark USD→credit conversion (10,000 credits/$)", () => {
  it("tops off below the $-watermark even when ABOVE the old 1,000-credit/$ bug threshold", async () => {
    // watermark:10 ⇒ 100,000 credits at the CORRECT 10,000-credit/$ rate. A balance of 50,000
    // credits ($5) is below that, so a proactive top-off MUST fire. Under the OLD buggy rate
    // (watermark*1000 = 10,000 credits) 50,000 ≥ 10,000 and NO top-off would fire — so this
    // test fails on the 10×-low conversion and passes only with the corrected watermarkCredits().
    const calls: Captured[] = [];
    mockFetch(
      calls,
      () =>
        new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
          status: 200,
          headers: {
            "X-AgentKV-Credits-Remaining": "50000",
            "PAYMENT-REQUIRED": challengeHeader(),
          },
        }),
    );
    const kv = new AgentKV({ privateKey: PK, endpoint, prepay: { watermark: 10, topoff: 20 } });
    await kv.set("session", "prime"); // caches template + knownCredits=50000
    calls.length = 0;
    await kv.set("session", "v"); // 50,000 < 100,000 watermark → proactive top-off
    const pays = paymentCalls(calls);
    expect(pays).toHaveLength(1);
    expect(pays[0].paymentValue).toBe("20000000");
  });

  it("does NOT top off when credits are at/above the $-watermark", async () => {
    // 150,000 credits ($15) > 100,000-credit ($10) watermark → no top-off.
    const calls: Captured[] = [];
    mockFetch(
      calls,
      () =>
        new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
          status: 200,
          headers: {
            "X-AgentKV-Credits-Remaining": "150000",
            "PAYMENT-REQUIRED": challengeHeader(),
          },
        }),
    );
    const kv = new AgentKV({ privateKey: PK, endpoint, prepay: { watermark: 10, topoff: 20 } });
    await kv.set("session", "prime");
    calls.length = 0;
    await kv.set("session", "v");
    expect(paymentCalls(calls)).toHaveLength(0);
  });
});

describe("prepay: hard-402 single-flight (tryClaimTopoffOnFault)", () => {
  it("two concurrent COLD-START 402s emit exactly ONE $20 top-off; the loser pays op price", async () => {
    // No priming ⇒ no cached template ⇒ neither op claims proactively; both hit a hard 402 and
    // race tryClaimTopoffOnFault. The synchronous single-flight must let exactly ONE attach the
    // $20 top-off; the other falls back to the op price. Dropping the topoffInFlight check on the
    // fault path would make BOTH sign a $20 authorization (distinct nonces the server can't
    // dedupe) — a $40 double charge — and this assertion would fail.
    const calls: Captured[] = [];
    // Barrier: park BOTH identity (credit) attempts at the 402 until both have arrived, so the
    // two ops enter fault-handling and race tryClaimTopoffOnFault concurrently (without this,
    // a fast mock lets op A finish and RELEASE the single-flight before op B even reaches its
    // claim — they'd run sequentially and both top off).
    let identityArrivals = 0;
    let releaseBoth: (() => void) | undefined;
    const bothArrived = new Promise<void>((r) => {
      releaseBoth = r;
    });
    mockFetch(calls, async (cap) => {
      if (!cap.headers.has("PAYMENT-SIGNATURE")) {
        identityArrivals++;
        if (identityArrivals >= 2) releaseBoth?.();
        await bothArrived; // both ops resume together, then race the synchronous claim
        return new Response(JSON.stringify({ error: "x", code: "payment_required" }), {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": challengeHeader(10000),
            "X-AgentKV-Credits-Remaining": "0",
          },
        });
      }
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
        status: 200,
        headers: {
          "X-AgentKV-Credits-Remaining": "200000",
          "PAYMENT-RESPONSE": paymentResponseHeader("0xset"),
        },
      });
    });

    const kv = new AgentKV({ privateKey: PK, endpoint, prepay: { watermark: 10, topoff: 20 } });
    await Promise.all([kv.set("a", "1"), kv.set("b", "2")]);

    const values = paymentCalls(calls)
      .map((c) => c.paymentValue)
      .sort();
    expect(values).toEqual(["10000", "20000000"]); // exactly one op-price, one $20 top-off
  });
});

describe("prepay: settledTxHash tolerates a malformed PAYMENT-RESPONSE (L3)", () => {
  const cases: [string, string][] = [
    ["non-base64", "%%%not-base64%%%"],
    ["valid base64 but not JSON", btoa("not json")],
    ["JSON with a non-string txHash", btoa(JSON.stringify({ txHash: 123 }))],
  ];
  for (const [label, header] of cases) {
    it(`a settled-path 200 carrying a ${label} header resolves and records NO spend`, async () => {
      const calls: Captured[] = [];
      mockFetch(
        calls,
        () =>
          new Response(JSON.stringify({ ok: true, expires_at: "x" }), {
            status: 200,
            headers: {
              "X-AgentKV-Credits-Remaining": "5000",
              "PAYMENT-REQUIRED": challengeHeader(),
              "PAYMENT-RESPONSE": header,
            },
          }),
      );
      const kv = new AgentKV({ privateKey: PK, endpoint, prepay: { watermark: 10, topoff: 20 } });
      await kv.set("session", "v1"); // prime template + low balance
      await expect(kv.set("session", "v2")).resolves.toBeDefined(); // must NOT throw on garbage
      expect(sessionSpent(kv)).toBe(0); // unparseable/typed-wrong txHash ⇒ treated as unsettled
    });
  }
});
