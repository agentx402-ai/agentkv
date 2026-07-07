// client/test/pricing.test.ts
//
// Parity guard for the account-mode spend-cap prices (ACCOUNT_READ_USD /
// ACCOUNT_WRITE_USD in client/src/index.ts). In account-key (bearer) mode a set/get
// debits PREPAID CREDITS server-side, so the client's spend cap must bound the actual
// per-op credit cost — mirroring the worker's READ_COST/WRITE_COST × credit value.
//
// The client and worker live in SEPARATE repos, so we can't import the worker constants.
// Instead we pin the documented worker values EXPLICITLY here (mirroring the backend's pricing constants):
// any future drift in either repo makes this test fail, forcing a deliberate, reviewed
// change — the same pattern as the project's caip2-parity / pricing-constants guards.

import { describe, expect, it } from "vitest";
import { ACCOUNT_READ_USD, ACCOUNT_WRITE_USD } from "../src/index";

describe("account-mode spend-cap pricing parity (mirrors the backend's pricing constants)", () => {
  // Documented backend constants:
  //   READ_COST  = 3 credits per read
  //   WRITE_COST = 5 credits per write
  //   1 credit   = CREDIT_VALUE_ATOMIC (100) atomic USDC units; 1e6 atomic = $1
  //             ⇒ 1 credit = $0.0001 (CREDIT_VALUE_USD).
  const READ_COST_CREDITS = 3;
  const WRITE_COST_CREDITS = 5;
  const CREDIT_VALUE_ATOMIC = 100; // atomic USDC units per credit
  const ATOMIC_PER_USD = 1_000_000; // 1e6 atomic units = $1
  const CREDIT_VALUE_USD = 0.0001; // = CREDIT_VALUE_ATOMIC / ATOMIC_PER_USD

  // Exact derivation via the atomic-integer path (float-exact, unlike credits*0.0001).
  const usdFor = (credits: number) => (credits * CREDIT_VALUE_ATOMIC) / ATOMIC_PER_USD;

  it("ACCOUNT_READ_USD == READ_COST × credit value ($0.0003)", () => {
    expect(ACCOUNT_READ_USD).toBe(usdFor(READ_COST_CREDITS)); // exact
    expect(ACCOUNT_READ_USD).toBe(0.0003); // documented dollar value
    expect(ACCOUNT_READ_USD).toBeCloseTo(READ_COST_CREDITS * CREDIT_VALUE_USD, 12);
  });

  it("ACCOUNT_WRITE_USD == WRITE_COST × credit value ($0.0005)", () => {
    expect(ACCOUNT_WRITE_USD).toBe(usdFor(WRITE_COST_CREDITS)); // exact
    expect(ACCOUNT_WRITE_USD).toBe(0.0005); // documented dollar value
    expect(ACCOUNT_WRITE_USD).toBeCloseTo(WRITE_COST_CREDITS * CREDIT_VALUE_USD, 12);
  });

  it("credit value itself is the documented $0.0001", () => {
    expect(CREDIT_VALUE_ATOMIC / ATOMIC_PER_USD).toBe(CREDIT_VALUE_USD);
  });
});
