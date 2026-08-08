// client/src/index.ts
export const VERSION = "0.4.2";

import { assertFiniteUsd, fetchWithRetry, SpendLedger } from "@agentx402-ai/core";
import { getAddress, hexToBytes } from "viem";
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
  kvErrorFromResponse,
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
// The error taxonomy. `AgentKVServiceError` (worker responses, carries `hint`),
// the `AgentKVErrorCode` union callers switch on, and the shared response mapper —
// exported so `cli/` and the MCP server map worker failures exactly as the SDK does.
export {
  AgentKVError,
  type AgentKVErrorCode,
  AgentKVServiceError,
  AgentXError,
  kvErrorFromResponse,
  SpendCapError,
} from "./types";

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

// Pinned WALLET-mode (x402) op prices in USD — the per-op AUTHORIZED CEILING. These are the
// prices the server itself quotes on a 402, mirroring the worker's READ_PRICE_ATOMIC (3_000)
// and WRITE_PRICE_ATOMIC (5_000). `authorized-ceiling.test.ts` pins them to that derivation
// (NOT pricing.test.ts, which covers the separate CREDIT costs), and the worker's own
// pricing-constants test pins the other half.
//
// BECAUSE these are a CEILING, a price INCREASE must reach callers BEFORE the worker quotes
// it: an un-updated client refuses the new, honest 402 as a SpendCapError. Ship the SDK first,
// then the worker price. (Pinning BELOW the server's real quote breaks every paid op.)
export const X402_READ_USD = 0.003;
export const X402_WRITE_USD = 0.005;

// Float/rounding slack (USD, ~1 atomic USDC) for the authorized-ceiling comparison, so an
// exact honest quote is never refused by sub-atomic IEEE-754 error.
const PRICE_EPS = 0.000001;

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
export function toWholeAtomicUsd(amountUsd: number): number | null {
  if (!Number.isFinite(amountUsd)) return null;
  const atomic = Math.round(amountUsd * 1_000_000);
  if (!Number.isInteger(atomic) || atomic <= 0) return null;
  if (Math.abs(amountUsd * 1_000_000 - atomic) > atomic * 1e-9) return null;
  return atomic;
}

/**
 * Validate a spend-cap option: `undefined` (no cap) or a finite, non-negative number.
 * Anything else throws — a malformed cap must fail CLOSED, never silently become
 * "unlimited" on real funds (money-safety invariant #2), matching the CLI's numOrThrow.
 * `NaN` was strictly WORSE than no cap: `usd > NaN` is false (per-op and session caps
 * both disabled) AND `assertOpPriceCeiling` gates on `maxSpendUsd === undefined`, so a
 * NaN-capped client also skipped the built-in DEFAULT_MAX_OP_USD ceiling and would sign
 * a spoofed $1000 quote that an UNCONFIGURED client rejects.
 */
// Delegates the RULE to core (which raises AgentXError — the very class `AgentKVError` aliases,
// so an existing `instanceof AgentKVError` still matches) and keeps returning the value, since
// the call sites assign the validated cap straight through.
function assertCapOption(v: number | undefined, name: string): number | undefined {
  assertFiniteUsd(v, name);
  return v;
}

export class AgentKV {
  /**
   * The signing wallet. `undefined` in account-key mode (a managed account has no
   * wallet that can sign) — the `ak_…` bearer token is the identity instead.
   */
  readonly signer?: Signer;
  /** The wallet address (its namespace) in wallet/signer mode; `undefined` in account-key mode. */
  readonly address: `0x${string}` | undefined;
  /** The raw `ak_…` bearer token in account-key mode; `undefined` otherwise. */
  readonly accountKey?: string;
  readonly endpoint: string;
  readonly network: string;
  readonly maxSpendUsd?: number;
  readonly maxSessionSpendUsd?: number;
  /**
   * Optional client-level x402 recipient pin (checksummed). Threaded into every
   * `buildPaymentHeader` call site so a challenge with an unexpected `payTo` is
   * rejected before signing. A per-call `expectedPayTo` overrides this default.
   */
  private readonly expectedPayTo?: string;
  /** Bounded internal retries on transient failures (network error / 5xx). */
  readonly maxRetries: number;
  private readonly timeoutMs?: number;
  private readonly fetchImpl?: typeof fetch;
  private _ikm?: Uint8Array;
  private _km?: KeyMaterial;
  private _kmPromise?: Promise<KeyMaterial>;
  /**
   * The spend bounds, including the in-flight reservation that makes the cumulative cap hold
   * under concurrency: settlement is only known after a paid round-trip, so a ledger counting
   * only settled spend hands concurrent ops the same stale total and each one signs. Shared
   * with the other service SDKs via core, which already owned the SpendCapError it raises —
   * both repos had kept their own copy under different names, and both drifted.
   */
  private readonly ledger: SpendLedger;

  // Read-only views onto the ledger, kept because the white-box spend-accounting tests read
  // these names directly (`(kv as { sessionSpentUsd }).sessionSpentUsd`) to prove a top-off is
  // counted exactly once and that an in-flight one is visible to a concurrent check. Reads
  // only — the ledger owns every mutation.
  private get sessionSpentUsd(): number {
    return this.ledger.settled;
  }

  private get sessionReservedUsd(): number {
    return this.ledger.inFlight;
  }

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
    // Fail fast (invalid_config) at construction: an absent endpoint otherwise dies with a
    // bare TypeError on .replace, and a non-URL string only surfaces as "Invalid URL" from
    // the first (possibly paying) op. Same pattern as the expectedPayTo pin below.
    if (typeof opts.endpoint !== "string" || opts.endpoint === "") {
      throw new AgentKVError("endpoint is required (an absolute http(s) URL)", "invalid_config", 0);
    }
    try {
      const u = new URL(opts.endpoint);
      if (u.protocol !== "http:" && u.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
    } catch {
      throw new AgentKVError(
        `endpoint must be an absolute http(s) URL (got ${JSON.stringify(opts.endpoint)})`,
        "invalid_config",
        0,
      );
    }
    this.endpoint = opts.endpoint.replace(/\/+$/, "");
    this.network = opts.network ?? DEFAULT_NETWORK;
    this.maxSpendUsd = assertCapOption(opts.maxSpendUsd, "maxSpendUsd");
    this.maxSessionSpendUsd = assertCapOption(opts.maxSessionSpendUsd, "maxSessionSpendUsd");
    // Caps validated just above, so the ledger's identical re-check never fires.
    this.ledger = new SpendLedger({
      maxSpendUsd: this.maxSpendUsd,
      maxSessionSpendUsd: this.maxSessionSpendUsd,
    });
    // retries: NaN would make the retry condition always-false (silently no retries) and
    // Infinity would survive the clamp (unbounded loop) — reject non-finite; negatives
    // still clamp to 0 as before.
    if (opts.retries !== undefined && !Number.isFinite(opts.retries)) {
      throw new AgentKVError("retries must be a finite number >= 0", "invalid_config", 0);
    }
    this.maxRetries = Math.max(0, Math.floor(opts.retries ?? 2));
    this.timeoutMs = opts.timeoutMs;
    this.fetchImpl = opts.fetch;

    // Optional recipient pin: normalize to a checksummed address up front so a
    // malformed value fails fast (invalid_config) at construction instead of with a
    // cryptic viem throw deep inside buildPaymentHeader on the first paying op.
    if (opts.expectedPayTo !== undefined) {
      try {
        this.expectedPayTo = getAddress(opts.expectedPayTo);
      } catch {
        throw new AgentKVError("expectedPayTo must be a valid 0x address", "invalid_config", 0);
      }
    }

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
      if (!isAccountMode) {
        // Wallet mode signs its own x402 challenges — there is no unprovisioned-
        // account bootstrap to authorize, so the option would be silently inert.
        // Reject like the payer hooks above and the CLI's AGENTKV_BOOTSTRAP guard.
        throw new AgentKVError(
          "bootstrap is account-key-mode only; wallet mode pays its own x402 challenges",
          "invalid_config",
          0,
        );
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
      // Value-based, like the accountKey/privateKey discrimination above: a present-but-
      // undefined key from a spread config must not trip this. A REAL wallet alongside an
      // accountKey would be silently dropped (bearer auth on a different namespace than the
      // caller thinks) — reject, symmetric with the privateKey+encryptionKey guard below.
      const hasWallet =
        ("privateKey" in opts && (opts as { privateKey?: unknown }).privateKey != null) ||
        ("signer" in opts && (opts as { signer?: unknown }).signer != null);
      if (hasWallet) {
        throw new AgentKVError(
          "accountKey and a wallet (privateKey/signer) are mutually exclusive — account-key mode " +
            "has no signing wallet; pass exactly one auth shape",
          "invalid_config",
          0,
        );
      }
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
          // The comment above says we do NOT normalize v — so the raw 0/1 recovery id
          // (KMS / raw-secp256k1 wrappers) hashes to DIFFERENT key material than the same
          // wallet's 27/28 form from viem/ethers/MetaMask, silently orphaning every stored
          // value on a signer-library swap. Reject it here the way the length check rejects
          // EIP-2098 / ERC-1271 shapes: those signers must pin an explicit encryptionKey.
          const recoveryId = sigBytes[64];
          if (recoveryId !== 27 && recoveryId !== 28) {
            throw new AgentKVError(
              `sign-to-derive requires the standard 27/28 recovery id but this signer returned ` +
                `v=${recoveryId}; its signature encoding is unstable for key derivation — ` +
                "construct with an explicit encryptionKey instead",
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

  // The next four delegate to the shared ledger. They stay as named methods because their
  // call sites and the white-box money tests already use these names; only the arithmetic
  // moved to core, which already owned the SpendCapError they raise.
  private assertSpend(usd: number, opts: { bypassPerOpCap?: boolean } = {}): void {
    // Top-offs pass bypassPerOpCap: a credit purchase is not a per-op charge, so the per-call
    // cap (which bounds individual pay-per-op spend) must not gate it — mirroring
    // topoffFitsSessionCap() on the synchronous top-off paths. The cumulative cap still binds.
    this.ledger.assertSpend(usd, { bypassPerCallCap: opts.bypassPerOpCap });
  }

  private recordSpend(usd: number): void {
    this.ledger.record(usd);
  }

  /**
   * Reserve `usd` against the session cap SYNCHRONOUSLY. Returns a release fn the caller
   * MUST invoke exactly once (in a `finally`) — releasing is idempotent so a double call
   * cannot leak budget back.
   */
  private reserveSession(usd: number): () => void {
    return this.ledger.reserve(usd);
  }

  /** `assertSpend` + a synchronous reservation. The caller MUST release in a `finally`. */
  private assertAndReserveSpend(usd: number, opts: { bypassPerOpCap?: boolean } = {}): () => void {
    // Kept as check-then-reserve through this class's own two methods rather than the ledger's
    // combined call: nothing awaits between them, so it is equivalent, and it keeps one place
    // where the bypass is translated for every caller of either method.
    this.assertSpend(usd, opts);
    return this.reserveSession(usd);
  }

  /**
   * Reject a SERVER-QUOTED per-op price above a sane ceiling in the DEFAULT (cap-less) config.
   * When `maxSpendUsd` is set, `assertSpend` already bounds the op price; when it is NOT set,
   * a compromised or spoofed worker could otherwise answer a routine $0.005 read with a 402
   * challenge for the wallet's whole balance and the client would sign the EIP-3009
   * authorization. Callers who genuinely need a pricier op opt in via `maxSpendUsd`.
   */
  private assertOpPriceCeiling(usd: number): void {
    // Negated <= (not >): a non-finite operand then fails CLOSED instead of open.
    if (this.maxSpendUsd === undefined && !(usd <= DEFAULT_MAX_OP_USD)) {
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
      this.sessionSpentUsd + this.sessionReservedUsd + this.prepay.topoff > this.maxSessionSpendUsd
    ) {
      return;
    }
    this.topoffInFlight = true;
    if (this.accountKey) {
      // Account-key mode: no signing wallet — dispatch the SAME payer hook the
      // synchronous paths use. A hook failure is swallowed (crash-safe, mirrors
      // the wallet-mode runDeposit catch below); the next op's 402 retries it.
      // Reserve NOW, synchronously, before the detached dispatch: unlike runDeposit
      // (wallet mode, below), runAccountTopoff() has no reservation of its own, so
      // without this the single-flight flag only bounded the COUNT of detached
      // top-offs to one — not the TOTAL, since the amount stayed invisible to
      // sessionReservedUsd and a concurrent op could still push real spend past the
      // cap. Released in the SAME `.finally()` that already clears `topoffInFlight`.
      const releaseTopoff = this.reserveSession(this.prepay.topoff);
      void this.runAccountTopoff()
        .catch(() => {})
        .finally(() => {
          releaseTopoff();
          this.topoffInFlight = false;
        });
      return;
    }
    // Detached + crash-safe: bypass the per-op cap (a top-off is a credit purchase,
    // not a per-op charge) AND swallow any rejection (cap race, network, server)
    // so a failed background top-off never becomes an unhandled rejection that
    // crashes the host — the next op's 402 retries it. deposit() recordSpends itself.
    // No separate reservation needed here: runDeposit() (site 5) already reserves and
    // releases its own amount internally, synchronously, before this call even yields.
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
    return (
      this.sessionSpentUsd + this.sessionReservedUsd + this.prepay!.topoff <=
      this.maxSessionSpendUsd
    );
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
      /**
       * Caller-authorized USD ceiling for the WALLET (x402) op price: the pinned price for this
       * verb. A 402 quoting more than this (beyond float slack) is refused BEFORE signing, so a
       * lying/spoofed/MITM'd server cannot inflate the amount — and unlike `maxSpendUsd` this
       * holds in the DEFAULT config, where the only other guard is the coarse DEFAULT_MAX_OP_USD
       * backstop (10x the real op price). Does NOT apply to the top-off branch, which
       * legitimately pays >= $1 for a credit purchase rather than this op's price.
       *
       * Required but nullable ON PURPOSE: a new verb must STATE its ceiling, so the decision is
       * conscious, but may state `undefined` when no canonical price is pinned — which falls
       * back to the DEFAULT_MAX_OP_USD backstop rather than forcing the author to invent a
       * number. Writing a guessed ceiling here would be worse than declaring none.
       */
      authorizedCeilingUsd: number | undefined;
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
        // Reserve the committed top-off so a concurrent op's session-cap check sees it —
        // topoffFitsSessionCap() just confirmed it fits. Without this the single-flight flag
        // only bounded the COUNT of proactive top-offs to one, not the TOTAL: the amount was
        // invisible to sessionReservedUsd, so a concurrent deposit/op could still push the
        // combined real spend past the cap. Released once runSharedTopoff() resolves —
        // recordSpend has already run internally by then on success.
        const releaseTopoff = this.reserveSession(this.prepay!.topoff);
        try {
          await this.runSharedTopoff();
          toppedOff = true;
        } catch {
          // swallowed by design (proactive path); the op continues on remaining credits.
        } finally {
          releaseTopoff();
        }
      }
      this.maybeAsyncTopoff();
      const releaseCredit = this.assertAndReserveSpend(creditCostUsd);
      try {
        const sendBearer = () =>
          this.fetchWithRetry(url, () =>
            spec.buildRequest({
              "Idempotency-Key": idempotencyKey,
              ...buildBearerHeaders(this.accountKey!),
            }),
          );
        let res = await sendBearer();
        // Gate BEFORE ingesting the balance: trackBalance() reads
        // `X-AgentKV-Credits-Remaining: 0` off an unprovisioned account's 402 and would
        // otherwise seed `knownCredits = 0` synchronously, right here, before
        // assertBootstrapAllowed() gets a chance to reset it (that reset sits behind the
        // `await res.clone().json()` yield point inside the gate). In that window a
        // concurrently scheduled op (parallel tool calls, unawaited sets, retry loops) can
        // observe `knownCredits === 0`, synchronously win `tryClaimTopoff()`, and fire the
        // ungated proactive `topoffPayer` — auto-funding an unprovisioned key with bootstrap
        // off. Checking the gate first means a denial throws before any seed happens, so the
        // window never opens. Shared choke point for BOTH the topoffPayer hard-402 branch and
        // the opInlinePayer branch below — they both react to this same response. The calls to
        // `assertBootstrapAllowed()` further down are kept as belt-and-braces (harmless no-ops
        // once this one has already gated) and its internal `knownCredits = undefined` reset
        // stays in place as a second line of defense.
        if (res.status === 402) {
          await this.assertBootstrapAllowed(res);
        }
        this.trackBalance(res);
        // Hard 402: with a payer hook, buy a top-off and retry ONCE (same key = exactly-once).
        // Skipped after a successful proactive deposit (`!toppedOff`) so at most one deposit/op.
        if (res.status === 402 && this.topoffPayer && !toppedOff) {
          // Gate BOTH sub-paths below (the direct `runSharedTopoff()` claim and the sibling
          // `topoffPromise` await) before either can trigger/observe a real deposit — this is
          // the choke point for every topoffPayer entry point reachable from a hard 402.
          await this.assertBootstrapAllowed(res);
          if (!flight.claimed) flight.claimed = this.tryClaimTopoffOnFault();
          if (flight.claimed && this.topoffFitsSessionCap()) {
            // Same reservation as the proactive attempt above: a committed top-off must be
            // visible to a concurrent session-cap check, not just single-flight-bounded to a
            // COUNT of one. The credit reservation above stays held throughout — unlike the
            // inline branch below, the credit path is NOT abandoned here (a successful retry
            // still debits creditCostUsd), so both amounts are genuinely in flight at once.
            const releaseTopoff = this.reserveSession(this.prepay!.topoff);
            try {
              await this.runSharedTopoff();
            } finally {
              releaseTopoff();
            }
            res = await sendBearer();
            this.trackBalance(res);
          } else if (this.topoffPromise) {
            // A concurrent op won the single-flight and is depositing RIGHT NOW: rather than
            // surface this 402 (a deposit is landing), await that sibling's top-off and retry
            // the bearer ONCE — the same Idempotency-Key keeps it exactly-once. That sibling
            // took its own reservation; there is nothing to reserve here.
            await this.topoffPromise.catch(() => {});
            res = await sendBearer();
            this.trackBalance(res);
          }
        }
        // Inline opt-in: route the WHOLE op through an external x402 transport (e.g. awal)
        // instead of a credit top-off. Mutually exclusive with topoffPayer PER OP.
        if (res.status === 402 && this.opInlinePayer && !this.topoffPayer) {
          // Once inline is taken, the credit path is abandoned — its recordSpend(creditCostUsd)
          // below is unreachable — so release the outer reservation NOW rather than holding it
          // as dead weight alongside the inline reservation below. Pre-fix, that double-hold
          // rejected a single, uncontended op whose session cap sat within a credit cost of the
          // op ceiling. releaseCredit() is idempotent, so the outer `finally` above stays a
          // harmless catch-all for every other exit path.
          releaseCredit();
          await this.assertBootstrapAllowed(res);
          // Bound by the caller's per-op cap and pre-reserve against the session cap BEFORE
          // paying — the credit-cost pre-flight only checked the credit price, not real USDC.
          const inlineCeilingUsd = this.inlineOpCeilingUsd();
          const releaseInline = this.assertAndReserveSpend(inlineCeilingUsd);
          try {
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
          } finally {
            releaseInline();
          }
        }
        if (res.status === 404 && spec.notFound) return spec.notFound();
        if (!res.ok) throw await this.asError(res, label);
        this.recordSpend(creditCostUsd);
        return spec.parseSuccess(res);
      } finally {
        releaseCredit();
      }
    }

    // 0) Wallet-mode proactive single-shot top-off (claim held): pay a >=$1 top-off on THIS op
    //    from the cached challenge template. Cold start (no template) -> identity path below.
    if (flight.claimed && this.challengeTemplate && this.topoffFitsSessionCap()) {
      // Reserve the committed top-off so a concurrent op's session-cap check sees it — this is
      // the SAME commitment as the hard-402 topoffHere branch below (a top-off riding this op's
      // request), just reached via the cached-template fast path instead of a cold-start 402.
      // Released whenever this attempt settles OR falls through (stale template, non-2xx,
      // signing failure): none of those actually spent anything, so nothing stays reserved.
      const releaseTopoff = this.reserveSession(this.prepay!.topoff);
      try {
        let paymentSignature: string | undefined;
        try {
          paymentSignature = await buildPaymentHeader(
            this.requireSigner(),
            this.challengeTemplate,
            {
              amountAtomic: this.topoffAtomic,
              expectedNetwork: this.network,
              expectedPayTo: this.expectedPayTo,
              // Pin the nonce to the op's idempotency key so a retry reuses the auth and the
              // server dedupes the mint + the op.
              nonce: nonceFromIdempotencyKey(idempotencyKey),
            },
          );
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
      } finally {
        releaseTopoff();
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
      // Default no-op: EVERY branch below MUST overwrite this before committing to pay, or
      // its spend goes silently unreserved — invisible to a concurrent session-cap check,
      // which is the exact bug this reservation exists to prevent. A contributor adding a
      // third branch here must set `release` too.
      let release: () => void = () => {};
      if (topoffHere) {
        // A committed top-off is real USD, exactly like the op-price branch below — reserve
        // it so a concurrent check sees it. topoffFitsSessionCap() (above) is the sole gate
        // for a top-off, mirroring assertSpend's bypassPerOpCap: a top-off bypasses the
        // per-op ceiling by design, so reserve directly rather than re-asserting through it.
        release = this.reserveSession(usd);
      } else {
        // Authorized-ceiling check (primary defense), BEFORE any signature is produced: refuse a
        // server quoting more than this verb's pinned price. Holds even in the default
        // no-maxSpendUsd config, where assertOpPriceCeiling alone would wave through anything up
        // to DEFAULT_MAX_OP_USD — 10x a real $0.005 write. Deliberately NOT applied to the
        // topoffHere branch above: a top-off is a >= $1 credit purchase, not this op's price.
        //
        // A non-finite ceiling is a HARD refusal rather than a vacuous `usd > NaN` that always
        // passes. The value is a module constant today, so this only fires on a bug — but this
        // is the last gate before a signature, so it refuses rather than trusts.
        if (spec.authorizedCeilingUsd !== undefined) {
          if (!Number.isFinite(spec.authorizedCeilingUsd)) {
            throw new SpendCapError(
              `authorized ceiling $${spec.authorizedCeilingUsd} is not a finite amount; refusing to sign`,
            );
          }
          if (!(usd <= spec.authorizedCeilingUsd + PRICE_EPS)) {
            throw new SpendCapError(
              `server quoted $${usd} but the client only authorized $${spec.authorizedCeilingUsd} ` +
                "(the pinned op price); refusing to sign",
            );
          }
        }
        // Backstop, and the ONLY op-price bound for a verb that declares no ceiling. For today's
        // two verbs it cannot bind: both pinned ceilings ($0.003/$0.005) are an order of magnitude
        // under DEFAULT_MAX_OP_USD ($0.05), so the check above always refuses first. Kept because
        // it is what a future `authorizedCeilingUsd: undefined` verb falls back to — and
        // DEFAULT_MAX_OP_USD stays live regardless on the inline-payer path (inlineOpCeilingUsd).
        this.assertOpPriceCeiling(usd);
        release = this.assertAndReserveSpend(usd);
      }
      try {
        // Pin the EIP-3009 nonce to the idempotency key so a retried op reuses the same
        // authorization and the server dedupes. Re-send the identical signed header on retry.
        const paymentSignature = await buildPaymentHeader(this.requireSigner(), challenge, {
          amountAtomic: topoffHere ? this.topoffAtomic : undefined,
          expectedNetwork: this.network,
          expectedPayTo: this.expectedPayTo,
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
      } finally {
        release();
      }
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
      // Mirror the CLI's --ttl-days rule (finite, >= 0): a NaN here would otherwise serialize
      // as ttl_days:null on a PAID write, silently dropping the caller's retention choice.
      // Validated up front — before getKeyMaterial()/encrypt() below — so a bad ttlDays throws
      // before a sign-to-derive `{ signer }` client ever prompts the wallet to sign; mirrors
      // listKeys()'s limit check, which validates before getKeyMaterial() for the same reason.
      if (opts.ttlDays !== undefined && (!Number.isFinite(opts.ttlDays) || opts.ttlDays < 0)) {
        throw new AgentKVError("ttlDays must be a finite number >= 0", "invalid_value", 0);
      }
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
        authorizedCeilingUsd: X402_WRITE_USD,
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
        authorizedCeilingUsd: X402_READ_USD,
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
    // limit reaches the wire verbatim — reject garbage (NaN/0/fractions) up front,
    // mirroring the CLI's --limit rule.
    if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) {
      throw new AgentKVError("limit must be a positive integer", "invalid_value", 0);
    }
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
    // An empty-string cursor from the server is "exhausted", not a resumable page token —
    // surface the documented null so `while (cursor !== null)` drivers terminate.
    return { keys, cursor: data.cursor || null };
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
        const release = this.assertAndReserveSpend(amountUsd);
        try {
          await this.runAccountTopoff(amountUsd);
          // runAccountTopoff() already recorded the spend internally (recordSpend runs at
          // its end, on success) — release NOW rather than holding the reservation through
          // the balance() round-trip below. Holding it would double-count against a
          // concurrent op's check (once in sessionSpentUsd, again in sessionReservedUsd) and
          // could wrongly reject a legitimate concurrent deposit that would otherwise fit.
          release();
          const balance = await this.balance();
          return { credits_added: Math.round(amountUsd / CREDIT_VALUE_USD), balance };
        } finally {
          // Idempotent catch-all: a no-op on the success path above (already released); the
          // real work happens when runAccountTopoff() throws before the manual release runs.
          release();
        }
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
    const release = this.assertAndReserveSpend(amountUsd, opts);
    try {
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
          // Per-call pin overrides the client-level default for this one deposit.
          expectedPayTo: opts.expectedPayTo ?? this.expectedPayTo,
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
      // Release NOW rather than holding the reservation through the res.json() parse below:
      // the spend is already accounted for in sessionSpentUsd, so continuing to hold it in
      // sessionReservedUsd would double-count it against a concurrent op's check and could
      // wrongly reject a legitimate concurrent deposit/op that would otherwise fit.
      release();
      const result = (await res.json()) as DepositResult;
      // Refresh prepay tracking with the authoritative post-deposit balance.
      if (this.prepay && Number.isFinite(result.balance)) this.knownCredits = result.balance;
      return result;
    } finally {
      // Idempotent catch-all: a no-op on the success path above (already released); the real
      // work happens on every throw path before the manual release runs.
      release();
    }
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
        // Per-call pin overrides the client-level default for this one funding call.
        expectedPayTo: opts.expectedPayTo ?? this.expectedPayTo,
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

  /**
   * Bootstrap gating (spec 2026-07-10): an `account_not_provisioned` 402 is payable, but
   * auto-funding it can silently fund a TYPO'D key — require the explicit opt-in.
   * `insufficient_credits` (provisioned account) keeps firing unconditionally, as before.
   * Shared by BOTH account-key top-off paths (`topoffPayer` hard-402 handling and the
   * `opInlinePayer` branch) so every entry point that can trigger a real on-chain deposit for
   * an unprovisioned account is gated identically. Clones before reading: `res` may still need
   * to be read by `asError()`/`errorFromBody()` on other branches, and a Response body can only
   * be consumed once.
   */
  private async assertBootstrapAllowed(res: Response): Promise<void> {
    const errBody = (await res
      .clone()
      .json()
      .catch(() => undefined)) as { code?: string } | undefined;
    if (errBody?.code === "account_not_provisioned" && !this.bootstrap) {
      // An unprovisioned account has no meaningful credit balance. The worker still sends
      // `X-AgentKV-Credits-Remaining: 0` on this 402 (WalletKV.accountNotProvisioned).
      // `performOp()` now calls this gate BEFORE `trackBalance()` ingests that header, so a
      // denial here throws before `knownCredits` is ever seeded to 0 — closing the window
      // where a concurrent op's synchronous `tryClaimTopoff()` could observe 0 and fire the
      // proactive `topoffPayer` ungated. The reset below is belt-and-braces for any call site
      // that (now or in the future) reaches this gate AFTER a seed has already happened —
      // it re-arms the NEXT op's synchronous `tryClaimTopoff()` (0 < watermark) to fall
      // through instead of claiming the proactive single-flight ungated.
      this.knownCredits = undefined;
      throw new AgentKVError(
        "account not provisioned — deposit (fundAccount() / agentkv deposit) or opt in to " +
          "pay-per-call bootstrap (bootstrap: true / AGENTKV_BOOTSTRAP=1)",
        "account_not_provisioned",
        402,
      );
    }
  }

  /**
   * Shared by `asError` (a real `Response`) and the `opInlinePayer` path (a plain
   * `{status,body}`). A thin delegate to the exported `kvErrorFromResponse` so the SDK,
   * the CLI, and the MCP boundary all map worker responses through ONE implementation
   * (it used to be inline here, and dropped the worker's `hint`).
   */
  private errorFromBody(status: number, bodyText: string, fallback: string): Error {
    return kvErrorFromResponse(status, bodyText, fallback);
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
