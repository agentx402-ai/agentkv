# @agentkv/client

The TypeScript SDK for [AgentKV](https://github.com/agentx402-ai/agentkv) — an agent-native,
encrypted key-value store paid per request over [x402](https://x402.org). **Wallet-native by
default** — your wallet address is the namespace, no signup — with an opt-in **account-key mode**
(an `ak_…` bearer token that owns the namespace, decoupled from the paying wallet) for managed
wallets that can't sign. Values are **encrypted client-side** (AES-256-GCM) before they leave your
process, so the server is zero-knowledge.

```bash
npm install @agentkv/client
```

```ts
import { AgentKV } from "@agentkv/client";

const kv = new AgentKV({ privateKey, endpoint: "https://api.agentx402.ai" });

await kv.deposit(1); // pre-pay $1 of USDC credits
await kv.set("session:plan", plan); // encrypted client-side, stored as ciphertext
const restored = await kv.get("session:plan"); // decrypted locally
await kv.delete("session:plan");
const credits = await kv.balance();
```

### Account-key mode (managed wallets that can't sign)

Pass an `ak_…` bearer token plus a **local** encryption key instead of a wallet. The bearer owns
the namespace and its prepaid credits; any signing wallet funds it (the payer funds, the bearer
owns). Mint the pair with `agentkv account new`.

```ts
const kv = new AgentKV({
  accountKey: process.env.AGENTKV_ACCOUNT_KEY as string, // ak_<64 hex>
  encryptionKey: process.env.AGENTKV_ENCRYPTION_KEY as `0x${string}`, // required — no wallet to derive from
  endpoint: "https://api.agentx402.ai",
});

await kv.set("session:plan", plan); // bearer-authenticated; debits prepaid credits
```

In account-key mode `deposit()` throws (there is no wallet to sign an x402 payment) — fund the
account instead by depositing to `<endpoint>/account/deposit` from any signing wallet, e.g. with
[awal](https://www.npmjs.com/package/awal).

### `topoffPayer` — account-key auto top-off

Account-key mode has no signing wallet, so it cannot pay a 402 itself. Configure
`prepay` + `topoffPayer` and the client delegates top-offs to your hook:

```ts
const kv = new AgentKV({
  accountKey, encryptionKey, endpoint,
  prepay: { watermark: 0.5, topoff: 1 },          // USD; topoff >= $1 (server minimum)
  topoffPayer: async ({ depositUrl, accountKey, amountUsd, maxAmountAtomic }) => {
    // pay `depositUrl` with ANY signing wallet, authorized by
    // `Authorization: Bearer ${accountKey}`, capped at maxAmountAtomic.
    // Resolve once settled; reject to surface `account_topoff_failed`.
  },
});
```

Fired single-flight when tracked credits drop below `prepay.watermark`
(failure non-fatal: the op proceeds on remaining credits) and on an
insufficient-credits 402 (failure fatal; on success the op retries once with
the same `Idempotency-Key` — exactly-once). Top-offs count against
`maxSessionSpendUsd` only, never the per-op `maxSpendUsd`. Both of
`prepay`/`topoffPayer` are required together in account-key mode;
`topoffPayer` is rejected in wallet mode.

### `opInlinePayer` — inline pay-per-op (no prepay)

An alternative to `topoffPayer` for account-key mode: instead of buying a
prepaid-credit top-off, `opInlinePayer` routes the **whole failing op** through
an external x402 transport (e.g. [awal](https://www.npmjs.com/package/awal)'s
`awal x402 pay`) that does its own discovery → pay → retry:

```ts
const kv = new AgentKV({
  accountKey, encryptionKey, endpoint,
  opInlinePayer: async ({ url, method, body, headers, maxAmountAtomic }) => {
    // Send `url`/`method`/`body`/`headers` (already bearer- and
    // Idempotency-Key-authenticated) through your own 402-aware transport,
    // capped at `maxAmountAtomic`, and return its final response.
    return { status, body, headers };
  },
});
```

No `prepay` required — it is pay-per-op, fired directly off a hard 402 with no
watermark/top-off machinery. Rejected (`invalid_config`) in wallet mode (a
signing wallet pays its own x402 challenges directly).

**Precedence, if you configure both `topoffPayer` and `opInlinePayer`:**
`topoffPayer` always wins. The two hooks are mutually exclusive **per op** —
`opInlinePayer` only ever fires when no `topoffPayer` is configured at all, so
a single op can never trigger both a deposit top-off and an inline payment.
Pick one strategy per client instance: `topoffPayer` if you want a standing
credit balance (cheaper per-op, but requires prepay bootstrapping), or
`opInlinePayer` if you want strict pay-per-op with no balance to manage.

**The account must already exist.** Auto top-off maintains a funded account; it does not
create one. A brand-new `ak_…` has no server-side account until its first deposit, so the
first op returns `account_not_found` (401) rather than a credits 402 — the hook does not fire
on a 401 (that error is indistinguishable from a typo'd or rotated key, so auto-depositing on
it could fund the wrong namespace). Bootstrap the account with one explicit deposit first
(e.g. `fundAccount(payer, 1)` or an out-of-band `awal x402 pay …/account/deposit`); after it
exists, `topoffPayer` keeps it funded.

The same applies to `opInlinePayer`: it also only fires on a `402`, and a brand-new account
401s before it ever sees one, so it cannot bootstrap a fresh account either — deposit once
first, same as above.

- **Usage envelope is asymmetric** — writes get it inline on `SetResult.usage`; reads need the
  separate `getWithUsage(key)` accessor (returning `{ value, usage }`), since `get()` keeps its
  `Promise<T | null>` signature unchanged.
- **Identity & payment are structural** — free/credit ops are EIP-712 identity-signed (or, in
  account-key mode, bearer-authenticated); paid ops settle USDC via x402 (EIP-3009
  `transferWithAuthorization`).
- **Zero-knowledge** — an AES-256-GCM key is derived (HKDF from the wallet key, or an explicit
  `encryptionKey`); the server only ever stores ciphertext it cannot read.
- **Pay per request** — pay-as-you-go in USDC, or pre-pay credits at **a tenth** the pay-per-op
  price. `prepay: { watermark, topoff }` keeps credits auto-topped-up, and `maxSpendUsd` /
  `maxSessionSpendUsd` cap per-call and cumulative spend.

See the [monorepo README](https://github.com/agentx402-ai/agentkv#readme) for the CLI, MCP server,
and Claude plugin.

## License

[MIT](./LICENSE)
