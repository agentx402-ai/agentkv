// client/test/authorized-ceiling.test.ts
//
// The per-op AUTHORIZED CEILING: a 402 quoting more than the verb's pinned x402 price is refused
// BEFORE any EIP-3009 authorization is produced.
//
// WHY THIS IS SEPARATE FROM maxSpendUsd. `maxSpendUsd` is opt-in and usually unset, and in that
// DEFAULT config the only other guard is `DEFAULT_MAX_OP_USD` ($0.05) — 10x a real $0.005 write.
// Measured on the pre-fix client: a spoofed 402 quoting $0.04 for a routine `set()` was SIGNED,
// authorization value 40000 atomic. The ceiling closes that window without requiring any caller
// configuration.
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { deriveKeyMaterial, encrypt, hashKey, normalizeEncryptionKey } from "../src/crypto";
import { AgentKV, X402_READ_USD, X402_WRITE_USD } from "../src/index";
import { SpendCapError } from "../src/types";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const ENC = `0x${"ab".repeat(32)}` as const;
const EP = "https://kv.example";

function challenge(amountAtomic: string): string {
  return btoa(
    JSON.stringify({
      x402Version: 2,
      accepts: [
        {
          scheme: "exact",
          network: "eip155:8453",
          amount: amountAtomic,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          payTo: "0x0000000000000000000000000000000000000001",
          maxTimeoutSeconds: 600,
          extra: { name: "USD Coin", version: "2" },
        },
      ],
    }),
  );
}

/**
 * A client whose signer counts only EIP-3009 (`TransferWithAuthorization`) signings. The credit
 * path signs an EIP-712 IDENTITY payload first, so a bare signTypedData counter would conflate
 * "authorized a payment" with "proved who I am" — only the former spends money. Counting the
 * PRODUCED authorization (not the sent header) is what catches a sign-then-check reorder.
 */
/**
 * A server-shaped `get` body. The success path always DECRYPTS `value`, so a read fixture has to
 * carry a genuine envelope under the same key material the client derives from `encryptionKey`
 * (AAD-bound to the key's digest, exactly as `set` writes it).
 */
async function encryptedBody(keyName: string, payload: unknown): Promise<string> {
  const km = deriveKeyMaterial(normalizeEncryptionKey(ENC));
  const value = await encrypt(km.value, JSON.stringify(payload), hashKey(km.mac, keyName));
  return JSON.stringify({ value });
}

function walletWith(opts: Record<string, unknown>, quoteAtomic: string, successBody?: string) {
  const base = privateKeyToAccount(PK);
  let authorizations = 0;
  let paidValue: string | null = null;
  const signer = {
    ...base,
    signTypedData: ((td: Parameters<typeof base.signTypedData>[0]) => {
      if ((td as { primaryType?: string }).primaryType === "TransferWithAuthorization") {
        authorizations++;
      }
      return base.signTypedData(td);
    }) as typeof base.signTypedData,
  } as typeof base;

  const fetchImpl = (async (_u: unknown, init?: RequestInit) => {
    const sig = init && new Headers(init.headers).get("PAYMENT-SIGNATURE");
    if (sig) {
      paidValue = JSON.parse(atob(sig))?.payload?.authorization?.value ?? null;
      return new Response(successBody ?? JSON.stringify({ ok: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: "payment required" }), {
      status: 402,
      headers: { "PAYMENT-REQUIRED": challenge(quoteAtomic) },
    });
  }) as unknown as typeof fetch;

  return {
    kv: new AgentKV({ signer, encryptionKey: ENC, endpoint: EP, fetch: fetchImpl, ...opts }),
    authorizations: () => authorizations,
    paidValue: () => paidValue,
  };
}

describe("per-op authorized ceiling", () => {
  it("the pinned prices mirror the worker's atomic op prices", () => {
    // Parity guard. The worker is canonical (platform/src/types.ts: READ_PRICE_ATOMIC = 3_000,
    // WRITE_PRICE_ATOMIC = 5_000); the packages can't share an import, so drift must be a caught,
    // deliberate change rather than a silent one. These are a CEILING, so a client pinned BELOW
    // the server's quote refuses every honest 402 — see the constants' comment before changing.
    expect(X402_READ_USD).toBe(3_000 / 1_000_000);
    expect(X402_WRITE_USD).toBe(5_000 / 1_000_000);
  });

  it("DEFAULT config: a set() 402 quoting 10x the pinned write price is REFUSED, no authorization", async () => {
    // $0.04 against a $0.005 pinned write. Under DEFAULT_MAX_OP_USD alone this passed ($0.04 <
    // $0.05) and the client signed — the exact measured pre-fix behavior.
    const { kv, authorizations, paidValue } = walletWith({}, "40000");
    await expect(kv.set("k", { a: 1 })).rejects.toBeInstanceOf(SpendCapError);
    expect(authorizations()).toBe(0); // never PRODUCED, not merely never sent
    expect(paidValue()).toBeNull();
  });

  it("DEFAULT config: a get() 402 quoting far above the pinned read price is REFUSED", async () => {
    const { kv, authorizations } = walletWith({}, "40000"); // $0.04 vs $0.003 pinned read
    await expect(kv.get("k")).rejects.toBeInstanceOf(SpendCapError);
    expect(authorizations()).toBe(0);
  });

  it("the ceiling still refuses when it is TIGHTER than an explicit maxSpendUsd", async () => {
    // A caller who opts into a $1 per-op cap has not thereby authorized paying $0.04 for a $0.005
    // write — the pinned price still bounds the op. Without this the ceiling would be trivially
    // disabled by the very option people set to be MORE careful.
    const { kv, authorizations } = walletWith({ maxSpendUsd: 1 }, "40000");
    await expect(kv.set("k", { a: 1 })).rejects.toBeInstanceOf(SpendCapError);
    expect(authorizations()).toBe(0);
  });

  it("an HONEST quote at exactly the pinned write price is signed (no false-reject)", async () => {
    // 5000 atomic = $0.005 = X402_WRITE_USD exactly — the boundary. This is the regression that
    // catches a client pinned BELOW the server's real quote, which would refuse every honest 402
    // and break all paid writes. Only meaningful while this literal equals the constant.
    const { kv, authorizations, paidValue } = walletWith({}, "5000");
    await kv.set("k", { a: 1 });
    expect(authorizations()).toBe(1);
    expect(paidValue()).toBe("5000"); // the challenge's exact amount, not a self-computed sum
  });

  it("an HONEST quote at exactly the pinned read price is signed", async () => {
    const { kv, authorizations, paidValue } = walletWith(
      {},
      "3000", // $0.003 = X402_READ_USD exactly
      await encryptedBody("k", { hello: "world" }),
    );
    await expect(kv.get("k")).resolves.toMatchObject({ hello: "world" });
    expect(authorizations()).toBe(1);
    expect(paidValue()).toBe("3000");
  });

  it("a prepay TOP-OFF is exempt: it pays >= $1 without tripping the op ceiling", async () => {
    // The top-off branch buys CREDITS, not this op — it legitimately pays far above any per-op
    // price, and applying the ceiling there would break prepay entirely. The server quotes the op
    // price on the 402; the client overrides the amount with its own >= $1 top-off.
    const { kv, authorizations, paidValue } = walletWith(
      { prepay: { watermark: 0.5, topoff: 1 } },
      "5000",
    );
    await kv.set("k", { a: 1 });
    expect(authorizations()).toBe(1);
    // $1 = 1_000_000 atomic — 200x the op ceiling, and correctly NOT refused.
    expect(paidValue()).toBe("1000000");
  });
});
