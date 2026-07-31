// client/test/error-mapping.test.ts
//
// The response→error mapper. `client/test/errors.test.ts` pins the CLASS identity
// (cross-package `instanceof`); this file pins the MAPPING — that a worker body's
// `code`/`hint` survive onto the thrown error, and that the code table matches the
// service's canon. Mirror of `@agentscout/client`'s error-mapping.test.ts.

import { describe, expect, it } from "vitest";
import { AgentKVError, AgentKVServiceError, kvErrorFromResponse } from "../src/errors";

describe("kvErrorFromResponse", () => {
  it("maps a worker { error, code, hint } body to a typed AgentKVServiceError", () => {
    const e = kvErrorFromResponse(
      400,
      JSON.stringify({
        error: "invalid key",
        code: "invalid_key",
        hint: "key must match [A-Za-z0-9._:-]{1,200}",
      }),
      "set failed",
    );
    expect(e.code).toBe("invalid_key");
    expect(e.status).toBe(400);
    expect(e.hint).toBe("key must match [A-Za-z0-9._:-]{1,200}");
    expect(e.message).toContain("invalid key");
  });

  // Regression: the mapper used to parse only { error, code }. The worker puts the
  // GENERIC message in `error` and the ACTIONABLE detail in `hint`, so dropping `hint`
  // silently discarded the useful half of every service error.
  it("preserves the hint — the worker's actionable detail, not just its canned message", () => {
    const e = kvErrorFromResponse(
      402,
      JSON.stringify({
        error: "insufficient credits",
        code: "insufficient_credits",
        hint: "deposit with `agentkv deposit 5`",
      }),
      "get failed",
    );
    expect(e.hint).toBe("deposit with `agentkv deposit 5`");
  });

  it("leaves hint undefined when the worker sent none", () => {
    const e = kvErrorFromResponse(
      404,
      JSON.stringify({ error: "not found", code: "not_found" }),
      "get failed",
    );
    expect(e.code).toBe("not_found");
    expect(e.hint).toBeUndefined();
  });

  it("falls back to request_failed on a non-JSON body, keeping the status + fallback label", () => {
    const e = kvErrorFromResponse(500, "<html>502 bad gateway</html>", "get failed");
    expect(e.code).toBe("request_failed");
    expect(e.status).toBe(500);
    expect(e.message).toContain("get failed");
  });

  it("is catchable as AgentKVError — the CLI dispatches on the base class", () => {
    const e = kvErrorFromResponse(400, "{}", "failed");
    expect(e).toBeInstanceOf(AgentKVServiceError);
    expect(e).toBeInstanceOf(AgentKVError);
  });

  // The worker canon, pinned to the status each code is actually emitted with. Keep in
  // lockstep with the service's own `ErrorCode` union — client and service must change
  // together, so a code renamed on one side and not the other is what this table catches.
  // `not_implemented` is the one member of that union with no row: it is thrown only by
  // the MPP verifier stub, never returned through `errorResponse`, so it has no status to
  // pin. It stays in `AgentKVErrorCode` (the client must remain a superset of the
  // service's taxonomy) but inventing a status for it here would pin a fact that is false.
  it.each([
    ["invalid_request", 400],
    ["invalid_key", 400],
    ["value_too_large", 400],
    ["payment_required", 402],
    ["payment_invalid", 402],
    ["insufficient_credits", 402],
    ["account_not_provisioned", 402],
    ["auth_required", 401],
    ["invalid_account_key", 401],
    ["account_not_found", 401],
    ["not_found", 404],
    ["already_processed", 409],
    ["idempotency_conflict", 409],
    ["rate_limited", 429],
    ["internal_error", 500],
    ["facilitator_unavailable", 503],
  ])("preserves worker code %s with status %i", (code, status) => {
    const e = kvErrorFromResponse(status, JSON.stringify({ error: code, code }), "op failed");
    expect(e.code).toBe(code);
    expect(e.status).toBe(status);
  });
});
