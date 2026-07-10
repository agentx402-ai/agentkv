// client/src/types.ts
//
// `AgentKVError` (base error class), `SpendCapError`, `Signer`,
// `UsageBlock`, and the EIP-712/CAIP-2 domain constants live in
// `@agentx402-ai/core`. Re-exported here under the SAME names for back-compat —
// `@agentkv/client` depends on and re-exports core's class/values, it never
// re-declares them, so `err instanceof AgentKVError` keeps working for
// anything caught across this package boundary (see core/src/errors.ts and
// core/test/errors.test.ts + client/test/errors.test.ts for the guarantee).

export type { Signer, UsageBlock } from "@agentx402-ai/core";
export {
  AgentKVError,
  chainIdFromCaip2,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  SpendCapError,
} from "@agentx402-ai/core";

import type { Signer, UsageBlock } from "@agentx402-ai/core";

/** Request passed to `topoffPayer` when the client needs an account-key top-off. */
export interface TopoffPayerRequest {
  /** `${endpoint}/account/deposit` — the ONLY URL a hook should ever pay. */
  depositUrl: string;
  /** The `ak_…` bearer that must authorize the deposit (`Authorization: Bearer <ak>`). */
  accountKey: string;
  /** Requested top-off in USD (= `prepay.topoff`, >= $1 — the server minimum). */
  amountUsd: number;
  /** Hard payment ceiling in atomic USDC units (1e6 = $1) the hook MUST enforce (e.g. awal `--max-amount`). */
  maxAmountAtomic: number;
}

/**
 * Request handed to `opInlinePayer`: the WHOLE encrypted account-key `set`/`get`
 * op, ready to send as-is. The hook drives its OWN 402→pay→retry (e.g. via
 * `awal x402 pay`) and returns the final response — the client never sees the
 * intermediate 402 on this path.
 */
export interface OpInlineRequest {
  /** `${endpoint}/kv/<digest>` — the ONLY URL a hook should ever request. */
  url: string;
  method: "POST" | "GET";
  /** Ciphertext JSON body (POST only; omitted on GET). */
  body?: string;
  /** Full request headers: bearer `Authorization`, `Idempotency-Key`, `content-type` (POST). */
  headers: Record<string, string>;
  /** Hard payment ceiling in atomic USDC units (1e6 = $1) the hook MUST enforce (e.g. awal `--max-amount`). */
  maxAmountAtomic: number;
}

/** Final response from `opInlinePayer`, after its own 402→pay→retry has settled. */
export interface OpInlineResponse {
  status: number;
  body: string;
  headers: Record<string, string>;
}

interface AgentKVCommon {
  endpoint: string;
  network?: string;
  /** Per-paying-call USD cap; throws SpendCapError if exceeded. */
  maxSpendUsd?: number;
  /**
   * Cumulative USD cap across this client instance. **Best-effort**: the running
   * total is a plain in-memory counter, so concurrent paying calls can race
   * (both pass `assertSpend` before either `recordSpend`s) and modestly overshoot
   * the cap. It is a guardrail, not a hard ledger — serialize paying calls if you
   * need a strict bound.
   */
  maxSessionSpendUsd?: number;
  /**
   * Bounded internal retries on TRANSIENT failures (a thrown fetch / lost
   * response, or a 5xx). Default 2 (3 attempts total). Retries reuse the op's
   * stable Idempotency-Key (and pinned EIP-3009 nonce on paid ops) so a
   * processed-but-unacked request dedupes server-side instead of double-charging.
   * Kept small so a re-sent paid authorization stays within validBefore. Set 0 to disable.
   */
  retries?: number;
  /** Per-attempt request timeout in ms (aborts a hung-open connection so an op can't wedge forever). Default 30000. Pass 0 to disable. */
  timeoutMs?: number;
  /** Injectable `fetch` for proxies / instrumentation / testing. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Opt-in Discounted Prepay. When set, the client keeps a credit balance topped up. */
  prepay?: {
    /** Top off when the tracked balance (USD) falls below this. */
    watermark: number;
    /** Top-off amount in USD (>= 1). */
    topoff: number;
    /** Opt-in background top-off instead of synchronous single-shot. Default false. */
    async?: boolean;
  };
  /**
   * ACCOUNT-KEY MODE ONLY: pays a prepaid-credit top-off to
   * `${endpoint}/account/deposit` on this client's behalf (a managed account has
   * no signing wallet). Called single-flight when the tracked balance falls below
   * `prepay.watermark`, and as a fallback when an op hits an insufficient-credits
   * 402. Resolve only once the deposit has SETTLED; a rejection surfaces as
   * `account_topoff_failed` (fatal on the hard-402 path, swallowed on the
   * proactive path). REQUIRED alongside `prepay` in account-key mode; rejected
   * (`invalid_config`) in wallet mode or without `prepay` (it could never fire).
   */
  topoffPayer?: (req: TopoffPayerRequest) => Promise<void>;
  /**
   * ACCOUNT-KEY MODE ONLY: routes a WHOLE `set`/`get` op through an external inline
   * x402 transport (e.g. `awal x402 pay`) instead of the stage-1 deposit top-off —
   * opt-in, pay-per-op, no `prepay` required. Called on a hard 402 (insufficient
   * credits): the client hands the hook the complete encrypted request
   * (`{url, method, body, headers}`, already bearer-authenticated and
   * Idempotency-Keyed) and the hook drives its OWN 402→pay→retry, returning the
   * final `{status, body, headers}` for the client to parse/decrypt as usual.
   *
   * Mutually exclusive with `topoffPayer` PER OP: when BOTH are configured,
   * `topoffPayer` (deposit top-off) always takes precedence and `opInlinePayer`
   * is used only when `topoffPayer` is absent — see client/README.md. Rejected
   * (`invalid_config`) in wallet mode (a signing wallet pays its own challenges).
   */
  opInlinePayer?: (req: OpInlineRequest) => Promise<OpInlineResponse>;
  /**
   * ACCOUNT-KEY MODE: opt in to letting `opInlinePayer` fire on a 402 whose
   * body `code` is `account_not_provisioned` — i.e. actually fund a brand-new/
   * unprovisioned `ak_…` account inline, in the same call that discovers it
   * needs funding. Default `false`: an `account_not_provisioned` 402 throws
   * instead of paying, because auto-funding it is indistinguishable from
   * silently funding a typo'd or rotated account key. `insufficient_credits`
   * 402s (an already-provisioned account that's merely out of credit) always
   * fire the payer unconditionally — this option only gates the FIRST-EVER
   * payment on a key. Has no effect in wallet mode: a signing wallet always
   * pays its own x402 challenges directly, so there is nothing to gate there.
   */
  bootstrap?: boolean;
}

/**
 * Construct with one of four auth shapes:
 *  - `{ privateKey }` — a raw wallet key (HKDF-derives the AES key from the KEY BYTES;
 *    wallet signs).
 *  - `{ signer, encryptionKey }` — a wallet signer + an explicit AES key.
 *  - `{ signer }` — a wallet signer; the AES key is SIGN-TO-DERIVED (HKDF over the wallet's
 *    signature of a fixed message).
 *  - `{ accountKey, encryptionKey }` — account-key mode: a managed account with
 *    NO signing wallet. Auth is an opaque `ak_…` bearer token (server hashes it to
 *    name storage + debits prepaid credits — no x402/EIP-712). There is no wallet
 *    to derive an AES key from, so an explicit `encryptionKey` is REQUIRED.
 *
 * ⚠️ Encryption-key stability — the shapes are NOT interchangeable for the same wallet:
 *  - `{ privateKey: k }` and `{ signer: accountFrom(k) }` (sign-to-derive) derive DIFFERENT
 *    encryption keys (raw key bytes vs a signature over them). Switching a wallet between
 *    these two shapes changes the value/key-name/blind-index keys, so previously written
 *    data becomes unreadable AND unlisted (its lookup digests no longer match) with no error
 *    — reads simply return null. To move between them, or to use a KMS/hardware/MPC signer,
 *    pin an explicit `encryptionKey` so the AES key never depends on the signer shape.
 *  - Sign-to-derive requires a DETERMINISTIC signer whose signTypedData returns the standard
 *    65-byte ECDSA form. Non-deterministic (some MPC/threshold) or alternate-encoding
 *    signers (EIP-2098 compact, ERC-1271/6492 smart accounts) either rotate the key per call
 *    or are rejected — those MUST pass an explicit `encryptionKey`.
 *  - The sign-to-derive signature IS secret-grade material: whoever obtains it can derive all
 *    of this wallet's AgentKV keys. Treat it like a private key (do not log / expose it).
 */
export type AgentKVOptions = AgentKVCommon &
  (
    | { privateKey: `0x${string}` }
    | { signer: Signer; encryptionKey: Uint8Array | `0x${string}` }
    | { signer: Signer }
    | { accountKey: string; encryptionKey: Uint8Array | `0x${string}` }
  );

/** Per-write options. */
export interface SetOptions {
  /** Time-to-live in days (server default 90). */
  ttlDays?: number;
  /** If true, reads do not extend expiry (server default false). */
  strictTtl?: boolean;
  /**
   * Stable key identifying this logical write, reused across retries so a
   * retried set() (after a crash/timeout) is exactly-once: the server hits its
   * idempotency record instead of charging again. Defaults to a fresh value
   * (each call is a distinct write).
   */
  idempotencyKey?: string;
}

/** Per-read options. */
export interface GetOptions {
  /**
   * Stable key making a retried get() exactly-once: the same key hits the
   * server's read idempotency record (credit path) and pins the EIP-3009 nonce
   * (paid path) instead of charging again. Defaults to a fresh value per call
   * (each get() is a distinct, separately-charged read).
   */
  idempotencyKey?: string;
}

/** Result of a successful write. */
export interface SetResult {
  ok: true;
  expires_at: string;
  /** Machine-readable usage envelope for this write. Absent only if the server predates it. */
  usage?: UsageBlock;
}

/** Result of a successful delete. */
export interface DeleteResult {
  ok: true;
}

/** Result of a successful credit deposit. */
export interface DepositResult {
  credits_added: number;
  balance: number;
}

/** Standard AgentKV error response body. */
export interface ErrorBody {
  error: string;
  code: string;
  hint?: string;
}

/** CAIP-2 network used when none is supplied (Base mainnet). */
export const DEFAULT_NETWORK = "eip155:8453";
