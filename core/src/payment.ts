// core/src/payment.ts
//
// Payment/identity header builders, plus the `Signer` interface and EIP-712 domain
// constants they depend on. These travel together because
// `buildPaymentHeader`/`buildIdentityHeaders` are not truly standalone from them —
// splitting the functions from their domain constants would force a circular
// client<->core dependency.

import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { getDefaultAsset } from "@x402/evm";
import { getAddress } from "viem";
import { AgentXError } from "./errors";
import { freshNonce } from "./idempotency";

/** Minimal signer the client needs: a viem account satisfies this structurally. */
export interface Signer {
  address: `0x${string}`;
  // viem's signTypedData is generic; accept it structurally.
  signTypedData(args: any): Promise<`0x${string}`>;
  signMessage(args: { message: string }): Promise<`0x${string}`>;
}

/** EIP-712 domain name shared with the server's EIP-712 verifier. */
export const EIP712_DOMAIN_NAME = "AgentKV";

/** EIP-712 domain version shared with the server's EIP-712 verifier. */
export const EIP712_DOMAIN_VERSION = "1";

/**
 * Hard cap on the signed EIP-3009 authorization window, regardless of the server-supplied
 * `maxTimeoutSeconds`. A signed authorization is a bearer instrument; a hostile challenge
 * asking for a multi-year window must not yield one that stays spendable indefinitely.
 */
export const MAX_AUTH_WINDOW_SEC = 3600;

/** Maps a CAIP-2 network id (e.g. "eip155:8453") to its numeric chainId. */
export function chainIdFromCaip2(network: string): number {
  const parts = network.split(":");
  if (parts.length !== 2 || parts[0] !== "eip155") {
    throw new Error(`unsupported CAIP-2 network: ${network}`);
  }
  const id = Number(parts[1]);
  if (!Number.isInteger(id) || id <= 0) {
    throw new Error(`invalid CAIP-2 chain id: ${network}`);
  }
  return id;
}

/**
 * Decode a base64 header as UTF-8 (atob → char-code bytes → TextDecoder("utf-8")).
 * The backend encodes both PAYMENT-REQUIRED and PAYMENT-RESPONSE with base64/UTF-8 and
 * documents this exact mirror decode; a bare `atob()` decodes Latin-1, which corrupts
 * any non-ASCII code point (e.g. a future "USD₮" asset name). Byte-identical for ASCII.
 */
export function decodeBase64Utf8(b64: string): string {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8").decode(bytes);
}

/** EIP-712 typed-data shape shared with the server's EIP-712 verifier. */
const REQUEST_TYPES = {
  Request: [
    { name: "method", type: "string" },
    { name: "path", type: "string" },
    // host binds the signature to one deployment (prevents cross-deployment replay) —
    // must match the backend's EIP-712 type definitions exactly, or every identity op fails to verify.
    { name: "host", type: "string" },
    { name: "nonce", type: "bytes32" },
    { name: "timestamp", type: "uint256" },
  ],
} as const;

/** Identity headers sent on free/credit operations. */
export interface IdentityHeaders {
  "X-AgentKV-Signature": string;
  "X-AgentKV-Nonce": string;
  "X-AgentKV-Timestamp": string;
}

/**
 * Bearer auth header for account-key mode. The opaque `ak_…` token IS the
 * capability: the server hashes it to name the account's storage and debits its
 * prepaid credits. NO x402, NO EIP-712 — this header replaces both. The raw key
 * travels in the clear over TLS exactly like any bearer token; never log it.
 */
export function buildBearerHeaders(accountKey: string): Record<string, string> {
  return { Authorization: `Bearer ${accountKey}` };
}

/** Current unix time in whole seconds. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/** EIP-712 typed-data types for EIP-3009 transferWithAuthorization. */
const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** Each PAYMENT-REQUIRED accept is a full v2 PaymentRequirements. */
type ChallengeAccept = PaymentRequirements;

/** Decoded PAYMENT-REQUIRED challenge body. */
interface PaymentRequiredChallenge {
  x402Version: number;
  accepts: ChallengeAccept[];
}

/**
 * Decode and validate a base64-encoded PAYMENT-REQUIRED challenge header.
 */
function decodeChallenge(paymentRequiredHeader: string): PaymentRequiredChallenge {
  let json: string;
  try {
    json = decodeBase64Utf8(paymentRequiredHeader);
  } catch {
    throw new Error("PAYMENT-REQUIRED header is not valid base64");
  }
  const parsed = JSON.parse(json) as PaymentRequiredChallenge;
  if (!parsed || !Array.isArray(parsed.accepts)) {
    throw new Error("invalid PAYMENT-REQUIRED challenge: missing accepts array");
  }
  return parsed;
}

/** Pick the exact-scheme requirement, by amount when several tiers are offered. */
function selectRequirement(accepts: ChallengeAccept[], amountAtomic?: number): ChallengeAccept {
  const exact = accepts.filter((a) => a.scheme === "exact");
  if (exact.length === 0)
    throw new Error("no acceptable x402 exact-scheme requirement in challenge");
  if (amountAtomic !== undefined) {
    // Use the first exact requirement as the asset/payTo/network/domain template and
    // override the amount — supports any top-off / deposit amount, not just advertised tiers.
    return { ...exact[0], amount: String(amountAtomic) };
  }
  if (exact.length > 1)
    throw new Error(
      "ambiguous PAYMENT-REQUIRED challenge: multiple exact requirements; specify an amount",
    );
  return exact[0];
}

/**
 * Enforce that a server-supplied challenge targets the client's configured network AND its
 * canonical USDC contract. Money movement must never be dictated solely by the server: a
 * compromised or spoofed worker could otherwise return a challenge for a different chain
 * (e.g. hand a Base-configured client an Arbitrum challenge, draining the SAME EOA's
 * Arbitrum USDC) or a non-canonical token address, and the client would sign it. This is
 * the payment-path mirror of the host-binding on identity signatures and the domain pin.
 */
function assertNetworkParity(req: ChallengeAccept, expectedNetwork: string): void {
  if (req.network !== expectedNetwork) {
    throw new AgentXError(
      `payment challenge network "${req.network}" does not match client network "${expectedNetwork}"`,
      "network_mismatch",
      0,
    );
  }
  const asset = getDefaultAsset(expectedNetwork as `${string}:${string}`);
  if (getAddress(req.asset) !== getAddress(asset.address)) {
    throw new AgentXError(
      `payment challenge asset "${req.asset}" is not the canonical USDC for ${expectedNetwork}`,
      "asset_mismatch",
      0,
    );
  }
}

/** Decode a challenge and return the chosen requirement's price in USD. */
export function challengePriceUsd(
  paymentRequiredHeader: string,
  amountAtomic?: number,
  expectedNetwork?: string,
): number {
  const { accepts } = decodeChallenge(paymentRequiredHeader);
  const req = selectRequirement(accepts, amountAtomic);
  if (expectedNetwork) assertNetworkParity(req, expectedNetwork);
  return Number(req.amount) / 1_000_000;
}

/**
 * Build the base64 PAYMENT-SIGNATURE header from a PAYMENT-REQUIRED challenge.
 *
 * Decodes the v2 challenge, selects the matching `exact`-scheme requirement
 * (by `opts.amountAtomic` when several tiers are offered), and signs an EIP-3009
 * transferWithAuthorization payload (validAfter=0, validBefore=now+window) with
 * the viem account. `opts.nonce` pins a deterministic EIP-3009 nonce so retries
 * reuse the same authorization.
 *
 * Returns the base64-encoded JSON payload as the PAYMENT-SIGNATURE value.
 */
export async function buildPaymentHeader(
  account: Signer,
  paymentRequiredHeader: string,
  opts?: {
    nonce?: `0x${string}`;
    amountAtomic?: number;
    expectedNetwork?: string;
    /** Pin the recipient: reject the challenge unless its `payTo` equals this address (high-value ops). */
    expectedPayTo?: string;
  },
): Promise<string> {
  const { x402Version, accepts } = decodeChallenge(paymentRequiredHeader);

  const req = selectRequirement(accepts, opts?.amountAtomic);

  // Pin the money-moving challenge to the client's configured network + canonical asset
  // BEFORE signing anything (a signed EIP-3009 authorization is a bearer instrument).
  if (opts?.expectedNetwork) assertNetworkParity(req, opts.expectedNetwork);
  // Optional recipient pin: the client can't know the "correct" payTo in general (the amount
  // ceiling is the primary defense), but for high-value ops a caller may pin an expected one.
  if (opts?.expectedPayTo && getAddress(req.payTo) !== getAddress(opts.expectedPayTo)) {
    throw new AgentXError(
      `payment challenge payTo "${req.payTo}" does not match expected "${opts.expectedPayTo}"`,
      "payto_mismatch",
      0,
    );
  }

  const chainId = chainIdFromCaip2(req.network);
  // Look up EIP-712 domain info for the token (name/version).
  // Cast to the x402 Network template-literal type.
  const asset = getDefaultAsset(req.network as `${string}:${string}`);

  const nonce = opts?.nonce ?? freshNonce();
  const now = nowSec();
  // Clamp the signed window: never sign an authorization valid longer than MAX_AUTH_WINDOW_SEC,
  // regardless of the server-supplied maxTimeoutSeconds.
  const window = Math.min(req.maxTimeoutSeconds ?? 300, MAX_AUTH_WINDOW_SEC);
  const validBefore = String(now + window);

  const authorization = {
    from: getAddress(account.address),
    to: getAddress(req.payTo),
    value: req.amount,
    validAfter: "0",
    validBefore,
    nonce,
  };

  const signature = await account.signTypedData({
    domain: {
      name: asset.name,
      version: asset.version,
      chainId,
      verifyingContract: getAddress(req.asset),
    },
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(account.address),
      to: getAddress(req.payTo),
      value: BigInt(req.amount),
      validAfter: BigInt(0),
      validBefore: BigInt(validBefore),
      nonce,
    },
  });

  // v2 PaymentPayload: the chosen requirement + the signed EIP-3009 authorization,
  // encoded with the SDK so the server's decodePaymentSignatureHeader round-trips.
  const paymentPayload: PaymentPayload = {
    x402Version,
    accepted: req,
    payload: {
      authorization,
      signature,
    },
  };

  return encodePaymentSignatureHeader(paymentPayload);
}

/**
 * Build EIP-712 identity headers for a free/credit op (delete, balance).
 * Signs the Request typed data with a fresh nonce + timestamp so the server
 * can recover the wallet address and enforce replay protection.
 */
export async function buildIdentityHeaders(
  account: Signer,
  args: { method: string; path: string; host: string; network: string },
): Promise<IdentityHeaders> {
  const nonce = freshNonce();
  const timestamp = nowSec();
  const signature = await account.signTypedData({
    domain: {
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: chainIdFromCaip2(args.network),
    },
    types: REQUEST_TYPES,
    primaryType: "Request",
    message: {
      method: args.method,
      path: args.path,
      host: args.host,
      nonce,
      timestamp: BigInt(timestamp),
    },
  });

  return {
    "X-AgentKV-Signature": signature,
    "X-AgentKV-Nonce": nonce,
    "X-AgentKV-Timestamp": String(timestamp),
  };
}
