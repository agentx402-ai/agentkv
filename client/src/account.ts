// client/src/account.ts
//
// Account-key primitives for the "account-key" auth model: a stable account
// decoupled from any paying wallet, authenticated by an opaque `ak_…` bearer
// token. A managed wallet (e.g. one that cannot sign) presents
// `Authorization: Bearer ak_…`; the worker hashes it (SHA-256) to name the
// account's storage and debits prepaid credits — NO x402, NO EIP-712.
//
// Mirrors the backend's account-key module (generation + format check). The
// client only ever holds the RAW key — it never hashes it (the worker does that
// at rest). Randomness comes from WebCrypto `crypto.getRandomValues`, available
// in Node >= 20, browsers, and Cloudflare Workers (no node:crypto).

import { bytesToHex } from "viem";

/** Prefix every account key carries; the opaque hex part follows it. */
export const AK_PREFIX = "ak_";
/** Bytes of cryptographic randomness behind an account key (→ 64 hex chars). */
export const AK_RANDOM_BYTES = 32;

// `ak_` + 64 lowercase hex chars (= AK_RANDOM_BYTES * 2).
const AK_FORMAT_RE = /^ak_[0-9a-f]{64}$/;

/**
 * Mint a fresh account key: `ak_` followed by the hex of AK_RANDOM_BYTES
 * cryptographically-random bytes. This is the bearer secret — knowing it IS the
 * capability to read/write the account. Persist it securely (e.g. a keystore);
 * the worker stores only its hash, so a lost key is unrecoverable.
 */
export function generateAccountKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(AK_RANDOM_BYTES));
  // viem's bytesToHex is 0x-prefixed lowercase; the account-key format carries no
  // 0x prefix, so drop it (`ak_` + 64 lowercase hex).
  return AK_PREFIX + bytesToHex(bytes).slice(2);
}

/** True iff `s` is a string in the canonical `ak_<64 lowercase hex>` shape. */
export function isAccountKeyFormat(s: unknown): s is string {
  return typeof s === "string" && AK_FORMAT_RE.test(s);
}
