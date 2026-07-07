# AgentKV

Open-source clients for **AgentKV** — an agent-native, encrypted key-value store paid per
request over [x402](https://x402.org). You hold **one AgentKV account**, values are
**encrypted client-side** (AES-256-GCM) so the server is zero-knowledge, and storage is paid
in **USDC**.

There are **two ways to hold an account**, auto-detected by the client — same data model,
same credits, same zero-knowledge encryption:

- **Wallet-as-key** (the default): a signable wallet *is* the account. Its address is the
  namespace and its key derives the encryption key. AgentKV auto-provisions one on first use,
  so an agent "just works" with no setup. Deposits fund the wallet's own namespace.
- **Account-key** (for *managed* wallets that can't sign — e.g. [awal](https://github.com/agentx402-ai/awal)):
  the client mints an opaque `ak_…` **bearer token** as the identity + namespace and a
  **local encryption key** to encrypt with. Both are decoupled from the paying wallet, so any
  signing wallet can fund the account and reads/writes carry only the bearer. `agentkv account new`
  mints one.

This repository holds the **client surface** — the SDK, CLI, MCP server, and Claude plugin.
The AgentKV Worker (the backend) is operated separately; these clients talk to it over the
public x402 + EIP-712 protocol.

## Packages

| Path | Package | What |
|------|---------|------|
| [`core/`](./core) | `@agentx402/core` | shared x402/EIP-712 platform SDK (auth, payment, usage) |
| [`client/`](./client) | `@agentkv/client` | TypeScript SDK — encrypt + sign + pay |
| [`cli/`](./cli) | `@agentkv/cli` | the `agentkv` command-line, and `agentkv mcp` (MCP server) |
| [`plugin/`](./plugin) | — | Claude Code plugin (wraps the MCP server) |

> **Not yet on npm.** `@agentx402/core`, `@agentkv/client`, and `@agentkv/cli` are not published yet, so
> `npm install @agentkv/client`, `npx @agentkv/cli …`, and the `/plugin install` flow below all
> fail with `E404` today. Until they publish, use a local checkout (`npm install && npm run build`,
> then reference the workspace packages) — see [`plugin/README.md`](./plugin/README.md) for the
> local-checkout setup.

## npm scope strategy

This monorepo uses **two npm scopes** to distinguish the **platform** from the **service**:

- **`@agentx402/*`** — the **platform scope**. Contains `@agentx402/core`, a shared SDK for auth,
  payment, usage tracking, error handling, and retry logic. It is independent and consumed by all
  agent-native services on the agentx402 platform. It encapsulates x402 protocol and EIP-712
  signing complexity so services don't repeat it.
- **`@agentkv/*`** — the **KV service scope**. Contains `@agentkv/client` and `@agentkv/cli`, which
  **depend on** `@agentx402/core` for shared plumbing. Both packages are specific to the AgentKV
  service.

This separation allows future services (e.g. `@agentfetch/client`) to share `@agentx402/core`
without inheriting AgentKV-specific logic.

## Quick start (SDK)

```bash
npm install @agentkv/client
```

```ts
import { AgentKV } from "@agentkv/client";

const kv = new AgentKV({ privateKey, endpoint: "https://api.agentx402.ai" });

await kv.deposit(1);                        // pre-pay $1 of USDC credits
await kv.set("session:plan", plan);         // encrypted client-side, stored as ciphertext
const restored = await kv.get("session:plan"); // decrypted locally
```

## CLI

```bash
npx @agentkv/cli wallet new                 # generate a wallet
export AGENTKV_PRIVATE_KEY=0x...            # endpoint defaults to https://api.agentx402.ai
agentkv deposit 1
agentkv set mykey '{"hello":"world"}'
agentkv get mykey
```

### Account-key mode (works with awal / any signing wallet)

For a *managed* wallet that can't sign (e.g. awal), mint an account and fund it from any
signing wallet:

```bash
agentkv account new                         # mints ak_… + a local encryption key (0600) — BACK THEM UP, they are unrecoverable
agentkv account show                        # status + balance; --reveal prints the raw secrets

# No-hook fallback: fund the account manually with a real ≥$1 deposit from ANY signing
# wallet to <endpoint>/account/deposit, authorized by the account's bearer token (creates
# the account on the first deposit):
awal x402 pay https://api.agentx402.ai/account/deposit --headers '{"Authorization":"Bearer ak_..."}'

# Then read/write over just the bearer (encrypted client-side, zero-knowledge to the server):
export AGENTKV_ACCOUNT_KEY=ak_...  AGENTKV_ENCRYPTION_KEY=0x...
agentkv set mykey '{"hello":"world"}'
agentkv get mykey
```

The client auto-selects account-key mode when `AGENTKV_ACCOUNT_KEY` is set, or when an
`account.json` file exists **and** no `AGENTKV_PRIVATE_KEY` is set — an explicit
`AGENTKV_PRIVATE_KEY` keeps wallet mode (a different namespace + encryption key). Otherwise it
uses the wallet.

#### Auto top-off (stay funded without manual deposits)

Set `AGENTKV_TOPOFF=awal` and the client keeps an **already-created** account funded
by itself: when tracked credits fall below a watermark (default $0.50) — or an op hits an
insufficient-credits 402 — it pays a top-off (default $1, the server minimum)
to `/account/deposit` via `npx awal x402 pay`, then continues the op.

```bash
export AGENTKV_ACCOUNT_KEY=ak_...  AGENTKV_ENCRYPTION_KEY=0x...
export AGENTKV_TOPOFF=awal        # optional: AGENTKV_PREPAY_WATERMARK / AGENTKV_PREPAY_TOPOFF
agentkv set mykey '{"hello":"world"}'   # tops itself off when credits run low
```

`AGENTKV_PREPAY_TOPOFF` sets the top-off **ceiling** (passed to awal as `--max-amount`), not a
fixed deposit amount — the worker's `/account/deposit` 402 quotes the actual amount minted (≥ $1
server minimum), capped at that ceiling, so raising it above the server minimum may not increase
what actually gets deposited.

**Create the account first.** A brand-new `ak_…` has no server-side account until its
**first deposit** — until then a read/write returns `account_not_found` (401), not a
credits 402, so auto top-off has nothing to top up and does **not** fire. Auto top-off
deliberately does not auto-create an account from a 401: that error is returned identically
for a fresh key, a typo'd key, or a rotated key, so minting a deposit on it would silently
fund the wrong namespace. Run one initial deposit — the no-hook fallback command above (it
*creates* the account on first deposit) — then set `AGENTKV_TOPOFF=awal`; from then on the
account stays funded with no further manual deposits.

Requires an authenticated, funded awal (`npx awal status`; fund by sending USDC to
`awal address`). SDK
users can plug any signing wallet instead via the `topoffPayer` option — see
[`client/README.md`](./client/README.md).

#### Inline pay-per-op (no prepay)

Set `AGENTKV_INLINE=awal` and the client pays for each op directly instead of maintaining a
credit balance: on a 402 it routes the whole op through `awal x402 pay` (a per-op x402
settlement, no `/account/deposit` involved) and retries once. Mutually exclusive per op with
`AGENTKV_TOPOFF` — if both are set, top-off always wins. SDK users can plug any 402-aware
transport instead via the `opInlinePayer` option — see [`client/README.md`](./client/README.md).

### Buy USDC with a card (onramp)

```bash
agentkv fund 5                              # print a card→USDC onramp URL delivering USDC to your wallet on Base
```

`fund` builds a URL only (no payment, no network call); set `AGENTKV_ONRAMP_APP_ID` (a public
CDP project id) for the default Coinbase provider, and optionally `AGENTKV_ONRAMP_PROVIDER` to
swap providers. Account-key mode has no single wallet to onramp into — fund a signing wallet,
then deposit to the account.

## MCP server / Claude plugin

`agentkv mcp` exposes the store as MCP tools — `agentkv_set`, `agentkv_get`, `agentkv_delete`,
`agentkv_list_keys`, `agentkv_deposit`, `agentkv_balance`, `agentkv_wallet_address`, `agentkv_fund`
(card→USDC onramp URL), plus four secret-safe tools
(`agentkv_set_from_env` / `_from_file`, `agentkv_get_to_file` / `run_with_secret`) for credentials
(see [SECURITY.md](./SECURITY.md)) — for Claude Desktop / Code / Cursor.

The [`plugin/`](./plugin) directory packages this as an installable **Claude Code plugin**. In
Claude Code:

```text
/plugin marketplace add agentx402-ai/agentkv
/plugin install agentkv@agentkv
```

Claude Code then prompts for your wallet private key (stored in your OS keychain) and the optional AgentKV endpoint (defaults to the hosted service), and
auto-starts the MCP server — verify with `/mcp`. Full steps: [`plugin/README.md`](./plugin/README.md).

## How it works

- **Identity & payment are structural.** In wallet-as-key mode the address is derived only
  from a verified signature; free/credit ops are EIP-712 identity-signed and paid ops settle
  USDC via x402 (EIP-3009 `transferWithAuthorization`). In account-key mode the opaque `ak_…`
  bearer is the identity (the server stores only its hash and names storage by it); ops carry
  the bearer and either debit prepaid credits (no per-op signature) or, via inline pay-per-op
  (`opInlinePayer` / `AGENTKV_INLINE`), settle an x402 payment for that op directly with no
  prepaid balance at all. Either way the paying wallet is decoupled from the data: any signing
  wallet can fund an account-keyed namespace.
- **Zero-knowledge.** The SDK derives an AES-256-GCM key (HKDF from the wallet key in
  wallet-as-key mode, or an explicit `encryptionKey` — the local key held in account-key mode)
  and encrypts every value **and key name** before they leave your process. The server only ever stores ciphertext and opaque per-wallet key digests it cannot
  read (it never sees a real key name). This protects values and key names against the **server**,
  not against an LLM operating the client: via the MCP server / Claude plugin a plain `set`/`get`
  value passes through the agent's model context — use the plugin's secret-safe tools for
  credentials (see [SECURITY.md](./SECURITY.md)). The server can still see your key count and
  access patterns.
- **Pay per request.** Pay-as-you-go in USDC, or pre-pay credits at a discount.

## License

[MIT](./LICENSE)
