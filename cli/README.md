# @agentkv/cli

The command-line client and MCP server for [AgentKV](https://github.com/agentx402-ai/agentkv) —
an agent-native, encrypted key-value store paid per request over [x402](https://x402.org).

No setup: AgentKV mints + manages a wallet for you on first run and defaults to the hosted
service. Just run a command:

```bash
npx @agentkv/cli set mykey '{"hello":"world"}'
agentkv get mykey
agentkv list-keys          # list your keys (paginated, free)
agentkv balance
agentkv wallet show        # your auto-created wallet — fund it, then back up the key file
agentkv deposit 1          # pre-pay credits at a tenth the pay-per-op price (once the wallet is funded)
```

Prefer to bring your own wallet? Set `AGENTKV_PRIVATE_KEY=0x…` (generate one with
`agentkv wallet new`); set `AGENTKV_ENDPOINT` to point at a different worker.

Values are encrypted client-side (AES-256-GCM) before upload. You hold **one AgentKV account**
in one of two ways, auto-detected by the CLI:

- **Wallet-as-key** (default): a signable wallet is the namespace + encryption key; deposits
  fund its own namespace. The auto-provisioned wallet uses this.
- **Account-key**: for a *managed* wallet that can't sign (e.g. [awal](https://www.npmjs.com/package/awal)),
  an opaque `ak_…` bearer token is the identity + namespace and a **local** key encrypts —
  decoupled from the paying wallet.

```bash
agentkv account new        # mint ak_… + a local encryption key (saved 0600) — BACK THEM UP, unrecoverable
agentkv account show       # status + credit balance; pass --reveal to print the raw secrets

# Fund it from ANY signing wallet (a real ≥$1 deposit creates the account on first deposit):
awal x402 pay https://api.agentx402.ai/account/deposit --headers '{"Authorization":"Bearer ak_..."}'

# Then use the account over just the bearer (no wallet, no signing):
export AGENTKV_ACCOUNT_KEY=ak_...  AGENTKV_ENCRYPTION_KEY=0x...
agentkv set mykey '{"hello":"world"}'
```

Account-key mode is selected when `AGENTKV_ACCOUNT_KEY` is set (it wins over everything,
including an explicit `AGENTKV_PRIVATE_KEY`), or when an `account.json` exists and no
`AGENTKV_PRIVATE_KEY` is set — an explicit wallet key beats the stored file, not the env key.

Prefer not to fund it by hand every time? Set `AGENTKV_TOPOFF=awal` and the CLI tops itself
off automatically instead — see `AGENTKV_TOPOFF` in Configuration below.

Prefer to skip prepaid credits entirely? Set `AGENTKV_INLINE=awal` to pay each op inline via x402
as it happens — see `AGENTKV_INLINE` in Configuration below.

A brand-new account (`agentkv account new`, never deposited into) 402s on its first paid op
instead of silently auto-funding — a typo'd or rotated key must not get funded by accident. A
key minted by `account new` and read back from its own `account.json` is auto-authorized to
bootstrap itself on that first call; an `AGENTKV_ACCOUNT_KEY` from the environment needs an
explicit `AGENTKV_BOOTSTRAP=1` — see `AGENTKV_BOOTSTRAP` in Configuration below.

## Buy USDC with a card

```bash
agentkv fund 5             # print a card→USDC onramp URL delivering USDC to your wallet on Base
```

`fund` only builds a URL (no payment, no network call). For the default Coinbase provider, set
`AGENTKV_ONRAMP_APP_ID` to a public CDP project id; swap providers with `AGENTKV_ONRAMP_PROVIDER`.

The card onramp is **Base mainnet only** — `agentkv fund` errors on a testnet network id
(`eip155:84532`); fund a testnet account from a faucet + a signing wallet instead.

## Configuration

Secrets come from the environment only — never the config file. The one exception is the
opt-in payer key for `agentkv account fund <usd> --from-key <0xhex>` (fund a decoupled account
from a wallet other than the configured one); prefer `AGENTKV_PAYER_KEY` to keep the key out of
shell history / `ps` argv.

Non-secret defaults set via `agentkv config` persist to `~/.agentkv/config.json`, which is read
before it's rewritten, so a corrupted file can't be auto-repaired — `agentkv config` fails with
`… is not valid JSON — fix or remove it`; fix or remove it by hand, then re-run `agentkv config`
to persist your settings again.

| Variable | Description |
|----------|-------------|
| `AGENTKV_PRIVATE_KEY` | Wallet key (hex). Unset → a local wallet is auto-provisioned on first use. |
| `AGENTKV_ACCOUNT_KEY` | `ak_…` bearer token — selects account-key mode. |
| `AGENTKV_ENCRYPTION_KEY` | Local AES key (hex). **Required** with `AGENTKV_ACCOUNT_KEY`; optional override in wallet mode (defaults to HKDF from the wallet key). |
| `AGENTKV_ENDPOINT` | Worker URL; defaults to `https://api.agentx402.ai`. |
| `AGENTKV_NETWORK` | `eip155:8453` (Base mainnet, default) or `eip155:84532` (Base Sepolia). |
| `AGENTKV_MAX_SPEND_USD` | Per-operation USD spend cap. |
| `AGENTKV_MAX_SESSION_SPEND_USD` | Cumulative, instance-lifetime USD cap (opt-in). |
| `AGENTKV_ONRAMP_PROVIDER` | Onramp provider id for `agentkv fund` (default `coinbase`). |
| `AGENTKV_ONRAMP_APP_ID` | Public CDP project id for the Coinbase onramp. |
| `AGENTKV_TOPOFF` | Account-key auto top-off payer. Only value: `awal` — pays `/account/deposit` via `npx awal x402 pay` when credits run low. Requires an authenticated, funded awal. |
| `AGENTKV_PREPAY_WATERMARK` | Top off when tracked credits fall below this (USD). Default `0.5`. Requires `AGENTKV_TOPOFF`. |
| `AGENTKV_PREPAY_TOPOFF` | Top-off amount (USD, >= 1). Default `1`. Requires `AGENTKV_TOPOFF`. |
| `AGENTKV_INLINE` | Account-key inline pay-per-op payer. Only value: `awal` — pays each `/kv` op via `npx awal x402 pay` at request time, no prepaid credits required. Requires an authenticated, funded awal. If both `AGENTKV_TOPOFF` and `AGENTKV_INLINE` are set, top-off takes precedence per op. |
| `AGENTKV_BOOTSTRAP` | Account-key only. `1`/`true` opts in to letting `AGENTKV_TOPOFF`/`AGENTKV_INLINE` pay the *first-ever* op on a brand-new, unfunded account (an `account_not_provisioned` 402), not just ordinary out-of-credit 402s. Auto-`true` when the key came from this CLI's own minted `account.json` (never from an env-supplied `AGENTKV_ACCOUNT_KEY`). Rejected in wallet mode. |

For the long-lived `agentkv mcp` server, set **both** `AGENTKV_MAX_SPEND_USD` and
`AGENTKV_MAX_SESSION_SPEND_USD` — see MCP server below.

On the awal path `AGENTKV_PREPAY_TOPOFF` is passed only as a `--max-amount` ceiling — the
worker's `/account/deposit` 402 quotes the actual amount minted (≥ $1 server minimum), capped at
that ceiling, so raising it above the server minimum may not increase what actually gets deposited.

If awal is unauthenticated or unfunded the op fails with `account_topoff_failed` — run
`npx awal status`; fund by sending USDC to `awal address`.

## MCP server

`agentkv mcp` runs an MCP server over stdio exposing `agentkv_set`, `agentkv_get`,
`agentkv_delete`, `agentkv_list_keys`, `agentkv_deposit`, `agentkv_balance`,
`agentkv_wallet_address`, and `agentkv_fund` (card→USDC onramp URL), plus four secret-safe
tools (`agentkv_set_from_env` / `_from_file`, `agentkv_get_to_file` / `run_with_secret`), to
Claude Desktop / Code / Cursor and any MCP client.

In account-key mode (`AGENTKV_ACCOUNT_KEY` set, or a stored account with no `AGENTKV_PRIVATE_KEY`)
the two wallet-funding tools — `agentkv_deposit` and `agentkv_fund` — refuse with a structured
error, since a managed account has no wallet to deposit or buy USDC into; fund it by depositing to
`<endpoint>/account/deposit` from a signing wallet instead.

Because the MCP server is a long-lived process handling many calls over its lifetime, set
**both** `AGENTKV_MAX_SPEND_USD` and `AGENTKV_MAX_SESSION_SPEND_USD` (see Configuration above) —
a per-op cap alone still leaves cumulative spend across the session unbounded. This matters most
for `agentkv_deposit`: unlike `agentkv_get`/`agentkv_set`, a deposit amount is caller-chosen
rather than server-quoted, so it is not subject to the built-in per-op price ceiling that
protects an unconfigured client from an inflated quote — without `AGENTKV_MAX_SPEND_USD`, the
session cap is the only limit on how much a single `agentkv_deposit` call can spend. If
`AGENTKV_MAX_SESSION_SPEND_USD` is unset, `agentkv mcp` prints a warning to stderr at startup —
the check is on the session cap alone, so setting `AGENTKV_MAX_SPEND_USD` does not silence it.

See the [monorepo README](https://github.com/agentx402-ai/agentkv#readme) for the SDK and the
Claude plugin.

## License

[MIT](./LICENSE)
