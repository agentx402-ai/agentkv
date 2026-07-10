// client/src/index.ts
export const VERSION = "0.2.0";

import { fetchWithRetry } from "@agentx402-ai/core";
import { hexToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { isAccountKeyFormat } from "./account";
import {
  decrypt,
  deriveKeyMaterial,
  encrypt,
  hashKey,
  type KeyMaterial,
  normalizeEncryptionKey,
} from "./crypto";
import {
  buildBearerHeaders,
  buildIdentityHeaders,
  buildPaymentHeader,
  challengePriceUsd,
  decodeBase64Utf8,
  freshNonce,
  nonceFromIdempotencyKey,
} from "./payment";
import {
  AgentKVError,
  type AgentKVOptions,
  DEFAULT_NETWORK,
  type DeleteResult,
  type DepositResult,
  type GetOptions,
  type OpInlineRequest,
  type OpInlineResponse,
  type SetOptions,
  type SetResult,
  type Signer,
  SpendCapError,
  type TopoffPayerRequest,
  type UsageBlock,
} from "./types";

export { generateAccountKey, isAccountKeyFormat } from "./account";
export type { KeyMaterial } from "./crypto";
export { decrypt, deriveKeyMaterial, encrypt, hashKey } from "./crypto";
export type {
  AgentKVOptions,
  DeleteResult,
  DepositResult,
  ErrorBody,
  GetOptions,
  OpInlineRequest,
  OpInlineResponse,
  SetOptions,
  SetResult,
  Signer,
  TopoffPayerRequest,
  UsageBlock,
} from "./types";
export { AgentKVError, SpendCapError } from "./types";

// Additive `/v1` path prefix (the backend registers every route at both its
// legacy path and this `/v1` sibling, pointing at the SAME handler). The client
// cannot import the backend's version module across packages, so this literal
// is kept in sync by the routing tests in `test/paths.test.ts`.
const V1 = "/v1";

// EIP-712 typed data signed to derive the AES key material in sign-to-derive mode. Unlike a
// bare personal_sign string (which ANY dapp/relayer can get a user to sign, then reproduce to
// recover the key), this is DOMAIN-SCOPED: wallets render the "AgentKV Encryption" domain, so
// a generic-text phishing prompt cannot elicit the same signature. The signature IS the
// complete key material (value + key-name + blind-index MAC), so callers who can't treat it as
// secret-grade should construct with an explicit `encryptionKey` instead. The domain omits
// chainId on purpose so the key is stable across networks; changing any field below re-keys all
// sign-to-derive data.
const ENC_DERIVATION_DOMAIN = { name: "AgentKV Encryption", version: "1" } as const;
const ENC_DERIVATION_TYPES = {
  Derive: [
    { name: "purpose", type: "string" },
    { name: "version", type: "string" },
  ],
} as const;
const ENC_DERIVATION_MESSAGE = { purpose: "encryption-key", version: "v1" } as const;

// Credit costs in USD for the spend-cap gate in account-key (bearer) mode.
// In account mode a set/get debits PREPAID CREDITS server-side (READ_COST=3,
// WRITE_COST=5 credits; 1 credit = $0.0001), NOT the x402 op price ($0.003/$0.005).
// We mirror the backend's credit costs so the cap bounds a runaway agent's actual
// per-op spend. Keep in sync with the backend's credit-cost constants — the
// separate packages can't share an import, so `pricing.test.ts` pins these to their
// documented derivation (a parity guard: any drift is a caught, deliberate change).
/** USD value of one prepaid credit ($1 mints 10,000 credits). */
export const CREDIT_VALUE_USD = 0.0001;
export const ACCOUNT_READ_USD = 0.0003; // READ_COST=3 credits × $0.0001/credit
export const ACCOUNT_WRITE_USD = 0.0005; // WRITE_COST=5 credits × $0.0001/credit

/**
 * Built-in ceiling on a SERVER-QUOTED per-op price when no `maxSpendUsd` is configured.
 * The advertised op price is ~$0.005; without this, a compromised or spoofed worker could
 * answer a routine read with a 402 challenge for the wallet's entire balance and the client
 * would sign the EIP-3009 authorization (the default config has no per-op cap). Callers who
 * legitimately need a pricier op opt in explicitly via `maxSpendUsd`.
 */
export const DEFAULT_MAX_OP_USD = 0.05;

/**
 * Convert a USD amount to a whole number of atomic USDC units (1e6), or `null` if it is not
 * a positive whole-atomic amount. Uses a RELATIVE epsilon rather than strict float equality:
 * IEEE-754 makes `33.3 * 1e6 === 33299999.999999996`, so `x*1e6 !== Math.round(x*1e6)` wrongly
 * rejects the exactly-whole-atomic $33.30 / $1.005. The relative test still rejects genuine
 * sub-atomic fractions (e.g. 1.0000005, relative error ~5e-7 ≫ 1e-9).
 */
function toWholeAtomicUsd(amountUsd: number): number | null {
  if (!Number.isFinite(amountUsd)) return null;
  const atomic = Math.round(amountUsd * 1_000_000);
  if (!Number.isInteger(atomic) || atomic <= 0) return null;
  if (Math.abs(amountUsd * 1_000_000 - atomic) > atomic * 1e-9) return null;
  return atomic;
}

export class AgentKV {
  /**
   * The signing wallet. `undefined` in account-key mode (a managed account has no
   * wallet that can sign) — the `ak_…` bearer token is the identity instead.
   */
  readonly signer?: Signer;
  /**
   * The wallet address, the per-wallet namespace. In account-key mode there is no
   * wallet, so this is the zero address (a documented sentinel: the account key —
   * not an address — is the identity; the server names storage by the key's hash).
   */
  /** The wallet address (its namespace) in wallet/signer mode; `undefined` in account-key mode. */
  readonly address: `0x${string}` | undefined;
  /** The raw `ak_…` bearer token in account-key mode; `undefined` otherwise. */
  readonly accountKey?: string;
  readonly endpoint: string;
  readonly network: string;
  readonly maxSpendUsd?: number;
  readonly maxSessionSpendUsd?: number;
  /** Bounded internal retries on transient failures (network error / 5xx). */
  readonly maxRetries: number;
  private readonly timeoutMs?: number;
  private readonly fetchImpl?: typeof fetch;
  private _ikm?: Uint8Array;
  private _km?: KeyMaterial;
  private _kmPromise?: Promise<KeyMaterial>;
  private sessionSpentUsd = 0;

  // --- Discounted Prepay state (opt-in; undefined => Pay-as-you-go, unchanged) ---
  private readonly prepay?: { watermark: number; topoff: number; async?: boolean };
  /** Top-off amount in atomic USDC units (1e6), computed once in the constructor. */
  private readonly topoffAtomic: number = 0;
  /** Account-key top-off hook (account-key mode only; validated in the constructor). */
  private readonly topoffPayer?: (req: TopoffPayerRequest) => Promise<void>;
  /**
   * Account-key inline x402 transport hook (account-key mode only; validated in
   * the constructor). Mutually exclusive with `topoffPayer` PER OP — `topoffPayer`
   * always takes precedence when both are configured (see the call sites in
   * set()/get(), which gate on `!this.topoffPayer`).
   */
  private readonly opInlinePayer?: (req: OpInlineRequest) => Promise<OpInlineResponse>;
  /**
   * Opt-in gate (default false) letting a payer hook fire on an
   * `account_not_provisioned` 402 — see `AgentKVOptions.bootstrap`.
   */
  private readonly bootstrap: boolean = false;
  /** Last-known credit balance as an EXACT integer credit count (never USD floats). */
  private knownCredits?: number;
  /** Synchronous single-flight guard: at most one in-flight top-off at a time. */
  private topoffInFlight = false;
  /**
   * The in-flight SYNCHRONOUS top-off deposit (account mode), published so a concurrent op
   * that hits a hard 402 but can't claim the single-flight can await it and retry.
   */
  private topoffPromise: Promise<void> | undefined;
  /** Cached last `PAYMENT-REQUIRED` header — the template for a proactive single-shot. */
  private challengeTemplate?: string;

  constructor(opts: AgentKVOptions) {
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.network = opts.network ?? DEFAULT_NETWORK;
    this.maxSpendUsd = opts.maxSpendUsd;
    this.maxSessionSpendUsd = opts.maxSessionSpendUsd;
    this.maxRetries = Math.max(0, Math.floor(opts.retries ?? 2));
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetch;

    // Step 4a: validate prepay at construction (fail fast, not after a round-trip).
    const isAccountMode = "accountKey" in opts && opts.accountKey != null;
    if (opts.topoffPayer !== undefined) {
      if (typeof opts.topoffPayer !== "function") {
        throw new AgentKVError("topoffPayer must be a function", "invalid_config", 0);
      }
      if (!isAccountMode) {
        // Wallet mode signs its own top-offs (runDeposit); a hook would be silently
        // ignored — reject like every other inert config.
        throw new AgentKVError(
          "topoffPayer is account-key-mode only; wallet mode pays its own top-offs",
          "invalid_config",
          0,
        );
      }
      if (!opts.prepay) {
        // The hook only fires through the prepay watermark/402 machinery; without
        // prepay it could never be called.
        throw new AgentKVError(
          "topoffPayer requires prepay ({ watermark, topoff }) to control when it fires",
          "invalid_config",
          0,
        );
      }
      this.topoffPayer = opts.topoffPayer;
    }
    if (opts.opInlinePayer !== undefined) {
      if (typeof opts.opInlinePayer !== "function") {
        throw new AgentKVError("opInlinePayer must be a function", "invalid_config", 0);
      }
      if (!isAccountMode) {
        // Wallet mode signs (and pays) its own x402 challenges directly; a hook
        // would be silently ignored — reject like every other inert config.
        throw new AgentKVError(
          "opInlinePayer is account-key-mode only; wallet mode pays its own x402 challenges",
          "invalid_config",
          0,
        );
      }
      // Unlike topoffPayer, opInlinePayer needs no `prepay`: it is pay-per-op,
      // fired directly off a hard 402 with no watermark/top-off machinery.
      this.opInlinePayer = opts.opInlinePayer;
    }
    if (opts.bootstrap !== undefined) {
      if (typeof opts.bootstrap !== "boolean") {
        throw new AgentKVError("bootstrap must be a boolean", "invalid_config", 0);
      }
      this.bootstrap = opts.bootstrap;
    }
    if (opts.prepay) {
      if (isAccountMode && !opts.topoffPayer) {
        // Without a payer hook every top-off mechanism is unreachable in account-key
        // mode (bearer ops have no signing wallet), so prepay would be silently inert
        // and credits would simply run out. Reject up front.
        throw new AgentKVError(
          "prepay in account-key mode requires a topoffPayer hook (or fund via fundAccount() / 'agentkv fund')",
          "invalid_config",
          0,
        );
      }
      // prepay.async IS supported in account-key mode — maybeAsyncTopoff()
      // dispatches through the topoffPayer hook (runAccountTopoff), not runDeposit
      // (which has no signing wallet in account mode). See maybeAsyncTopoff() below.
      const topoffAtomic = toWholeAtomicUsd(opts.prepay.topoff);
      if (topoffAtomic === null || !(opts.prepay.topoff >= 1)) {
        throw new AgentKVError(
          "prepay.topoff must be >= $1 (a whole number of atomic USDC units)",
          "invalid_config",
          0,
        );
      }
      if (!(opts.prepay.watermark >= 0)) {
        throw new AgentKVError("prepay.watermark must be >= 0", "invalid_config", 0);
      }
      this.prepay = opts.prepay;
      this.topoffAtomic = topoffAtomic;
    }

    // Discriminate on the VALUE, not mere key presence: `{ privateKey, accountKey:
    // undefined }` (e.g. from a spread config where accountKey is optional) is WALLET
    // mode, not account mode. `"accountKey" in opts` would be true for a present-but-
    // undefined key and wrongly enter account mode (throwing invalid_config).
    if (isAccountMode) {
      // Account-key mode: no signing wallet. The `ak_…` bearer token is the
      // identity. There is no wallet to derive an AES key from, so an explicit
      // `encryptionKey` is REQUIRED and used directly to derive the key material
      // (getKeyMaterial never hits sign-to-derive — there is nothing to sign).
      if (!isAccountKeyFormat(opts.accountKey)) {
        throw new AgentKVError(
          "accountKey must be a string of the form ak_<64 lowercase hex>",
          "invalid_config",
          0,
        );
      }
      if (!opts.encryptionKey) {
        throw new AgentKVError(
          "account-key mode requires an explicit encryptionKey (there is no wallet to derive one from)",
          "invalid_config",
          0,
        );
      }
      this.accountKey = opts.accountKey;
      this.signer = undefined;
      // No wallet address in account-key mode; the account key (its server-side hash)
      // is the namespace. `address` is `undefined` (honest) — never sent on the wire.
      this.address = undefined;
      this._ikm = normalizeEncryptionKey(opts.encryptionKey);
    } else if ("privateKey" in opts && opts.privateKey != null) {
      // Discriminate on the VALUE (not mere presence), mirroring the accountKey guard:
      // `{ ...cfg, privateKey: undefined, signer: validSigner }` must fall through to the
      // signer branch, not enter here and throw a cryptic viem error from
      // privateKeyToAccount(undefined).
      if ("encryptionKey" in opts && opts.encryptionKey) {
        // privateKey mode derives the AES key from the wallet key itself; a caller-supplied
        // encryptionKey would be SILENTLY ignored (data encrypted under a different key than
        // they think). Fail fast — use `{ signer, encryptionKey }` for an explicit key.
        throw new AgentKVError(
          "privateKey mode derives its encryption key from the wallet key; do not also pass " +
            "encryptionKey — use { signer, encryptionKey } for an explicit AES key",
          "invalid_config",
          0,
        );
      }
      this.signer = privateKeyToAccount(opts.privateKey);
      this._ikm = hexToBytes(opts.privateKey); // wallet privkey is the per-wallet HKDF input
      this.address = this.signer.address;
    } else if ("signer" in opts && opts.signer != null) {
      this.signer = opts.signer;
      if ("encryptionKey" in opts && opts.encryptionKey) {
        this._ikm = normalizeEncryptionKey(opts.encryptionKey);
      }
      // else: lazy sign-to-derive in getKeyMaterial()
      this.address = this.signer.address;
    } else {
      // Reached when every auth key is absent OR present-but-nullish (e.g. `accountKey:
      // undefined`, `privateKey: undefined`, or `signer: undefined` from a spread config).
      // Fail with a clear config error instead of a bare TypeError on `this.signer.address`
      // or a cryptic viem error from privateKeyToAccount(undefined).
      throw new AgentKVError(
        "invalid auth config: provide one of { privateKey } | { signer } | { accountKey, encryptionKey }",
        "invalid_config",
        0,
      );
    }
  }

  /**
   * Resolve (and memoize) the AES key. Async only for the sign-to-derive shape
   * (`{signer}` with no encryptionKey): the key is `HKDF` over a fixed-message
   * signature, which is stable ONLY for deterministic ECDSA signers (local keys /
   * RFC-6979). Non-deterministic signers (some MPC/threshold backends) would
   * derive a different key each run and fail to decrypt — those must pass an
   * explicit `encryptionKey`.
   */
  private getKeyMaterial(): Promise<KeyMaterial> {
    if (this._km) return Promise.resolve(this._km);
    if (!this._kmPromise) {
      this._kmPromise = (async () => {
        let ikm = this._ikm;
        if (!ikm) {
          // Sign-to-derive: only the `{signer}` (no explicit key) shape reaches
          // here. Account-key mode always has an explicit `_ikm`, so `signer` is
          // guaranteed present on this branch.
          if (!this.signer) {
            throw new AgentKVError(
              "no encryption key material: account-key mode requires an explicit encryptionKey",
              "invalid_config",
              0,
            );
          }
          const sig = await this.signer.signTypedData({
            domain: ENC_DERIVATION_DOMAIN,
            types: ENC_DERIVATION_TYPES,
            primaryType: "Derive",
            message: ENC_DERIVATION_MESSAGE,
          });
          const sigBytes = hexToBytes(sig);
          // Hash the signature's raw bytes as the HKDF ikm. Require the STANDARD 65-byte ECDSA
          // serialization: a signer that returns a 64-byte EIP-2098 compact form or an
          // ERC-1271/6492 smart-account wrapper blob would derive a DIFFERENT key for the same
          // wallet and silently lose access to prior data. Reject those clearly (they must
          // construct with an explicit encryptionKey). NB: we do NOT normalize the v byte.
          if (sigBytes.length !== 65) {
            throw new AgentKVError(
              `sign-to-derive expected a 65-byte EIP-712 signature but got ${sigBytes.length} bytes; ` +
                "this signer's format is unstable for key derivation — construct with an explicit encryptionKey",
              "invalid_config",
              0,
            );
          }
          ikm = sigBytes;
        }
        const km = deriveKeyMaterial(ikm);
        this._km = km;
        return km;
      })().catch((err) => {
        // Do NOT cache a rejected derivation: a transient signTypedData failure (dismissed
        // wallet prompt, MPC/RPC hiccup) must not permanently brick every future op on this
        // instance. Clear the memo so the next call retries the derivation from scratch.
        this._kmPromise = undefined;
        throw err;
      });
    }
    return this._kmPromise;
  }

  /**
   * Decrypt a value envelope with the current value key, binding the key's blind-index
   * digest into the AAD so a value the server serves for the wrong key fails the auth tag.
   */
  private async decryptValue(packed: string, key: string): Promise<string> {
    const km = await this.getKeyMaterial();
    // Bind the key's blind-index digest into the AAD so a value the server serves for the
    // WRONG key fails the auth tag instead of silently decrypting (substitution defense).
    return decrypt(km.value, packed, hashKey(km.mac, key));
  }

  private assertSpend(usd: number, opts: { bypassPerOpCap?: boolean } = {}): void {
    // Top-offs pass bypassPerOpCap: a credit purchase is not a per-op charge, so
    // the per-call cap (which bounds individual pay-per-op spend) must not gate it
    // — mirroring topoffFitsSessionCap() on the synchronous top-off paths.
    if (!opts.bypassPerOpCap && this.maxSpendUsd !== undefined && usd > this.maxSpendUsd) {
      throw new SpendCapError(`spend $${usd} exceeds per-call cap $${this.maxSpendUsd}`);
    }
    if (
      this.maxSessionSpendUsd !== undefined &&
      this.sessionSpentUsd + usd > this.maxSessionSpendUsd
    ) {
      throw new SpendCapError(
        `spend $${usd} would exceed session cap $${this.maxSessionSpendUsd} (spent $${this.sessionSpentUsd})`,
      );
    }
  }

  private recordSpend(usd: number): void {
    this.sessionSpentUsd += usd;
  }

  /**
   * Reject a SERVER-QUOTED per-op price above a sane ceiling in the DEFAULT (cap-less) config.
   * When `maxSpendUsd` is set, `assertSpend` already bounds the op price; when it is NOT set,
   * a compromised or spoofed worker could otherwise answer a routine $0.005 read with a 402
   * challenge for the wallet's whole balance and the client would sign the EIP-3009
   * authorization. Callers who genuinely need a pricier op opt in via `maxSpendUsd`.
   */
  private assertOpPriceCeiling(usd: number): void {
    if (this.maxSpendUsd === undefined && usd > DEFAULT_MAX_OP_USD) {
      throw new SpendCapError(
        `server-quoted op price $${usd} exceeds the built-in $${DEFAULT_MAX_OP_USD} op ceiling; ` +
          "set maxSpendUsd to allow a higher per-op charge",
      );
    }
  }

  /**
   * The effective per-op ceiling (USD) for an inline-payer op: the caller's `maxSpendUsd`
   * when set (they opted into that bound), else the built-in default ceiling. Handed to the
   * hook as its hard `maxAmountAtomic`, and pre-reserved against the session cap before paying.
   */
  private inlineOpCeilingUsd(): number {
    return this.maxSpendUsd ?? DEFAULT_MAX_OP_USD;
  }

  /**
   * The on-chain settlement txHash from a response's PAYMENT-RESPONSE header, or ""
   * when the server served the op from existing credits (so the attached top-off
   * authorization was NEVER settled — it just expires) or the header is absent. The
   * worker emits PAYMENT-RESPONSE = base64(JSON `{ success, payer, amount, txHash }`)
   * on any paid 200, with `txHash: ""` on the credit hot path. A proactive single-shot
   * top-off must only count toward session spend when this is non-empty — otherwise no
   * USDC moved and recording it inflates sessionSpentUsd, prematurely tripping the cap.
   *
   * Accepted trade-off: in a doubly-rare crash window (the server's settle mined on-chain
   * but its ledger row was lost, AND the response was lost so the client retries), the
   * worker's already-used-authorization recovery returns success with txHash "" even
   * though USDC did move. The client then under-counts that top-off by one, making the
   * local session cap marginally lenient — no funds are lost (the amount is still minted
   * as credits). This is unavoidable (the worker cannot distinguish that case from a
   * plain credit-served op) and far cheaper than the systematic L3 over-count it replaces.
   */
  private settledTxHash(res: Response): string {
    const header = res.headers.get("PAYMENT-RESPONSE");
    if (!header) return "";
    try {
      // UTF-8 decode to mirror the backend's base64/UTF-8 encoding (see decodeBase64Utf8).
      const parsed = JSON.parse(decodeBase64Utf8(header)) as { txHash?: unknown };
      return typeof parsed.txHash === "string" ? parsed.txHash : "";
    } catch {
      return "";
    }
  }

  /**
   * Issue a request with bounded internal retry on TRANSIENT failures only: a
   * thrown fetch (network error / lost response) or a 5xx. `build()` is re-invoked
   * per attempt so the credit path can re-sign identity with a FRESH nonce each
   * time, while the op's stable Idempotency-Key (and pinned EIP-3009 nonce on paid
   * ops) makes a retry of an already-processed request dedupe server-side — so a
   * lost response that the server already charged is recovered without a second
   * charge. NOT retried: any 2xx/4xx (incl. the 402 credit->pay handoff, 401, 404)
   * — those are returned as-is for the caller's normal handling. The bound is kept
   * small so a re-sent paid authorization cannot outlive its validBefore.
   *
   * The retry MECHANICS (transient-status detection, backoff,
   * Retry-After honoring) were extracted to `@agentx402-ai/core`'s `fetchWithRetry`
   * as a pure function parameterized by `maxRetries` — this method is now a
   * thin delegating wrapper so every existing `this.fetchWithRetry(...)` call
   * site above is unchanged.
   */
  private fetchWithRetry(
    url: string,
    build: () => RequestInit | Promise<RequestInit>,
  ): Promise<Response> {
    return fetchWithRetry(url, build, this.maxRetries, {
      timeoutMs: this.timeoutMs,
      fetchImpl: this.fetchImpl,
    });
  }

  // --- Discounted Prepay helpers -------------------------------------------

  /**
   * Update prepay tracking from any server response. Reads the exact integer
   * credit balance (`X-AgentKV-Credits-Remaining`) and caches the most recent
   * `PAYMENT-REQUIRED` challenge as the proactive single-shot template (so a
   * top-off needs no preflight request). Safe to call when prepay is disabled.
   */
  private trackBalance(res: Response): void {
    const credits = res.headers.get("X-AgentKV-Credits-Remaining");
    if (credits !== null && credits !== "") {
      const n = Number(credits);
      if (Number.isFinite(n)) this.knownCredits = n;
    }
    const challenge = res.headers.get("PAYMENT-REQUIRED");
    if (challenge) this.challengeTemplate = challenge;
  }

  /** Watermark (USD) expressed in EXACT integer credits (1 credit = CREDIT_VALUE_USD = $0.0001,
   *  so $1 = 10,000 credits — matching the worker's mint rate). */
  private watermarkCredits(): number {
    return Math.round(this.prepay!.watermark / CREDIT_VALUE_USD);
  }

  /**
   * Synchronous single-flight claim for a proactive top-off. CRITICAL: there is
   * NO `await` between the watermark check and setting `topoffInFlight = true`,
   * and this must be called at the very top of set/get before any await.
   * Otherwise two concurrent ops both pass the check and each fire a separate
   * top-off with distinct fresh nonces the server can't dedupe (double charge).
   * Returns true for exactly one concurrent op below the watermark; the caller
   * MUST clear `topoffInFlight` in a `finally`. Losers take the identity path.
   */
  private tryClaimTopoff(): boolean {
    if (
      !this.prepay ||
      this.prepay.async ||
      this.topoffInFlight ||
      this.knownCredits === undefined ||
      this.knownCredits >= this.watermarkCredits()
    ) {
      return false;
    }
    this.topoffInFlight = true;
    return true;
  }

  /**
   * Single-flight claim at a hard 402 (insufficient credits). Unlike
   * `tryClaimTopoff` this ignores the watermark — a 402 already proves credits
   * are short — but still claims the flag synchronously so concurrent 402s don't
   * each fire a top-off. Returns true only if the flag was free; the caller MUST
   * clear it in a `finally`. In `async` mode we leave the 402 to be paid at the
   * op price (the background deposit replenishes credits separately).
   */
  private tryClaimTopoffOnFault(): boolean {
    if (!this.prepay || this.prepay.async || this.topoffInFlight) return false;
    this.topoffInFlight = true;
    return true;
  }

  /**
   * Run a synchronous account-mode top-off while PUBLISHING its in-flight promise, so a
   * concurrent op that hits a hard 402 (and can't claim the single-flight) can await THIS
   * deposit and retry rather than surfacing the 402. The caller holds the single-flight claim.
   */
  private async runSharedTopoff(): Promise<void> {
    const p = this.runAccountTopoff();
    this.topoffPromise = p;
    try {
      await p;
    } finally {
      if (this.topoffPromise === p) this.topoffPromise = undefined;
    }
  }

  /**
   * Detached async top-off (opt-in via `prepay.async`). When below the watermark
   * and no top-off is in flight, fire a deposit WITHOUT awaiting it in the op
   * path. Documented races: the balance read is point-in-time so the trigger can
   * be stale, and a deposit settling between an op's read and this check can make
   * the top-off redundant; the single-flight flag bounds these to at most one
   * outstanding deposit, but cannot serialize against an op already past its own
   * check. Use the (default) synchronous single-shot for exactly-bounded spend.
   *
   * Account-key mode: there is no signing wallet, so the detached
   * deposit is dispatched through `runAccountTopoff()` (the `topoffPayer` hook)
   * instead of `runDeposit` (which throws `no_signer` in account mode). Wallet
   * mode is completely unchanged below.
   */
  private maybeAsyncTopoff(): void {
    if (
      !this.prepay?.async ||
      this.topoffInFlight ||
      this.knownCredits === undefined ||
      this.knownCredits >= this.watermarkCredits()
    ) {
      return;
    }
    // Budget: a top-off is checked against the SESSION cap only (never the per-op
    // cap). If it would exceed the session cap, skip rather than throw.
    if (
      this.maxSessionSpendUsd !== undefined &&
      this.sessionSpentUsd + this.prepay.topoff > this.maxSessionSpendUsd
    ) {
      return;
    }
    this.topoffInFlight = true;
    if (this.accountKey) {
      // Account-key mode: no signing wallet — dispatch the SAME payer hook the
      // synchronous paths use. A hook failure is swallowed (crash-safe, mirrors
      // the wallet-mode runDeposit catch below); the next op's 402 retries it.
      void this.runAccountTopoff()
        .catch(() => {})
        .finally(() => {
          this.topoffInFlight = false;
        });
      return;
    }
    // Detached + crash-safe: bypass the per-op cap (a top-off is a credit purchase,
    // not a per-op charge) AND swallow any rejection (cap race, network, server)
    // so a failed background top-off never becomes an unhandled rejection that
    // crashes the host — the next op's 402 retries it. deposit() recordSpends itself.
    void this.runDeposit(this.prepay.topoff, { bypassPerOpCap: true })
      .catch(() => {})
      .finally(() => {
        this.topoffInFlight = false;
      });
  }

  /**
   * Whether a top-off of `prepay.topoff` fits under the cumulative SESSION cap.
   * Top-offs are deliberately NOT gated on the per-op `maxSpendUsd` (which bounds
   * individual pay-per-op charges); when over the session cap we downgrade to
   * pay-per-op rather than throwing.
   */
  private topoffFitsSessionCap(): boolean {
    if (this.maxSessionSpendUsd === undefined) return true;
    return this.sessionSpentUsd + this.prepay!.topoff <= this.maxSessionSpendUsd;
  }

  /**
   * Single source of truth for BOTH the EIP-712-signed pathname (`path`) and the
   * URL to fetch (`url`), so they can never diverge — a divergence silently
   * breaks identity auth: the worker verifies over the RECEIVED path and
   * recovers a phantom address if it differs from what the client signed.
   * `base` is the un-prefixed pathname; the fetched/signed path is `/v1` + `base`
   * (list-keys overrides it to `/v1/kv`). `query` is appended to `url`
   * ONLY — EIP-712 binds the pathname, never the query string.
   */
  private route(spec: { base: string; versioned?: string; query?: string }): {
    path: string;
    url: string;
  } {
    const path = spec.versioned ?? `${V1}${spec.base}`;
    const q = spec.query ? `?${spec.query}` : "";
    return { path, url: `${this.endpoint}${path}${q}` };
  }

  // kv entry route (set/get/delete). `digest` is base64url (from hashKey(), which
  // returns toBase64Url output — URL-safe [A-Za-z0-9_-], not hex), so no extra
  // encoding is needed and the signed path matches the fetched path byte-for-byte.
  private kvRoute(digest: string): { path: string; url: string } {
    return this.route({ base: `/kv/${digest}` });
  }

  /**
   * Per-op auth headers. In account-key mode this is the `Authorization: Bearer
   * ak_…` header (server hashes it to name storage + debit credits); in wallet
   * mode it is the EIP-712 identity signature. Used by every op so the same call
   * site picks the right scheme. Async to share the signature of `identityHeaders`.
   */
  private async authHeaders(method: string, path: string): Promise<Record<string, string>> {
    if (this.accountKey) return buildBearerHeaders(this.accountKey);
    return { ...(await this.identityHeaders(method, path)) };
  }

  /**
   * The signing wallet, asserted present. Every x402 path (set/get top-off + 402
   * fallback, deposit) is gated behind `!this.accountKey` and so always has a
   * signer; this narrows the optional type at those call sites (and fails loudly
   * if that invariant is ever broken).
   */
  private requireSigner(): Signer {
    if (!this.signer) {
      throw new AgentKVError(
        "no signer: this operation requires a signing wallet",
        "invalid_config",
        0,
      );
    }
    return this.signer;
  }

  /** EIP-712 identity headers with the deployment host bound into the signature (prevents cross-deployment signature replay). */
  private identityHeaders(method: string, path: string) {
    if (!this.signer) {
      // Unreachable in account-key mode (those ops use the bearer path); a guard
      // so the wallet-only signing surface never silently no-ops.
      throw new AgentKVError(
        "no signer: this operation requires a signing wallet",
        "invalid_config",
        0,
      );
    }
    return buildIdentityHeaders(this.signer, {
      method,
      path,
      host: new URL(this.endpoint).host,
      network: this.network,
    });
  }

  /**
   * Shared money/transport orchestrator behind set() and getInternal() — the single copy of
   * the flow both share: account-key (bearer) mode with proactive + hard-402 top-off and the
   * inline-payer path; wallet mode with the proactive single-shot, credit path, and 402
   * pay-and-retry — including the single-flight top-off accounting and settled-txHash spend
   * gating. Per-op differences (method/body, credit cost, 404 handling, success/inline
   * parsing) come from `spec`. The CALLER must claim the single-flight top-off SYNCHRONOUSLY
   * (before any await) and pass it in `flight`; it may be re-claimed here on a cold-start hard
   * 402, and the caller's `finally` releases it.
   */
  private async performOp<T>(
    flight: { claimed: boolean },
    spec: {
      method: "POST" | "GET";
      path: string;
      url: string;
      idempotencyKey: string;
      creditCostUsd: number;
      label: string;
      buildRequest: (headers: Record<string, string>) => RequestInit;
      parseSuccess: (res: Response) => Promise<T>;
      parseInline: (inlineRes: OpInlineResponse) => Promise<T>;
      /** Return value for a 404 (get: `{ value: null }`); omitted for set (404 -> error). */
      notFound?: () => T;
    },
  ): Promise<T> {
    const { path, url, idempotencyKey, creditCostUsd, label } = spec;

    // Account-key mode: bearer auth debits prepaid credits server-side. No x402/EIP-712 — a
    // 402 (insufficient credits) carries no challenge. Cap the spend at the credit cost.
    if (this.accountKey) {
      // Request-scoped: true once a top-off DEPOSIT actually succeeded for THIS op — bounds
      // spend to at most one real on-chain deposit per op (see the hard-402 guard below).
      let toppedOff = false;
      // Proactive watermark top-off (single-flight claim held): delegate to the payer hook. A
      // failure here is NON-fatal (credits may still cover the op; the hard-402 path below
      // surfaces a real shortfall). Not setting toppedOff on a failed proactive deposit is
      // deliberate: it deposited nothing, so the hard-402 path may still try exactly one.
      if (flight.claimed && this.topoffPayer && this.topoffFitsSessionCap()) {
        try {
          await this.runSharedTopoff();
          toppedOff = true;
        } catch {
          // swallowed by design (proactive path); the op continues on remaining credits.
        }
      }
      this.maybeAsyncTopoff();
      this.assertSpend(creditCostUsd);
      const sendBearer = () =>
        this.fetchWithRetry(url, () =>
          spec.buildRequest({
            "Idempotency-Key": idempotencyKey,
            ...buildBearerHeaders(this.accountKey!),
          }),
        );
      let res = await sendBearer();
      this.trackBalance(res);
      // Hard 402: with a payer hook, buy a top-off and retry ONCE (same key = exactly-once).
      // Skipped after a successful proactive deposit (`!toppedOff`) so at most one deposit/op.
      if (res.status === 402 && this.topoffPayer && !toppedOff) {
        if (!flight.claimed) flight.claimed = this.tryClaimTopoffOnFault();
        if (flight.claimed && this.topoffFitsSessionCap()) {
          await this.runSharedTopoff();
          res = await sendBearer();
          this.trackBalance(res);
        } else if (this.topoffPromise) {
          // A concurrent op won the single-flight and is depositing RIGHT NOW: rather than
          // surface this 402 (a deposit is landing), await that sibling's top-off and retry
          // the bearer ONCE — the same Idempotency-Key keeps it exactly-once.
          await this.topoffPromise.catch(() => {});
          res = await sendBearer();
          this.trackBalance(res);
        }
      }
      // Inline opt-in: route the WHOLE op through an external x402 transport (e.g. awal)
      // instead of a credit top-off. Mutually exclusive with topoffPayer PER OP.
      if (res.status === 402 && this.opInlinePayer && !this.topoffPayer) {
        // Bootstrap gating (spec 2026-07-10): an account_not_provisioned 402 is
        // payable, but auto-funding it can silently fund a TYPO'D key — require
        // the explicit opt-in. insufficient_credits (provisioned account) keeps
        // firing unconditionally, as before. Clone before reading: `res` may
        // still need to be read by asError()/errorFromBody() below on other
        // branches, and a Response body can only be consumed once.
        const errBody = (await res
          .clone()
          .json()
          .catch(() => undefined)) as { code?: string } | undefined;
        if (errBody?.code === "account_not_provisioned" && !this.bootstrap) {
          throw new AgentKVError(
            "account not provisioned — deposit (fundAccount() / agentkv deposit) or opt in to " +
              "pay-per-call bootstrap (bootstrap: true / AGENTKV_BOOTSTRAP=1)",
            "account_not_provisioned",
            402,
          );
        }
        // Bound by the caller's per-op cap and pre-reserve against the session cap BEFORE
        // paying — the credit-cost pre-flight only checked the credit price, not real USDC.
        const inlineCeilingUsd = this.inlineOpCeilingUsd();
        this.assertSpend(inlineCeilingUsd);
        const reqInit = spec.buildRequest({
          "Idempotency-Key": idempotencyKey,
          ...buildBearerHeaders(this.accountKey!),
        });
        const inlineRes = await this.opInlinePayer({
          url,
          method: spec.method,
          body: reqInit.body as string | undefined,
          headers: reqInit.headers as Record<string, string>,
          // The hook MUST NOT settle more than the effective per-op ceiling.
          maxAmountAtomic: Math.round(inlineCeilingUsd * 1_000_000),
        });
        if (inlineRes.status === 404 && spec.notFound) return spec.notFound();
        if (inlineRes.status < 200 || inlineRes.status >= 300) {
          throw this.errorFromBody(inlineRes.status, inlineRes.body, label);
        }
        this.recordSpend(this.inlineSettledAmountUsd(inlineRes.headers) ?? creditCostUsd);
        return spec.parseInline(inlineRes);
      }
      if (res.status === 404 && spec.notFound) return spec.notFound();
      if (!res.ok) throw await this.asError(res, label);
      this.recordSpend(creditCostUsd);
      return spec.parseSuccess(res);
    }

    // 0) Wallet-mode proactive single-shot top-off (claim held): pay a >=$1 top-off on THIS op
    //    from the cached challenge template. Cold start (no template) -> identity path below.
    if (flight.claimed && this.challengeTemplate && this.topoffFitsSessionCap()) {
      let paymentSignature: string | undefined;
      try {
        paymentSignature = await buildPaymentHeader(this.requireSigner(), this.challengeTemplate, {
          amountAtomic: this.topoffAtomic,
          expectedNetwork: this.network,
          // Pin the nonce to the op's idempotency key so a retry reuses the auth and the
          // server dedupes the mint + the op.
          nonce: nonceFromIdempotencyKey(idempotencyKey),
        });
      } catch {
        // Corrupted/stale cached template or a network-pin failure: clear it and fall through
        // to the identity path (the hard-402 fallback refreshes the template).
        this.challengeTemplate = undefined;
      }
      if (paymentSignature !== undefined) {
        const res = await this.fetchWithRetry(url, () =>
          spec.buildRequest({
            "Idempotency-Key": idempotencyKey,
            "PAYMENT-SIGNATURE": paymentSignature as string,
          }),
        );
        this.trackBalance(res);
        if (res.status === 404 && spec.notFound) return spec.notFound();
        // A 402 means the cached template was stale (trackBalance just refreshed it): fall
        // through to the identity/credit path, self-healing on THIS call (same held claim).
        if (res.status !== 402) {
          if (!res.ok) throw await this.asError(res, label);
          // Count the top-off ONLY if it actually settled on-chain (non-empty PAYMENT-RESPONSE
          // txHash) — a credit-served op settles nothing; single-flight => at most once.
          if (this.settledTxHash(res)) this.recordSpend(this.prepay!.topoff);
          return spec.parseSuccess(res);
        }
      }
    }

    // Async mode: kick off a detached background deposit (opt-in, not awaited).
    this.maybeAsyncTopoff();

    // 1) Credit path: an EIP-712 identity signature spends pre-paid credits with no on-chain
    //    settlement. Re-sign identity with a FRESH nonce per transient retry; the stable
    //    Idempotency-Key carries dedup.
    let res = await this.fetchWithRetry(url, async () =>
      spec.buildRequest({
        "Idempotency-Key": idempotencyKey,
        ...(await this.identityHeaders(spec.method, path)),
      }),
    );
    this.trackBalance(res);

    // 2) Insufficient credits -> 402 x402 challenge: pay and retry with the same key.
    if (res.status === 402) {
      const challenge = res.headers.get("PAYMENT-REQUIRED");
      if (!challenge) {
        throw await this.asError(res, "payment required but no PAYMENT-REQUIRED challenge");
      }
      // Prepay hard-402 fallback: pay a TOP-OFF (>=$1) instead of the op price. Claim the
      // single-flight now if we didn't already (cold start). Over the session cap -> pay-per-op.
      if (!flight.claimed) flight.claimed = this.tryClaimTopoffOnFault();
      const topoffHere = flight.claimed && this.topoffFitsSessionCap();
      const usd = topoffHere
        ? this.prepay!.topoff
        : challengePriceUsd(challenge, undefined, this.network);
      if (!topoffHere) {
        this.assertOpPriceCeiling(usd);
        this.assertSpend(usd);
      }
      // Pin the EIP-3009 nonce to the idempotency key so a retried op reuses the same
      // authorization and the server dedupes. Re-send the identical signed header on retry.
      const paymentSignature = await buildPaymentHeader(this.requireSigner(), challenge, {
        amountAtomic: topoffHere ? this.topoffAtomic : undefined,
        expectedNetwork: this.network,
        nonce: nonceFromIdempotencyKey(idempotencyKey),
      });
      res = await this.fetchWithRetry(url, () =>
        spec.buildRequest({
          "Idempotency-Key": idempotencyKey,
          "PAYMENT-SIGNATURE": paymentSignature,
        }),
      );
      this.trackBalance(res);
      // Settlement gate (L3): count a TOP-OFF only when it settled (non-empty txHash); a
      // concurrent sibling can mint credits between the 402 and the retry (txHash ""). The
      // op-price branch (!topoffHere) stays on res.ok — it is the real op cost.
      if (res.ok && (!topoffHere || this.settledTxHash(res))) this.recordSpend(usd);
    }

    if (res.status === 404 && spec.notFound) return spec.notFound();
    if (!res.ok) throw await this.asError(res, label);
    return spec.parseSuccess(res);
  }

  /**
   * Write an encrypted value. The value is JSON-stringified and AES-256-GCM
   * encrypted client-side; the server only ever stores ciphertext. `null` and
   * `undefined` are rejected (`invalid_value`) so a `null` from get() unambiguously
   * means "missing key" — use delete() to remove a key. Tries the credit path first
   * (EIP-712 identity signature); if credits are insufficient the server returns a 402
   * x402 challenge and the client pays. A stable Idempotency-Key is reused across that
   * retry so the write is exactly-once.
   */
  async set(key: string, value: unknown, opts: SetOptions = {}): Promise<SetResult> {
    // CRITICAL single-flight: claim a proactive top-off SYNCHRONOUSLY, before any
    // await (encryption etc.). Exactly one concurrent op below the watermark wins.
    // The claim may also be taken later at a hard 402 (cold-start fallback) inside performOp().
    const flight = { claimed: this.tryClaimTopoff() };
    try {
      const plaintext = JSON.stringify(value);
      // Reject null/undefined (and anything that stringifies to undefined: functions,
      // symbols). Stored values are always a defined JSON value, so a null from get()
      // unambiguously means "missing key" — never "a stored null". Use delete() to remove.
      if (value === null || plaintext === undefined) {
        throw new AgentKVError(
          "cannot store null or undefined; use delete() to remove a key",
          "invalid_value",
          0,
        );
      }
      const km = await this.getKeyMaterial();
      // Hide the key NAME too: address the server by an opaque per-wallet digest and
      // ship the encrypted name alongside (for list-keys) — never the plaintext name.
      const digest = hashKey(km.mac, key);
      // Bind the digest into the value's AAD so the server can't later serve this ciphertext
      // for a DIFFERENT key's request without failing the auth tag (substitution defense).
      const ciphertext = await encrypt(km.value, plaintext, digest);
      const body: Record<string, unknown> = {
        value: ciphertext,
        key_name: await encrypt(km.keyName, key),
      };
      // camelCase API option -> snake_case wire field.
      if (opts.ttlDays !== undefined) body.ttl_days = opts.ttlDays;
      if (opts.strictTtl !== undefined) body.strict_ttl = opts.strictTtl;
      const payload = JSON.stringify(body);

      const idempotencyKey = opts.idempotencyKey ?? freshNonce();
      const { path, url } = this.kvRoute(digest);

      return await this.performOp<SetResult>(flight, {
        method: "POST",
        path,
        url,
        idempotencyKey,
        creditCostUsd: ACCOUNT_WRITE_USD,
        label: "set failed",
        buildRequest: (headers) => ({
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: payload,
        }),
        parseSuccess: async (res) => (await res.json()) as SetResult,
        parseInline: async (inlineRes) => JSON.parse(inlineRes.body) as SetResult,
      });
    } finally {
      if (flight.claimed) this.topoffInFlight = false;
    }
  }

  /**
   * Read and decrypt a value. Tries the credit path first (EIP-712 identity);
   * if credits are insufficient the server returns a 402 x402 challenge and the
   * client pays, then retries. Returns null if the key is missing or expired (404);
   * stored values are never null (set rejects it), so null unambiguously means absent.
   */
  async get<T = unknown>(key: string, opts: GetOptions = {}): Promise<T | null> {
    const { value } = await this.getInternal<T>(key, opts);
    return value;
  }

  /**
   * Like `get`, but ALSO surfaces the machine-readable usage envelope the server
   * attaches to a paid read's success body — a separate, additive
   * accessor so `get()` keeps its narrower `T | null` signature (no existing
   * caller breaks). `usage` is absent when the key was missing/expired (404 —
   * the read op itself is never charged on a miss, see the DO's 404-before-charge
   * precheck — though a proactive top-off, if one was triggered for this call,
   * is a separate deposit charge and can still happen alongside a miss) or when
   * talking to a server that predates the usage envelope.
   */
  async getWithUsage<T = unknown>(
    key: string,
    opts: GetOptions = {},
  ): Promise<{ value: T | null; usage?: UsageBlock }> {
    return this.getInternal<T>(key, opts);
  }

  /**
   * Shared implementation behind `get`/`getWithUsage`. Tries the credit path
   * first (EIP-712 identity); if credits are insufficient the server returns a
   * 402 x402 challenge and the client pays, then retries. `value` is null if
   * the key is missing or expired (404); stored values are never null (set
   * rejects it), so null unambiguously means absent.
   */
  private async getInternal<T = unknown>(
    key: string,
    opts: GetOptions = {},
  ): Promise<{ value: T | null; usage?: UsageBlock }> {
    // CRITICAL single-flight: claim a proactive top-off SYNCHRONOUSLY, before any
    // await. Exactly one concurrent op below the watermark wins; losers read.
    // The claim may also be taken later at a hard 402 (cold-start fallback) inside performOp().
    const flight = { claimed: this.tryClaimTopoff() };
    try {
      const digest = hashKey((await this.getKeyMaterial()).mac, key);
      const { path, url } = this.kvRoute(digest);
      // Stable per-op key (fresh per call unless the caller supplies one): sent as
      // Idempotency-Key on the credit path and pinned into the EIP-3009 nonce on the
      // paid path, so an internal retry of a lost-response read dedupes server-side
      // (the read idempotency record returns the cached value) instead of charging
      // twice. Two SEPARATE get()s still use distinct keys (separately charged).
      const idempotencyKey = opts.idempotencyKey ?? freshNonce();
      const parseBody = async (raw: string): Promise<{ value: T | null; usage?: UsageBlock }> => {
        const data = JSON.parse(raw) as { value: string; usage?: UsageBlock };
        const decryptedText = await this.decryptValue(data.value, key);
        return { value: JSON.parse(decryptedText) as T, usage: data.usage };
      };

      return await this.performOp<{ value: T | null; usage?: UsageBlock }>(flight, {
        method: "GET",
        path,
        url,
        idempotencyKey,
        creditCostUsd: ACCOUNT_READ_USD,
        label: "get failed",
        buildRequest: (headers) => ({ method: "GET", headers }),
        parseSuccess: async (res) => parseBody(await res.text()),
        parseInline: async (inlineRes) => parseBody(inlineRes.body),
        notFound: () => ({ value: null }),
      });
    } finally {
      if (flight.claimed) this.topoffInFlight = false;
    }
  }

  /**
   * Delete a key. Free operation. Authenticated with the account-key bearer in
   * account mode, else an EIP-712 identity signature (fresh nonce + timestamp).
   * The digest is computed from the local key material either way.
   */
  async delete(key: string): Promise<DeleteResult> {
    const digest = hashKey((await this.getKeyMaterial()).mac, key);
    const { path, url } = this.kvRoute(digest);
    // Route through fetchWithRetry (consistent with set/get/deposit): re-sign identity
    // with a FRESH nonce per attempt so a transient 5xx/network retry is not a replay.
    const res = await this.fetchWithRetry(url, async () => ({
      method: "DELETE",
      headers: { ...(await this.authHeaders("DELETE", path)) },
    }));
    if (!res.ok) {
      throw await this.asError(res, "delete failed");
    }
    return (await res.json()) as DeleteResult;
  }

  /**
   * List the wallet's keys. The server returns opaque per-wallet digests plus each key's
   * ENCRYPTED name; this decrypts the names locally and returns them — the server never
   * sees a plaintext key name. Free (EIP-712 identity signed). Paginated: pass the returned
   * `cursor` to fetch the next page; `cursor` is null once exhausted.
   */
  async listKeys(
    opts: { cursor?: string | null; limit?: number } = {},
  ): Promise<{ keys: string[]; cursor: string | null }> {
    const km = await this.getKeyMaterial();
    // EIP-712 binds the pathname only (query excluded); the v1 canonical list path is
    // `/v1/kv` (NOT `/v1/list-keys`), so the versioned pathname is given explicitly.
    const params = new URLSearchParams();
    if (opts.cursor) params.set("cursor", opts.cursor);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    const qs = params.toString();
    const { path, url } = this.route({
      base: "/list-keys",
      versioned: `${V1}/kv`,
      query: qs || undefined,
    });
    // Route through fetchWithRetry (consistent with set/get/deposit): re-sign identity
    // with a FRESH nonce per attempt so a transient retry is not a nonce replay.
    const res = await this.fetchWithRetry(url, async () => ({
      method: "GET",
      headers: { ...(await this.authHeaders("GET", path)) },
    }));
    if (!res.ok) throw await this.asError(res, "list-keys failed");
    const data = (await res.json()) as {
      items: { key: string; key_name: string | null }[];
      cursor: string | null;
    };
    // Decrypt each encrypted name locally (legacy entries without one are skipped). Tolerate
    // a single undecryptable name (an entry written under a rotated key, or a corrupted
    // key_name blob): skip it rather than reject the whole listing, so one bad row can't make
    // every healthy key unlistable (and undiscoverable for cleanup).
    const keys = (
      await Promise.all(
        data.items
          .filter((i): i is { key: string; key_name: string } => i.key_name != null)
          .map(async (i) => {
            try {
              return await decrypt(km.keyName, i.key_name);
            } catch {
              return null;
            }
          }),
      )
    ).filter((k): k is string => k !== null);
    return { keys, cursor: data.cursor };
  }

  /**
   * Read the pre-paid credit balance. Free. Account-key bearer in account mode,
   * else an EIP-712 identity signature.
   */
  async balance(): Promise<number> {
    const { path, url } = this.route({ base: "/credits/balance" });
    // Route through fetchWithRetry (consistent with set/get/deposit): re-sign identity
    // with a FRESH nonce per attempt so a transient retry is not a nonce replay.
    const res = await this.fetchWithRetry(url, async () => ({
      method: "GET",
      headers: { ...(await this.authHeaders("GET", path)) },
    }));
    this.trackBalance(res);
    if (!res.ok) {
      throw await this.asError(res, "balance failed");
    }
    const body = (await res.json()) as { balance: number };
    // Authoritative balance from the body keeps prepay tracking exact even when
    // the header is absent (e.g. a CORS-stripped header on some transports).
    if (this.prepay && Number.isFinite(body.balance)) this.knownCredits = body.balance;
    return body.balance;
  }

  /**
   * Buy credits with an x402 payment. `amountUsd` must be at least $1; any
   * amount is accepted (no fixed tiers). This settles on-chain once via the
   * facilitator; the returned credits are then spendable by set/get with no
   * further payment.
   */
  async deposit(
    amountUsd: number,
    opts: { idempotencyKey?: string; expectedPayTo?: string } = {},
  ): Promise<DepositResult> {
    // Public API always honors the per-op cap. The internal top-off path
    // (maybeAsyncTopoff) calls runDeposit() directly to bypass it — the bypass is
    // not part of the public surface, so a caller can't disable their own cap.
    //
    // Account-key mode: there is no signing wallet to run runDeposit()'s
    // x402 flow. With a configured topoffPayer, alias to it instead — symmetric
    // with wallet-mode deposit(): ask the hook to buy `amountUsd` of credits, then
    // report the resulting balance. This works even though deposit() may be
    // called with no `prepay` configured (runAccountTopoff's explicit-amount path
    // does not touch `prepay`). Without a topoffPayer, fall through unchanged to
    // runDeposit()'s existing no_signer error below — account-key mode has no
    // other in-SDK way to pay.
    if (this.accountKey && this.topoffPayer) {
      const runAccountDeposit = async (): Promise<DepositResult> => {
        this.assertSpend(amountUsd);
        await this.runAccountTopoff(amountUsd);
        const balance = await this.balance();
        return { credits_added: Math.round(amountUsd / CREDIT_VALUE_USD), balance };
      };
      if (this.topoffInFlight) {
        return runAccountDeposit();
      }
      this.topoffInFlight = true;
      try {
        return await runAccountDeposit();
      } finally {
        this.topoffInFlight = false;
      }
    }

    // Claim the top-off single-flight for the deposit's duration so a concurrent op's
    // watermark top-off can't fire a SECOND on-chain purchase while this deposit is
    // settling (knownCredits stays stale-low until runDeposit refreshes it). If a top-off
    // is already in flight, or prepay is off, just run — no extra guard needed.
    if (!this.prepay || this.topoffInFlight) {
      return this.runDeposit(amountUsd, opts);
    }
    this.topoffInFlight = true;
    try {
      return await this.runDeposit(amountUsd, opts);
    } finally {
      this.topoffInFlight = false;
    }
  }

  /**
   * Account-key top-off: delegate payment of `${endpoint}/account/deposit` to the
   * configured `topoffPayer` (a managed account has no signing wallet to sign an
   * x402 payment). The caller must hold the single-flight claim and have checked
   * `topoffFitsSessionCap()`. On resolve (= the deposit SETTLED) the top-off is
   * recorded against the session budget only — top-offs are credit purchases, not
   * per-op charges, so the per-op cap is deliberately not consulted (mirrors the
   * wallet-mode top-off budget rules). A rejection is wrapped as
   * `account_topoff_failed`; the ak_ bearer is never included in the message.
   */
  /**
   * `amountUsd` generalizes this beyond the fixed `prepay.topoff` amount
   * so `deposit()` can reuse it for a caller-chosen amount. OMITTED (the no-arg
   * call from the proactive/hard-402/async paths above), it defaults to
   * `prepay.topoff` and its precomputed `topoffAtomic` ceiling — BYTE-FOR-BYTE the
   * stage-1 behavior. An EXPLICIT `amountUsd` (from `deposit()`, which may be
   * called with no `prepay` configured at all) is validated here the same way
   * `runDeposit` validates its wallet-mode amount, since it never passed through
   * the constructor's `prepay.topoff` guard.
   */
  private async runAccountTopoff(amountUsd?: number): Promise<void> {
    let amount: number;
    let maxAmountAtomic: number;
    if (amountUsd === undefined) {
      amount = this.prepay!.topoff;
      maxAmountAtomic = this.topoffAtomic;
    } else {
      const atomic = toWholeAtomicUsd(amountUsd);
      if (atomic === null || !(amountUsd >= 1)) {
        throw new AgentKVError(
          "amountUsd must be >= $1 and a whole number of atomic USDC units",
          "invalid_config",
          0,
        );
      }
      amount = amountUsd;
      maxAmountAtomic = atomic;
    }
    try {
      await this.topoffPayer!({
        depositUrl: this.route({ base: "/account/deposit" }).url,
        accountKey: this.accountKey!,
        amountUsd: amount,
        maxAmountAtomic,
      });
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new AgentKVError(
        `account top-off failed: ${detail} — check the payer wallet's USDC balance (e.g. 'awal balance'; fund by sending USDC to its address)`,
        "account_topoff_failed",
        0,
      );
    }
    this.recordSpend(amount);
  }

  private async runDeposit(
    amountUsd: number,
    opts: { bypassPerOpCap?: boolean; idempotencyKey?: string; expectedPayTo?: string },
  ): Promise<DepositResult> {
    // Account-key mode has NO signing wallet, so it cannot sign an x402 payment. This is
    // only reached when NO topoffPayer is configured — deposit() aliases to the payer
    // hook instead of runDeposit when one is set (see deposit() above). Fund it
    // instead: fundAccount(payer, amountUsd) is the in-SDK path (an external payer wallet
    // credits this account's namespace); the CLI/awal routes remain for out-of-process funding.
    if (this.accountKey) {
      throw new AgentKVError(
        "Account-key mode has no signing wallet. Fund this account with " +
          "fundAccount(payerKeyOrSigner, amountUsd), or via 'agentkv fund', or awal: " +
          `awal x402 pay ${this.route({ base: "/account/deposit" }).url} --headers '{"Authorization":"Bearer <ak>"}'.`,
        "no_signer",
        0,
      );
    }
    // Validate to a whole number of atomic USDC units before any network call —
    // the server's only check is the >= $1 floor, so a fractional amount (e.g.
    // 1.0000001) would otherwise reach the facilitator and 400 with a cryptic
    // error. Mirrors the prepay.topoff guard in the constructor.
    const amountAtomic = toWholeAtomicUsd(amountUsd);
    if (amountAtomic === null || !(amountUsd >= 1)) {
      throw new AgentKVError(
        "deposit amountUsd must be >= $1 and a whole number of atomic USDC units",
        "invalid_config",
        0,
      );
    }
    this.assertSpend(amountUsd, opts);
    // Stable per-deposit key: pin the EIP-3009 nonce to it so a transient retry of a
    // settled-but-unacked deposit reuses the authorization and the server dedupes
    // (replaying the prior result, or rejecting the already-used authorization)
    // instead of settling + minting twice.
    // Caller-supplied key makes a caller-level retry of a settled-but-unacked deposit safe
    // (the pinned nonce dedupes server-side); else a fresh key per call.
    const opKey = opts.idempotencyKey ?? freshNonce();
    const { url } = this.route({ base: "/credits/deposit" });
    // First request triggers a 402 challenge; then we sign the payment.
    let res = await this.fetchWithRetry(url, () => ({
      method: "POST",
      headers: { "Idempotency-Key": opKey },
    }));
    this.trackBalance(res);
    if (res.status === 402) {
      const challenge = res.headers.get("PAYMENT-REQUIRED");
      if (!challenge) {
        throw await this.asError(res, "payment required but no PAYMENT-REQUIRED challenge");
      }
      const paymentSignature = await buildPaymentHeader(this.requireSigner(), challenge, {
        amountAtomic,
        expectedNetwork: this.network,
        expectedPayTo: opts.expectedPayTo,
        nonce: nonceFromIdempotencyKey(opKey),
      });
      res = await this.fetchWithRetry(url, () => ({
        method: "POST",
        headers: { "Idempotency-Key": opKey, "PAYMENT-SIGNATURE": paymentSignature },
      }));
      this.trackBalance(res);
    }
    if (!res.ok) {
      throw await this.asError(res, "deposit failed");
    }
    this.recordSpend(amountUsd);
    const result = (await res.json()) as DepositResult;
    // Refresh prepay tracking with the authoritative post-deposit balance.
    if (this.prepay && Number.isFinite(result.balance)) this.knownCredits = result.balance;
    return result;
  }

  /**
   * Fund an ACCOUNT-KEY namespace — "payer funds, bearer owns". A CALLER-supplied
   * `signer` pays via x402 to add prepaid credits to THIS client's account (the
   * one named by its `ak_…` bearer). The payer and the owner are deliberately
   * DECOUPLED: the payer wallet signs the on-chain EIP-3009 authorization, while
   * the bearer — not the payer's address — owns the credited namespace. This is the
   * SDK counterpart of the server's `/account/deposit` route.
   *
   * Account-key mode ONLY. In WALLET mode the paying wallet IS the namespace, so
   * use `deposit()` instead — calling this throws `wrong_mode` before any network.
   *
   * `signer` is the PAYER: a viem account (must expose `address` + `signTypedData`)
   * or a raw `0x` private key (built into a viem account internally, mirroring the
   * constructor). `amountUsd` must be a whole number of dollars >= $1. UNLIKE
   * `deposit()` (which IS gated by both spend caps and counts toward session spend),
   * this explicit funding call is NOT gated by `maxSpendUsd`/`maxSessionSpendUsd` and
   * does not count toward session spend — the payer is an EXTERNAL wallet, not this
   * client's tracked budget. The local encryption key is never touched (funding does not encrypt).
   */
  async fundAccount(
    signer: Signer | `0x${string}`,
    amountUsd: number,
    opts: { idempotencyKey?: string; expectedPayTo?: string } = {},
  ): Promise<DepositResult> {
    // Account-key mode ONLY. `fundAccount` funds a DECOUPLED account bearer; a
    // wallet-mode client's paying wallet already IS its namespace (use deposit()).
    if (!this.accountKey) {
      throw new AgentKVError(
        "fundAccount funds an account-key namespace; in wallet mode use deposit()",
        "wrong_mode",
        0,
      );
    }
    // Resolve the PAYER, deliberately separate from `this.accountKey` (the owner):
    // a raw 0x private key is built into a viem account; any other value is used
    // as-is as a viem account. Mirrors the constructor's signer handling.
    const payer: Signer = typeof signer === "string" ? privateKeyToAccount(signer) : signer;
    // Fail clearly on a bad payer (e.g. undefined, or an object missing address/
    // signTypedData) instead of a cryptic TypeError deep inside buildPaymentHeader.
    if (!payer?.address || typeof payer.signTypedData !== "function") {
      throw new AgentKVError(
        "fundAccount: signer must be a 0x private key or a viem account (with address + signTypedData)",
        "invalid_config",
        0,
      );
    }

    // Validate to a whole number of US dollars >= $1 BEFORE any network call — the
    // server's only check is the >= $1 floor, so a bad amount would otherwise reach
    // the facilitator and 400. (Stricter than deposit()'s whole-atomic guard: an
    // account is funded in whole dollars.) A whole dollar is always whole-atomic.
    if (!Number.isInteger(amountUsd) || amountUsd < 1) {
      throw new AgentKVError(
        "fundAccount amountUsd must be a whole number of US dollars >= $1",
        "invalid_config",
        0,
      );
    }
    const amountAtomic = amountUsd * 1_000_000;

    const { url } = this.route({ base: "/account/deposit" });
    const bearer = buildBearerHeaders(this.accountKey);
    // Stable per-deposit key reused across the challenge->pay retry; pin the EIP-3009
    // nonce to it so a transient retry of a settled-but-unacked deposit reuses the
    // authorization and the server dedupes (exactly-once) instead of settling twice.
    const idempotencyKey = opts.idempotencyKey ?? freshNonce();
    const nonce = nonceFromIdempotencyKey(idempotencyKey);

    // 1) Bearer POST with NO payment -> 402 + a PAYMENT-REQUIRED challenge.
    let res = await this.fetchWithRetry(url, () => ({
      method: "POST",
      headers: { ...bearer, "Idempotency-Key": idempotencyKey },
    }));
    this.trackBalance(res);
    if (res.status === 402) {
      const challenge = res.headers.get("PAYMENT-REQUIRED");
      if (!challenge) {
        throw await this.asError(res, "payment required but no PAYMENT-REQUIRED challenge");
      }
      // Sign the x402 payment with the PAYER's wallet (never the account bearer).
      const paymentSignature = await buildPaymentHeader(payer, challenge, {
        amountAtomic,
        expectedNetwork: this.network,
        expectedPayTo: opts.expectedPayTo,
        nonce,
      });
      res = await this.fetchWithRetry(url, () => ({
        method: "POST",
        headers: {
          ...bearer,
          "Idempotency-Key": idempotencyKey,
          "PAYMENT-SIGNATURE": paymentSignature,
        },
      }));
      this.trackBalance(res);
    }
    if (!res.ok) {
      throw await this.asError(res, "fundAccount failed");
    }
    const result = (await res.json()) as DepositResult;
    // Refresh prepay tracking (if enabled) with the authoritative post-deposit balance
    // of THIS account — funding credits the same namespace this client reads/writes.
    if (this.prepay && Number.isFinite(result.balance)) this.knownCredits = result.balance;
    return result;
  }

  /** Shared by `asError` (a real `Response`) and the `opInlinePayer` path (a plain `{status,body}`). */
  private errorFromBody(status: number, bodyText: string, fallback: string): Error {
    let detail = fallback,
      code = "request_failed";
    try {
      const body = JSON.parse(bodyText) as { error?: string; code?: string };
      if (body?.error) detail = body.error;
      if (body?.code) code = body.code;
    } catch {
      /* non-JSON */
    }
    return new AgentKVError(`AgentKV ${status}: ${detail}`, code, status);
  }

  private async asError(res: Response, fallback: string): Promise<Error> {
    return this.errorFromBody(res.status, await res.text(), fallback);
  }

  /**
   * The settled amount (USD) from an `opInlinePayer` response's PAYMENT-RESPONSE
   * header — the inline-path mirror of `settledTxHash()` above, but reading a
   * plain `Record<string,string>` (the hook's own headers, not a `Response`) and
   * returning the `amount` field instead of the `txHash`. Case-insensitive header
   * lookup: an external transport (e.g. awal) is not guaranteed to preserve the
   * worker's exact `PAYMENT-RESPONSE` casing. Returns `undefined` when the header
   * is absent/unparsable OR the op settled nothing (served from existing credits,
   * `txHash: ""`) — callers fall back to the credit-equivalent op price.
   */
  private inlineSettledAmountUsd(headers: Record<string, string>): number | undefined {
    const key = Object.keys(headers).find((k) => k.toLowerCase() === "payment-response");
    const header = key ? headers[key] : undefined;
    if (!header) return undefined;
    try {
      const parsed = JSON.parse(decodeBase64Utf8(header)) as {
        amount?: unknown;
        txHash?: unknown;
      };
      if (typeof parsed.txHash !== "string" || parsed.txHash === "") return undefined;
      const atomic = Number(parsed.amount);
      return Number.isFinite(atomic) && atomic > 0 ? atomic / 1_000_000 : undefined;
    } catch {
      return undefined;
    }
  }
}
