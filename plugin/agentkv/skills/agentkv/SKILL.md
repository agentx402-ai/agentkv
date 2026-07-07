---
name: agentkv
description: Use AgentKV to read and write persistent, encrypted key-value data that survives across sessions. Wallet-native by default (your wallet is the namespace, no signup), with an opt-in account-key (ak_ bearer token) mode for managed wallets that can't sign; paid in USDC via x402, zero-knowledge to the server. Use for durable cross-session memory and shared fleet state; for secrets/credentials use the secret-safe tools (set_from_env/set_from_file, get_to_file/run_with_secret) so the plaintext never enters the model context.
---

# AgentKV Skill

AgentKV is an agent-native key-value store. You hold **one AgentKV account**, held one of two ways (auto-detected by the client) — same data, same credits, same zero-knowledge encryption:

- **Wallet-as-key** (the default): a signable wallet *is* the account. Its **address is the namespace** and its key derives the AES key. AgentKV auto-provisions one on first use — no accounts, no API keys, no sign-up.
- **Account-key**: for a *managed* wallet that can't sign (e.g. [awal](https://github.com/agentx402-ai/awal)), an opaque `ak_…` **bearer token** is the identity + namespace and a **local** encryption key encrypts — decoupled from the paying wallet, so any signing wallet can fund the account.

Values are encrypted client-side (AES-256-GCM) before reaching the server, so the server is zero-knowledge. Storage costs real USDC on Base (mainnet) or Base Sepolia (testnet), charged per operation via the x402 protocol.

> **Prerequisite:** `@agentkv/cli` must be published to npm and resolvable via `npx @agentkv/cli`. As of this writing the package is not yet published — this plugin is the artifact pending that publication step.

---

## When to use AgentKV

Use AgentKV when you need:

- **Persistent cross-session memory** — facts, preferences, summaries, or task state that must survive when the current session ends.
- **Secret storage & use** — API keys, tokens, or credentials. The server only ever sees ciphertext (zero-knowledge). ⚠️ Plain `agentkv_set`/`agentkv_get` route the value through *this agent's model context*; for real secrets use the secret-safe tools (`agentkv_set_from_env`/`_from_file` to store, `agentkv_get_to_file`/`agentkv_run_with_secret` to use) so the plaintext never enters a model turn. See **Secrets** below.
- **Shared fleet state** — multiple agent instances that share a single wallet can coordinate through a common namespace (e.g., a job queue, a lock, a shared counter).
- **TTL-bounded scratch state** — temporary values (e.g., a nonce, a draft) with automatic expiry so you never have to clean up manually.

Do NOT use AgentKV for:

- Large binary blobs (max value size is 256 KB).
- Free, zero-cost operations in a budget-sensitive context — every `set` and `get` costs USDC; check the spend cap first.
- Replacing a proper database in a user-facing application (it is designed for agent workloads, not high-throughput web apps).

---

## Available MCP Tools

The `agentkv` MCP server exposes twelve tools — eight core, plus four **secret-safe** tools whose plaintext never enters the model context (see **Secrets** below):

| Tool | Description | Cost |
|------|-------------|------|
| `agentkv_set` | Write an encrypted value under a key. Accepts an optional TTL (days). | ~$0.005 USDC |
| `agentkv_get` | Read and decrypt a value by key. Sliding TTL resets expiry by default. | ~$0.003 USDC |
| `agentkv_delete` | Delete a key immediately. | Free |
| `agentkv_deposit` | Deposit USDC credits to the wallet's namespace to pre-fund operations. **Refused in account-key mode** (a managed account has no wallet — fund it via `<endpoint>/account/deposit`). | USDC purchase |
| `agentkv_balance` | Check the current USDC credit balance for the wallet namespace. | Free |
| `agentkv_wallet_address` | Return the wallet address (namespace identifier). Informational. | Free |
| `agentkv_fund` | Return a card→USDC onramp URL that delivers USDC to the wallet on Base. Builds a URL only — no payment is made. **Refused in account-key mode** (no wallet to buy USDC into). | Free |
| `agentkv_list_keys` | List this wallet's stored keys — the real key NAMES, decrypted locally; the server sees only opaque digests. Paginated. | Free |
| `agentkv_set_from_env` | Store a secret read from a local **env var** (pass the NAME). Value never enters the model context. | ~$0.005 USDC |
| `agentkv_set_from_file` | Store a secret read from a local **file** (pass the PATH). Contents never enter the model context. | ~$0.005 USDC |
| `agentkv_get_to_file` | Decrypt a value to a local **file**; returns `{ found, path, bytes }` — never the value. | ~$0.003 USDC |
| `agentkv_run_with_secret` | Run a command with the secret injected into the child process **env only**; returns the command's output, never the secret. | ~$0.003 USDC |

> **Pricing & deposits:** pay-as-you-go is ~$0.005 per `agentkv_set` and ~$0.003 per `agentkv_get`. Pre-paid credits cost roughly **1/10** of that (≈ $0.0005 per set, ≈ $0.0003 per get). `agentkv_deposit` requires a **$1.00 minimum** and funds the namespace at the discounted credit rate.

---

## Secrets — keep the value out of the model context

`agentkv_set` and `agentkv_get` route the value through **this agent's own model context** (it is a tool argument on write, a tool result on read). Client-side encryption makes values zero-knowledge **to the server** — it does **not** hide them from the agent. So plain `set`/`get` are fine for **non-secret memory** (plans, summaries, preferences), but for **real credentials** use the secret-safe tools so the plaintext never enters a model turn:

- **Store:** `agentkv_set_from_env` (pass an env var NAME) or `agentkv_set_from_file` (pass a PATH). The server reads the value locally, encrypts, and stores it.
- **Use:** `agentkv_run_with_secret` (runs a command with the secret in the child process's env only and returns the command's output) or `agentkv_get_to_file` (writes the decrypted value to a local file and returns the path — delete it when done).

Residual: the secret materializes briefly in a local file or child-process env — local and ephemeral, never sent to a model provider or written to conversation history. `agentkv_run_with_secret` (no file on disk) is the tightest.

---

## One-Time Setup

Install the plugin from Claude Code's marketplace — the exact `/plugin marketplace add` and
`/plugin install` commands are in the plugin's `README.md` (`plugin/README.md`). After install:

### 1. Credentials (entered at install, not via shell env)

When the plugin is installed, Claude Code **prompts** for these and threads them into the MCP
server for you (the private key is masked and stored in your OS keychain — never written to disk):

| Config | Required | Description |
|--------|----------|-------------|
| Wallet private key | No | Optional — leave blank and AgentKV mints + manages a local wallet on first use (then fund + back it up). To bring your own: an EVM private key (hex), the wallet that pays + owns the namespace. |
| AgentKV endpoint | No | The hosted AgentKV API; defaults to `https://api.agentx402.ai`. |
| Network | No | `eip155:8453` (Base mainnet, default) or `eip155:84532` (Base Sepolia testnet). |
| Encryption key | No | Override the derived AES key (advanced; defaults to HKDF from the private key). |
| Max per-operation spend (USD) | No | Refuse any single operation that would cost more than this; empty = no per-op cap. |
| Max session spend (USD) | No | Refuse operations once cumulative session spend exceeds this; empty = no cap. |

Re-run `/plugin` to change these later. Verify the server loaded with `/mcp` (you should see the
`agentkv` server and its twelve tools).

To fund with a card instead of an existing USDC balance, the `agentkv_fund` tool returns a
Coinbase onramp URL — configure it by setting `AGENTKV_ONRAMP_APP_ID` (a public CDP project id) on
the server, and optionally `AGENTKV_ONRAMP_PROVIDER` to swap providers.

### 2. Fund the namespace

Read your wallet address with `agentkv_wallet_address`, send USDC to it on Base (or call
`agentkv_fund` for a card→USDC onramp URL that delivers USDC to that address), then call
`agentkv_deposit` with an amount (minimum **$1**) to credit the namespace. Reads and writes are
then paid automatically from credits.

### Account-key mode (managed wallets / awal)

A managed wallet that can't sign uses **account-key mode** instead of a wallet. Outside the plugin,
the CLI mints and funds an account:

```bash
agentkv account new        # mint ak_… + a local encryption key (saved 0600) — BACK THEM UP, unrecoverable
# Fund it from ANY signing wallet (a real ≥$1 deposit creates the account on the first deposit):
awal x402 pay https://api.agentx402.ai/account/deposit --headers '{"Authorization":"Bearer ak_..."}'
```

Then set `AGENTKV_ACCOUNT_KEY=ak_…` and `AGENTKV_ENCRYPTION_KEY=0x…` (the local AES key — required
in account mode, there's no wallet to derive one from). The account is the namespace; by default
reads/writes carry only the bearer and debit prepaid credits — no per-op signature. Either way it
stays zero-knowledge to the server. Any signing wallet can top up the same account.

With `AGENTKV_TOPOFF=awal` also set, insufficient credits self-heal — no action needed, the
CLI/MCP session pays its own top-off via awal and continues. Without it, on an
insufficient-credits error run `awal x402 pay <endpoint>/account/deposit --headers
'{"Authorization":"Bearer <ak>"}'` and retry. Alternatively, set `AGENTKV_INLINE=awal` to pay per-op inline: each
request carries a payment signature alongside the bearer and settles on-chain immediately, so
prepaid credits aren't required at all.

---

## Spend-Cap Awareness

Every `agentkv_set`, `agentkv_get`, and `agentkv_deposit` call costs real USDC (`agentkv_delete`, `agentkv_balance`, `agentkv_wallet_address`, `agentkv_fund`, and `agentkv_list_keys` are free). Before starting a loop or bulk operation:

1. Call `agentkv_balance` to confirm sufficient credits.
2. Set a **Max per-operation spend (USD)** and/or **Max session spend (USD)** ceiling in the plugin config (run `/plugin` to edit).
3. If a tool call returns a 402 Payment Required error and no spend budget remains, pause and report to the user rather than retrying blindly.

The server returns a `PAYMENT-REQUIRED` challenge when credits are exhausted; the CLI handles the x402 payment automatically within the spend cap.

---

## Shared Fleet State Pattern

When multiple agents share a single `AGENTKV_PRIVATE_KEY` (same wallet = same namespace), they can coordinate via well-known keys:

```
fleet:lock:<task-id>     # distributed lock (set with short TTL)
fleet:queue              # serialized job list
fleet:result:<task-id>   # output from a completed subtask
```

Use short TTLs on locks to prevent stale holds if an agent crashes.

---

## Key Naming Conventions

- Use `:` as a separator: `session:<id>:summary`, `secret:github-token`, `prefs:language`. Store/read `secret:*` keys with the secret-safe tools (`agentkv_set_from_env`/`_from_file`, `agentkv_get_to_file`/`run_with_secret`) — **never** plain `set`/`get` — so the credential never enters the model context.
- Prefix user-specific data with a stable identifier: `user:<handle>:...`.
- Use `agentkv_wallet_address` to confirm which namespace you are operating in before writing shared fleet state.
