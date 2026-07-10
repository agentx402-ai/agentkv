// client/test/account-inline.test.ts
//
// opt-in `opInlinePayer`: routes a WHOLE account-key op through an inline x402
// transport (e.g. `awal x402 pay`) on a hard 402, instead of the stage-1
// deposit top-off (`topoffPayer`). Constructor validation, the inline branch
// in set()/get(), precedence when both hooks are configured, and backward
// compatibility with no hook configured at all.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentKV } from "../src/index";

const AK = `ak_${"a".repeat(64)}`;
const ENC = `0x${"11".repeat(32)}` as const;
const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const endpoint = "https://api.agentx402.ai";
const noopInline = async () => ({ status: 200, body: "{}", headers: {} });

afterEach(() => vi.restoreAllMocks());

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const INSUFFICIENT = { error: "insufficient credits", code: "insufficient_credits" };
const NOT_PROVISIONED = { error: "account not provisioned", code: "account_not_provisioned" };
const NOT_PROVISIONED_MESSAGE =
  "account not provisioned — deposit (fundAccount() / agentkv deposit) or opt in to " +
  "pay-per-call bootstrap (bootstrap: true / AGENTKV_BOOTSTRAP=1)";

describe("account-key inline branch honors spend caps", () => {
  it("hands the hook maxAmountAtomic = the configured maxSpendUsd, not the default ceiling", async () => {
    const seen: number[] = [];
    const inline = vi.fn(async (req: any) => {
      seen.push(req.maxAmountAtomic);
      return { status: 200, body: JSON.stringify({ ok: true }), headers: {} };
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(402, INSUFFICIENT)),
    );
    const kv = new AgentKV({
      accountKey: AK,
      encryptionKey: ENC,
      endpoint,
      maxSpendUsd: 0.01,
      opInlinePayer: inline as any,
    });
    await kv.set("k", { a: 1 });
    // Before the fix this was hard-coded to the $0.05 default ceiling (50000), ignoring the cap.
    expect(seen).toEqual([Math.round(0.01 * 1_000_000)]);
  });

  it("refuses the inline op (before paying) when the session cap can't cover the per-op ceiling", async () => {
    const inline = vi.fn(noopInline);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json(402, INSUFFICIENT)),
    );
    const kv = new AgentKV({
      accountKey: AK,
      encryptionKey: ENC,
      endpoint,
      maxSpendUsd: 0.02,
      maxSessionSpendUsd: 0.01, // less than the per-op ceiling -> pre-reservation must fail
      opInlinePayer: inline as any,
    });
    await expect(kv.set("k", { a: 1 })).rejects.toThrow(/session cap/);
    expect(inline).not.toHaveBeenCalled();
  });
});

describe("opInlinePayer constructor validation", () => {
  it("rejects opInlinePayer in wallet mode (account-key only)", () => {
    expect(
      () => new AgentKV({ privateKey: PK, endpoint, opInlinePayer: noopInline as any }),
    ).toThrowError(/account-key/);
  });

  it("accepts opInlinePayer in account-key mode (no prepay required — pay-per-op)", () => {
    expect(
      () =>
        new AgentKV({
          accountKey: AK,
          encryptionKey: ENC,
          endpoint,
          opInlinePayer: noopInline as any,
        }),
    ).not.toThrow();
  });

  it("rejects a non-function opInlinePayer", () => {
    expect(
      () =>
        new AgentKV({
          accountKey: AK,
          encryptionKey: ENC,
          endpoint,
          // @ts-expect-error deliberately wrong type
          opInlinePayer: "awal",
        }),
    ).toThrowError(/opInlinePayer/);
  });

  it("rejects a non-boolean bootstrap", () => {
    expect(
      () =>
        new AgentKV({
          accountKey: AK,
          encryptionKey: ENC,
          endpoint,
          opInlinePayer: noopInline as any,
          // @ts-expect-error deliberately wrong type
          bootstrap: "yes",
        }),
    ).toThrowError(/bootstrap/);
  });
});

describe("account-key set() inline branch", () => {
  it("hard 402 with opInlinePayer → routes the whole op through the hook and returns its result", async () => {
    const inline = vi.fn(async (req: any) => {
      expect(req.method).toBe("POST");
      // the fetch URL targets /v1/kv/<digest>.
      expect(req.url).toBe(`${endpoint}/v1/kv/${req.url.split("/kv/")[1]}`);
      expect(req.headers.Authorization).toBe(`Bearer ${AK}`);
      expect(req.headers["Idempotency-Key"]).toBeTruthy();
      expect(req.headers["content-type"]).toBe("application/json");
      expect(typeof req.body).toBe("string"); // ciphertext JSON
      expect(req.maxAmountAtomic).toBeGreaterThan(0);
      return {
        status: 200,
        body: JSON.stringify({ ok: true, expires_at: "2099-01-01T00:00:00Z" }),
        headers: {},
      };
    });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "insufficient_credits" }), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": "e30=" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC, endpoint, opInlinePayer: inline });
    const r = await kv.set("k", { hello: "world" });
    expect(r).toEqual({ ok: true, expires_at: "2099-01-01T00:00:00Z" });
    expect(inline).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // no internal 402->pay dance; the hook owns it
  });

  it("non-2xx from the hook throws an error built from its body", async () => {
    const inline = vi.fn(async () => ({
      status: 403,
      body: JSON.stringify({ error: "forbidden", code: "forbidden" }),
      headers: {},
    }));
    vi.stubGlobal("fetch", async () => json(402, INSUFFICIENT));
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC, endpoint, opInlinePayer: inline });
    await expect(kv.set("k", { v: 1 })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("200 without prior 402 never calls the hook (backward compat with credit path)", async () => {
    const inline = vi.fn(noopInline);
    vi.stubGlobal("fetch", async () => json(200, { ok: true, expires_at: "x" }));
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC, endpoint, opInlinePayer: inline });
    await kv.set("k", { v: 1 });
    expect(inline).not.toHaveBeenCalled();
  });
});

describe("account-key get() inline branch", () => {
  it("hard 402 with opInlinePayer routes the read through the hook and decrypts the result", async () => {
    // Use a real set() (credit path, 200 immediately) to obtain valid ciphertext,
    // then force a 402 on the subsequent get() and have the hook return that
    // ciphertext as the "paid" response body.
    let storedCiphertext: string | undefined;
    const setFetch = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body as string);
      storedCiphertext = body.value;
      return json(200, { ok: true, expires_at: "x" });
    });
    vi.stubGlobal("fetch", setFetch);
    const writer = new AgentKV({ accountKey: AK, encryptionKey: ENC, endpoint });
    await writer.set("k", { hello: "world" });

    const inline = vi.fn(async (req: any) => {
      expect(req.method).toBe("GET");
      expect(req.body).toBeUndefined();
      expect(req.headers.Authorization).toBe(`Bearer ${AK}`);
      return { status: 200, body: JSON.stringify({ value: storedCiphertext }), headers: {} };
    });
    vi.stubGlobal("fetch", async () => json(402, INSUFFICIENT));
    const reader = new AgentKV({
      accountKey: AK,
      encryptionKey: ENC,
      endpoint,
      opInlinePayer: inline,
    });
    const result = await reader.get("k");
    expect(result).toEqual({ hello: "world" });
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it("get() inline 404 → null", async () => {
    const inline = vi.fn(async () => ({
      status: 404,
      body: JSON.stringify({ code: "not_found" }),
      headers: {},
    }));
    vi.stubGlobal("fetch", async () => json(402, INSUFFICIENT));
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC, endpoint, opInlinePayer: inline });
    await expect(kv.get("missing")).resolves.toBeNull();
    expect(inline).toHaveBeenCalledTimes(1);
  });
});

describe("opInlinePayer / topoffPayer precedence", () => {
  it("when BOTH are configured, topoffPayer fires and opInlinePayer is never called", async () => {
    const topoffPayer = vi.fn(async () => {});
    const inline = vi.fn(noopInline);
    const calls = [() => json(402, INSUFFICIENT), () => json(200, { ok: true, expires_at: "x" })];
    let n = 0;
    vi.stubGlobal("fetch", async () => calls[Math.min(n++, calls.length - 1)]());
    const kv = new AgentKV({
      accountKey: AK,
      encryptionKey: ENC,
      endpoint,
      prepay: { watermark: 0.5, topoff: 1 },
      topoffPayer,
      opInlinePayer: inline,
    });
    const r = await kv.set("k", { v: 1 });
    expect(r).toMatchObject({ ok: true });
    expect(topoffPayer).toHaveBeenCalledTimes(1);
    expect(inline).not.toHaveBeenCalled();
  });
});

describe("backward compatibility", () => {
  it("no opInlinePayer configured → a hard 402 surfaces unchanged (stage-1 behavior)", async () => {
    vi.stubGlobal("fetch", async () => json(402, INSUFFICIENT));
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC, endpoint });
    await expect(kv.set("k", { v: 1 })).rejects.toMatchObject({ code: "insufficient_credits" });
  });
});

describe("bootstrap gating on account_not_provisioned", () => {
  it("default (bootstrap unset) + account_not_provisioned 402 → throws the distinguishing error, never calls the hook", async () => {
    const inline = vi.fn(noopInline);
    const fetchMock = vi.fn(async () => json(402, NOT_PROVISIONED));
    vi.stubGlobal("fetch", fetchMock);
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC, endpoint, opInlinePayer: inline });
    await expect(kv.set("k", { v: 1 })).rejects.toMatchObject({
      code: "account_not_provisioned",
      status: 402,
      message: NOT_PROVISIONED_MESSAGE,
    });
    expect(inline).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry, no inline dispatch
  });

  it("default (bootstrap: false, explicit) + account_not_provisioned 402 → same distinguishing error", async () => {
    const inline = vi.fn(noopInline);
    vi.stubGlobal("fetch", async () => json(402, NOT_PROVISIONED));
    const kv = new AgentKV({
      accountKey: AK,
      encryptionKey: ENC,
      endpoint,
      opInlinePayer: inline,
      bootstrap: false,
    });
    await expect(kv.set("k", { v: 1 })).rejects.toMatchObject({ code: "account_not_provisioned" });
    expect(inline).not.toHaveBeenCalled();
  });

  it("default (no bootstrap) + insufficient_credits 402 → still pays via the hook (unaffected)", async () => {
    const inline = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ ok: true, expires_at: "x" }),
      headers: {},
    }));
    vi.stubGlobal("fetch", async () => json(402, INSUFFICIENT));
    const kv = new AgentKV({ accountKey: AK, encryptionKey: ENC, endpoint, opInlinePayer: inline });
    const r = await kv.set("k", { v: 1 });
    expect(r).toMatchObject({ ok: true });
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it("bootstrap: true + account_not_provisioned 402 → routes through the hook (opt-in)", async () => {
    const inline = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ ok: true, expires_at: "x" }),
      headers: {},
    }));
    vi.stubGlobal("fetch", async () => json(402, NOT_PROVISIONED));
    const kv = new AgentKV({
      accountKey: AK,
      encryptionKey: ENC,
      endpoint,
      opInlinePayer: inline,
      bootstrap: true,
    });
    const r = await kv.set("k", { v: 1 });
    expect(r).toMatchObject({ ok: true });
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it("bootstrap: true + insufficient_credits 402 → still routes through the hook (unaffected)", async () => {
    const inline = vi.fn(async () => ({
      status: 200,
      body: JSON.stringify({ ok: true, expires_at: "x" }),
      headers: {},
    }));
    vi.stubGlobal("fetch", async () => json(402, INSUFFICIENT));
    const kv = new AgentKV({
      accountKey: AK,
      encryptionKey: ENC,
      endpoint,
      opInlinePayer: inline,
      bootstrap: true,
    });
    const r = await kv.set("k", { v: 1 });
    expect(r).toMatchObject({ ok: true });
    expect(inline).toHaveBeenCalledTimes(1);
  });

  it("wallet mode: bootstrap: true has no effect — a 402 pay-and-retry proceeds unchanged, even for account_not_provisioned", async () => {
    const challenge = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "5000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            resource: "/kv/session",
            description: "write",
            mimeType: "application/json",
            maxTimeoutSeconds: 300,
          },
        ],
      }),
    );
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt++;
      if (attempt === 1) {
        return new Response(JSON.stringify(NOT_PROVISIONED), {
          status: 402,
          headers: { "PAYMENT-REQUIRED": challenge },
        });
      }
      return new Response(JSON.stringify({ ok: true, expires_at: "x" }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const kv = new AgentKV({ privateKey: PK, endpoint, bootstrap: true });
    const res = await kv.set("session", "v");
    expect(res.ok).toBe(true);
    expect(attempt).toBe(2);
  });
});
