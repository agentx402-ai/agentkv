// client/test/account-topoff.test.ts
//
// Account-key auto top-off: constructor validation, reactive hard-402 top-off,
// proactive watermark top-off, spend accounting.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKV } from "../src/index";

const AK = `ak_${"a".repeat(64)}`;
const ENC = `0x${"11".repeat(32)}` as const;
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const endpoint = "https://api.agentx402.ai";
const noopPayer = async () => {};

afterEach(() => vi.restoreAllMocks());

describe("account-key topoffPayer: constructor validation", () => {
  it("rejects prepay in account-key mode WITHOUT a topoffPayer (inert config)", () => {
    expect(
      () =>
        new AgentKV({
          accountKey: AK,
          encryptionKey: ENC,
          endpoint,
          prepay: { watermark: 0.5, topoff: 1 },
        }),
    ).toThrowError(/topoffPayer/);
  });

  it("rejects topoffPayer WITHOUT prepay (hook could never fire)", () => {
    expect(
      () => new AgentKV({ accountKey: AK, encryptionKey: ENC, endpoint, topoffPayer: noopPayer }),
    ).toThrowError(/prepay/);
  });

  it("rejects topoffPayer in wallet mode (account-key only)", () => {
    expect(
      () =>
        new AgentKV({
          privateKey: PK,
          endpoint,
          prepay: { watermark: 0.5, topoff: 1 },
          topoffPayer: noopPayer,
        }),
    ).toThrowError(/account-key/);
  });

  it("accepts prepay.async in account-key mode WITH a topoffPayer (no longer rejected)", () => {
    expect(
      () =>
        new AgentKV({
          accountKey: AK,
          encryptionKey: ENC,
          endpoint,
          prepay: { watermark: 0.5, topoff: 1, async: true },
          topoffPayer: noopPayer,
        }),
    ).not.toThrow();
  });

  it("rejects a non-function topoffPayer", () => {
    expect(
      () =>
        new AgentKV({
          accountKey: AK,
          encryptionKey: ENC,
          endpoint,
          prepay: { watermark: 0.5, topoff: 1 },
          // @ts-expect-error deliberately wrong type
          topoffPayer: "awal",
        }),
    ).toThrowError(/topoffPayer/);
  });

  it("still enforces topoff >= $1 in account-key mode", () => {
    expect(
      () =>
        new AgentKV({
          accountKey: AK,
          encryptionKey: ENC,
          endpoint,
          prepay: { watermark: 0.5, topoff: 0.5 },
          topoffPayer: noopPayer,
        }),
    ).toThrowError(/topoff must be >= \$1/);
  });

  it("accepts the valid combination (accountKey + encryptionKey + prepay + topoffPayer)", () => {
    const kv = new AgentKV({
      accountKey: AK,
      encryptionKey: ENC,
      endpoint,
      prepay: { watermark: 0.5, topoff: 1 },
      topoffPayer: noopPayer,
    });
    expect(kv.accountKey).toBe(AK);
  });
});

// ---- reactive (hard-402) top-off ----

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const INSUFFICIENT = { error: "insufficient credits", code: "insufficient_credits" };
const SET_OK = { ok: true, expires_at: "2026-10-02T00:00:00Z" };

function accountClient(payer: (req: any) => Promise<void>, extra: Record<string, unknown> = {}) {
  return new AgentKV({
    accountKey: AK,
    encryptionKey: ENC,
    endpoint,
    prepay: { watermark: 0.5, topoff: 1 },
    topoffPayer: payer,
    ...extra,
  });
}

/** Capture fetch calls; respond per-call via `responses` (indexed by call number). */
function stubFetch(responses: Array<() => Response>) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
    calls.push({
      url: typeof input === "string" ? input : input.url,
      headers: new Headers(init?.headers),
    });
    const make = responses[Math.min(calls.length - 1, responses.length - 1)];
    return make();
  });
  return calls;
}

describe("account-key topoffPayer: reactive hard-402", () => {
  it("402 -> hook (correct request) -> retry once with the SAME Idempotency-Key -> success", async () => {
    const payerCalls: any[] = [];
    const kv = accountClient(async (req) => {
      payerCalls.push(req);
    });
    const calls = stubFetch([() => json(402, INSUFFICIENT), () => json(200, SET_OK)]);

    const result = await kv.set("k", { v: 1 });
    expect(result.ok).toBe(true);

    expect(payerCalls).toHaveLength(1);
    expect(payerCalls[0]).toEqual({
      depositUrl: `${endpoint}/v1/account/deposit`, // default apiVersion "1"
      accountKey: AK,
      amountUsd: 1,
      maxAmountAtomic: 1_000_000,
    });

    expect(calls).toHaveLength(2);
    // Same op, exactly-once: identical Idempotency-Key on the retry.
    expect(calls[1].headers.get("Idempotency-Key")).toBe(calls[0].headers.get("Idempotency-Key"));
    // Both requests carry the bearer, never a payment header.
    for (const c of calls) {
      expect(c.headers.get("Authorization")).toBe(`Bearer ${AK}`);
      expect(c.headers.get("PAYMENT-SIGNATURE")).toBeNull();
    }
  });

  it("hook rejection on the hard-402 path is FATAL with code account_topoff_failed", async () => {
    const kv = accountClient(async () => {
      throw new Error("awal: insufficient balance");
    });
    stubFetch([() => json(402, INSUFFICIENT)]);

    await expect(kv.set("k", { v: 1 })).rejects.toMatchObject({
      code: "account_topoff_failed",
      message: expect.stringContaining("awal: insufficient balance"),
    });
  });

  it("a second 402 after a successful hook surfaces the error — hook fires ONCE", async () => {
    let payerCalls = 0;
    const kv = accountClient(async () => {
      payerCalls++;
    });
    stubFetch([() => json(402, INSUFFICIENT), () => json(402, INSUFFICIENT)]);

    await expect(kv.set("k", { v: 1 })).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(payerCalls).toBe(1);
  });

  it("get(): 402 -> hook -> retry (404 after top-off returns null, proving the retry ran)", async () => {
    let payerCalls = 0;
    const kv = accountClient(async () => {
      payerCalls++;
    });
    const calls = stubFetch([
      () => json(402, INSUFFICIENT),
      () => json(404, { error: "not found", code: "not_found" }),
    ]);

    await expect(kv.get("missing")).resolves.toBeNull();
    expect(payerCalls).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[1].headers.get("Idempotency-Key")).toBe(calls[0].headers.get("Idempotency-Key"));
  });

  it("session-cap gating: a top-off that would exceed maxSessionSpendUsd is skipped (402 surfaces)", async () => {
    let payerCalls = 0;
    const kv = accountClient(
      async () => {
        payerCalls++;
      },
      { maxSessionSpendUsd: 0.5 }, // below the $1 top-off
    );
    stubFetch([() => json(402, INSUFFICIENT)]);

    await expect(kv.set("k", { v: 1 })).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(payerCalls).toBe(0);
  });

  it("spend accounting: settled top-off + write cost hit the session counter once each", async () => {
    const kv = accountClient(async () => {});
    stubFetch([() => json(402, INSUFFICIENT), () => json(200, SET_OK)]);
    await kv.set("k", { v: 1 });
    const spent = (kv as unknown as { sessionSpentUsd: number }).sessionSpentUsd;
    expect(spent).toBeCloseTo(1.0005, 6); // $1 top-off + $0.0005 write
  });

  it("top-off is NOT gated by the per-op cap (maxSpendUsd below $1 still tops off)", async () => {
    let payerCalls = 0;
    const kv = accountClient(
      async () => {
        payerCalls++;
      },
      { maxSpendUsd: 0.01 }, // per-op cap far below the $1 top-off; write cost is $0.0005
    );
    stubFetch([() => json(402, INSUFFICIENT), () => json(200, SET_OK)]);
    await expect(kv.set("k", { v: 1 })).resolves.toMatchObject({ ok: true });
    expect(payerCalls).toBe(1);
  });
});

describe("account-key topoffPayer: proactive watermark", () => {
  // watermark $0.50 = 5000 credits. Seed knownCredits below that via the
  // X-AgentKV-Credits-Remaining response header on a first op.
  const LOW_CREDITS = { "X-AgentKV-Credits-Remaining": "100" };
  const HIGH_CREDITS = { "X-AgentKV-Credits-Remaining": "50000" };

  it("fires the hook BEFORE the next op once tracked credits fall below the watermark", async () => {
    let payerCalls = 0;
    const kv = accountClient(async () => {
      payerCalls++;
    });
    stubFetch([
      () => json(200, SET_OK, LOW_CREDITS), // op 1 seeds knownCredits=100 (< 5000)
      () => json(200, SET_OK, HIGH_CREDITS), // op 2 runs after the proactive top-off
    ]);

    await kv.set("a", 1);
    expect(payerCalls).toBe(0); // op 1: no knownCredits yet -> no proactive claim
    await kv.set("b", 2);
    expect(payerCalls).toBe(1); // op 2: claim won -> hook fired
  });

  it("single-flight: concurrent ops below the watermark fire the hook exactly once", async () => {
    let payerCalls = 0;
    const kv = accountClient(async () => {
      payerCalls++;
    });
    stubFetch([
      () => json(200, SET_OK, LOW_CREDITS),
      () => json(200, SET_OK, LOW_CREDITS),
      () => json(200, SET_OK, HIGH_CREDITS),
    ]);

    await kv.set("seed", 0); // knownCredits = 100
    await Promise.all([kv.set("a", 1), kv.set("b", 2)]);
    expect(payerCalls).toBe(1);
  });

  it("proactive hook failure is NON-fatal: the op proceeds on remaining credits", async () => {
    const kv = accountClient(async () => {
      throw new Error("awal offline");
    });
    stubFetch([() => json(200, SET_OK, LOW_CREDITS), () => json(200, SET_OK, HIGH_CREDITS)]);

    await kv.set("seed", 0);
    await expect(kv.set("a", 1)).resolves.toMatchObject({ ok: true }); // no throw
    const spent = (kv as unknown as { sessionSpentUsd: number }).sessionSpentUsd;
    expect(spent).toBeCloseTo(0.001, 6); // two writes only — the FAILED top-off was never recorded
  });

  it("above the watermark the hook never fires", async () => {
    let payerCalls = 0;
    const kv = accountClient(async () => {
      payerCalls++;
    });
    stubFetch([() => json(200, SET_OK, HIGH_CREDITS)]);
    await kv.set("a", 1);
    await kv.set("b", 2);
    expect(payerCalls).toBe(0);
  });

  it("proactive success then a residual 402 does NOT fire a SECOND top-off (bounded spend)", async () => {
    let payerCalls = 0;
    const kv = accountClient(async () => {
      payerCalls++;
    });
    stubFetch([
      () => json(200, SET_OK, LOW_CREDITS), // op1 seeds knownCredits below watermark
      () => json(402, INSUFFICIENT), // op2: proactive top-off fires, then still 402
    ]);

    await kv.set("seed", 0); // knownCredits now below watermark; no proactive yet (was undefined)
    // op2: proactive top-off (payerCalls -> 1), then sendBearer 402. With the guard the
    // hard-402 fallback must NOT fire a second top-off; the 402 surfaces instead.
    await expect(kv.set("a", 1)).rejects.toMatchObject({ code: "insufficient_credits" });
    expect(payerCalls).toBe(1); // exactly ONE deposit — not two
  });

  it("failed proactive top-off still lets the hard-402 path fire exactly one real top-off", async () => {
    let calls = 0;
    const kv = accountClient(async () => {
      calls++;
      if (calls === 1) throw new Error("awal offline"); // proactive attempt fails (non-fatal)
      // 2nd call (hard-402 attempt) succeeds
    });
    stubFetch([
      () => json(200, SET_OK, LOW_CREDITS), // op1 seeds knownCredits below watermark
      () => json(402, INSUFFICIENT), // op2: proactive top-off fails, sendBearer 402
      () => json(200, SET_OK), // op2: hard-402 top-off succeeds, retry succeeds
    ]);

    await kv.set("seed", 0);
    await expect(kv.set("a", 1)).resolves.toMatchObject({ ok: true });
    expect(calls).toBe(2); // proactive (failed) + hard-402 (succeeded)
  });
});

// ---- prepay.async in account-key mode ----

describe("account-key topoffPayer: prepay.async", () => {
  const LOW_CREDITS = { "X-AgentKV-Credits-Remaining": "100" }; // < 5000 (the $0.5 watermark)
  const HIGH_CREDITS = { "X-AgentKV-Credits-Remaining": "50000" };

  it("maybeAsyncTopoff dispatches the payer hook detached (not runDeposit's no_signer)", async () => {
    let payerCalls = 0;
    const kv = accountClient(
      async () => {
        payerCalls++;
      },
      { prepay: { watermark: 0.5, topoff: 1, async: true } },
    );
    stubFetch([
      () => json(200, SET_OK, LOW_CREDITS), // op1 seeds knownCredits=100 — too early to fire
      () => json(200, SET_OK, HIGH_CREDITS), // op2: the KV op itself, unrelated to the hook
    ]);

    await kv.set("seed", 0); // knownCredits was undefined before this call -> no-op
    expect(payerCalls).toBe(0);

    // knownCredits (100) is now below the watermark: maybeAsyncTopoff fires a DETACHED
    // runAccountTopoff(). The op itself must resolve normally — NOT throw `no_signer`,
    // which is what the old runDeposit-based path would throw in account mode.
    await expect(kv.set("a", 1)).resolves.toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 0)); // let the detached hook settle
    expect(payerCalls).toBe(1);
  });
});

// ---- deposit() aliases the configured payer in account-key mode ----

describe("account-key topoffPayer: deposit() aliasing", () => {
  it("deposit(amountUsd) calls the payer hook with that amount and resolves the resulting balance", async () => {
    const payerCalls: any[] = [];
    const kv = accountClient(async (req) => {
      payerCalls.push(req);
    });
    const calls = stubFetch([() => json(200, { balance: 54321 })]); // GET /credits/balance

    const result = await kv.deposit(2);

    expect(payerCalls).toHaveLength(1);
    expect(payerCalls[0]).toMatchObject({
      depositUrl: `${endpoint}/v1/account/deposit`, // default apiVersion "1"
      accountKey: AK,
      amountUsd: 2,
    });
    expect(result).toMatchObject({ balance: 54321 });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/credits/balance");
  });

  it("deposit() in account-key mode WITHOUT a configured topoffPayer still throws no_signer", async () => {
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC, endpoint });
    await expect(kv.deposit(5)).rejects.toMatchObject({ code: "no_signer" });
  });
});
