// client/src/errors.ts
//
// The error taxonomy: the base class re-export, the `hint`-carrying subclass the
// worker's `{error, code, hint}` responses map to, the full `code` union, and the
// single response→error mapper shared by every failure path.
//
// Extracted from `index.ts` (where the mapper was a private method, unreachable from
// `cli/`) so the CLI/MCP boundaries and SDK callers share ONE mapping and ONE list of
// codes. Mirrors `@agentscout/client`'s `errors.ts` — the two service clients are
// deliberately structured alike.

import { AgentKVError, AgentXError, SpendCapError } from "@agentx402-ai/core";

// RE-EXPORT core's base + spend-cap error — never re-declare them, or cross-package
// `instanceof` breaks (two distinct class objects in node_modules). `AgentKVError` is
// core's back-compat ALIAS for `AgentXError`: the same class object, not a subclass.
// `client/test/errors.test.ts` pins that identity.
export { AgentKVError, AgentXError, SpendCapError };

/**
 * A worker `{ error, code, hint }` response, as an error. The ONLY addition over the
 * base is `hint` — the worker puts the GENERIC message in `error` (from its
 * `ERROR_MESSAGES` table) and the ACTIONABLE detail in `hint` ("key must match
 * [A-Za-z0-9._:-]{1,200}"), so dropping `hint` silently discarded the useful half of
 * every service error. Subclassing the base is allowed (core's own `SpendCapError` is
 * such a subclass); re-declaring it is not.
 *
 * Deliberately does NOT set `this.name`: core's `AgentXError` constructor pins
 * `name = "AgentKVError"` so anything logging or serializing `err.name` sees no
 * observable change, and that back-compat intent is documented in `core/src/errors.ts`.
 * `@agentscout/client` overrides `name` because it had no prior name to preserve.
 *
 * Callers branch on `e.code` (never on the class) — see AgentKVErrorCode.
 */
export class AgentKVServiceError extends AgentXError {
  constructor(
    message: string,
    code: string,
    status?: number,
    readonly hint?: string,
  ) {
    super(message, code, status);
  }
}

/**
 * The full set of `code` strings the worker + core + this SDK emit.
 *
 * A documentation/autocomplete aid for callers writing a `switch (e.code)`, NOT the
 * declared type of `AgentKVServiceError.code` — that stays `string` so a worker code
 * added ahead of an SDK release still maps cleanly instead of failing to typecheck.
 */
export type AgentKVErrorCode =
  // ---- Worker canon. Mirrors the service's own `ErrorCode` union; client and service
  // must change in lockstep, so never rename one unilaterally. ----
  | "not_found"
  | "payment_required"
  | "payment_invalid"
  | "already_processed"
  | "auth_required"
  | "invalid_key"
  | "invalid_request"
  | "value_too_large"
  | "rate_limited"
  | "idempotency_conflict"
  | "insufficient_credits"
  | "invalid_account_key"
  | "account_not_found"
  // 402 on an unprovisioned account. Payable, but auto-funding it can silently fund a
  // TYPO'D key, so the payer hooks fire only when bootstrap is authorized — see
  // `AgentKVOptions.bootstrap`. The SDK also throws this code client-side when it
  // refuses such a 402.
  | "account_not_provisioned"
  | "facilitator_unavailable"
  | "internal_error"
  // Declared in the worker's `ErrorCode` union but thrown only by its MPP verifier stub,
  // never returned through `errorResponse` — so no wired route emits it today. Listed
  // anyway: the client must stay a SUPERSET of the service's taxonomy, never drift behind it.
  | "not_implemented"
  // ---- Payment/transport, from core's x402/EIP-712 layer. The payment guards throw
  // these BEFORE any signature, so a spoofed / mismatched / hostile challenge is
  // rejected, never signed. ----
  | "payto_mismatch"
  | "spend_cap_exceeded"
  | "unpinned_network"
  | "unsupported_network"
  | "network_mismatch"
  | "asset_mismatch"
  | "domain_mismatch"
  | "invalid_challenge"
  | "invalid_amount"
  | "network_error"
  | "aborted"
  // ---- Client-side, thrown by this SDK before or around a request. ----
  // Construction/config rejected — including a malformed spend cap, which fails closed
  // (throws) rather than silently becoming "unlimited".
  | "invalid_config"
  // A runtime argument that is well-typed but out of range (e.g. a sub-atomic deposit).
  | "invalid_value"
  // A paying call was attempted with no signer configured.
  | "no_signer"
  // The op requires the other auth mode (account-key vs wallet).
  | "wrong_mode"
  // The account-key top-off hook ran but did not leave the account funded.
  | "account_topoff_failed"
  // Ciphertext failed to decrypt — wrong encryption key, or a tampered value.
  | "decrypt_failed"
  // Generic fallback in kvErrorFromResponse when the response body carries no `code`.
  | "request_failed";

/**
 * Map a worker HTTP response body to a typed error. Shared by every failure path — a
 * real `Response` (via `asError`) and the `opInlinePayer` path's plain `{status, body}`.
 * Preserves the worker's `code` (else "request_failed") and `hint`; message is
 * `AgentKV ${status}: ${detail}` where detail is the body's `error` or the fallback label.
 */
export function kvErrorFromResponse(
  status: number,
  bodyText: string,
  fallback: string,
): AgentKVServiceError {
  let detail = fallback;
  let code = "request_failed";
  let hint: string | undefined;
  try {
    const body = JSON.parse(bodyText) as { error?: string; code?: string; hint?: string };
    if (body?.error) detail = body.error;
    if (body?.code) code = body.code;
    if (body?.hint) hint = body.hint;
  } catch {
    /* non-JSON body — keep fallback + request_failed */
  }
  return new AgentKVServiceError(`AgentKV ${status}: ${detail}`, code, status, hint);
}
