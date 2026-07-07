// core/src/usage.ts

/**
 * Machine-readable usage envelope the backend attaches to a paid op's success
 * body. Mirrors the backend's canonical `UsageBlock` FIELD-FOR-FIELD — client and
 * backend are separate packages that can't share an import, so keep this in
 * lockstep by hand with the backend's shape. Kept in @agentx402/core so a second
 * service SDK can reuse the same shape without re-declaring it.
 */
export interface UsageBlock {
  service: string;
  op: string;
  /**
   * USD ACTUALLY charged for THIS op on the taken path (NOT the list price).
   * The credit path spends at the 10x discount, so it does NOT equal
   * `list_price_usd`. A cache hit is a free serve -> `price_usd: 0`.
   */
  price_usd: number;
  /**
   * Pay-per-op LIST price in USD — the un-discounted reference rate a
   * budgeting agent compares `price_usd` against.
   */
  list_price_usd: number;
  /** Prepaid credits debited from the ledger for this op (0 on the x402 pay-per-op path). */
  credits_charged: number;
  cache_hit?: boolean;
}
