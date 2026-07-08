// core/src/idempotency.ts
//
// Nonce helpers shared by the identity-signing and x402-payment paths.

import { keccak256, stringToHex, toHex } from "viem";

/** A fresh random bytes32 nonce (0x-prefixed, 64 hex chars). */
export function freshNonce(): `0x${string}` {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Derive a deterministic bytes32 EIP-3009 nonce from a caller idempotency key,
 * so retrying a logical write reuses the same authorization and the server's
 * idempotency record is hit (exactly-once across caller retries).
 */
export function nonceFromIdempotencyKey(key: string): `0x${string}` {
  return keccak256(stringToHex(key));
}
