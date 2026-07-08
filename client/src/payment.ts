// client/src/payment.ts
//
// The payment/auth-header building plumbing that lived here now lives in
// `@agentx402-ai/core` (a future second service package reuses it too). This file
// is now a back-compat re-export shim under the SAME names so existing
// `from "./payment"` imports (and client/test/payment.test.ts's back-compat
// smoke test) keep resolving unchanged. The deep test coverage for this logic
// now lives in `core/test/payment.test.ts`.

export type { IdentityHeaders } from "@agentx402-ai/core";
export {
  buildBearerHeaders,
  buildIdentityHeaders,
  buildPaymentHeader,
  challengePriceUsd,
  decodeBase64Utf8,
  freshNonce,
  nonceFromIdempotencyKey,
  nowSec,
} from "@agentx402-ai/core";
