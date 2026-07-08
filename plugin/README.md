# AgentKV Claude plugin

A [Claude Code](https://docs.claude.com/en/docs/claude-code) plugin that gives agents encrypted,
x402-paid persistent memory keyed by wallet address — exposed as twelve MCP tools: the seven core
operations (`agentkv_set`/`get`/`delete`/`list_keys`/`deposit`/`balance`/`wallet_address`),
`agentkv_fund` (a card→USDC onramp URL for the wallet), plus four **secret-safe** tools
(`set_from_env` / `set_from_file` / `get_to_file` / `run_with_secret`) that store and use
credentials without the value entering the model context.

> **Prerequisite:** the plugin runs `npx -y @agentkv/cli mcp`, so [`@agentkv/cli`](../cli) must be
> published to npm (or resolvable via `npx`). It is **not yet published** — until then, use the
> local-checkout method in step 1.
>
> **Windows:** `.mcp.json` uses `"command": "npx"`. Claude Code's MCP launcher resolves the
> `npx.cmd` shim on Windows automatically, so this works as-is. Other MCP clients that spawn the
> command naively (`child_process.spawn("npx", …)` without `shell: true`) throw `ENOENT` on
> Windows, since only `npx.cmd` exists on `PATH`. If you wire this server into such a client,
> set the command to `npx.cmd` (or `cmd /c npx`) there.

## Install

**1. Add the marketplace and install the plugin** — run these in Claude Code:

```text
/plugin marketplace add agentx402-ai/claude-plugins
/plugin install agentkv@agentx402
```

<details>
<summary>From a local checkout (for development)</summary>

```bash
git clone https://github.com/agentx402-ai/agentkv
cd agentkv && npm ci && npm run build
claude --plugin-dir ./plugin/agentkv
```

</details>

**2. Enter credentials when prompted.** On install, Claude Code asks for the plugin's config and
threads it into the MCP server for you — **no shell environment variables to set**:

| Prompt | Required | Notes |
|--------|----------|-------|
| Wallet private key | No | Optional — leave blank and AgentKV mints + manages a local wallet on first use. To bring your own: an EVM hex key, masked + stored in your OS keychain |
| AgentKV endpoint | No | Defaults to `https://api.agentx402.ai` (the hosted service) |
| Network | No | `eip155:8453` (Base mainnet, default) or `eip155:84532` (Base Sepolia testnet) |
| Encryption key | No | advanced; defaults to a key derived (HKDF) from the private key |
| Max per-operation spend (USD) | No | refuses any single operation costing more than this; leave empty for no per-op cap |
| Max session spend (USD) | No | refuses further operations once cumulative spend across the whole MCP session exceeds this; leave empty for no session cap |

Don't have a wallet? Generate one first with `npx @agentkv/cli wallet new` and paste that key.
To change any of these later, run `/plugin` and reconfigure the `agentkv` plugin.

**3. Verify it loaded:**

```text
/mcp
```

You should see the `agentkv` server **connected** with its twelve tools.

**4. Fund the namespace.** Read your address with the `agentkv_wallet_address` tool, send USDC to
it on Base (or call `agentkv_fund` for a card→USDC onramp URL that delivers USDC to that address),
then call `agentkv_deposit` (minimum **$1**) to credit the namespace. Reads and writes are then
paid automatically from credits.

> **Managed wallets / account-key mode.** For a managed wallet that can't sign, AgentKV supports an
> opt-in **account-key** mode (an `ak_…` bearer token owns the namespace, funded by any signing
> wallet). In that mode the two wallet-funding tools — `agentkv_deposit` and `agentkv_fund` — are
> disabled (they refuse with a structured error), since there is no wallet to deposit or buy USDC
> into; fund the account by depositing to `<endpoint>/account/deposit` instead. With
> `AGENTKV_TOPOFF=awal` set, insufficient credits self-heal automatically — no action needed;
> without it, on an insufficient-credits error run
> `awal x402 pay <endpoint>/account/deposit --headers '{"Authorization":"Bearer <ak>"}'` and retry. Prefer to
> skip prepaid credits entirely? Set `AGENTKV_INLINE=awal` instead to pay each op inline via x402
> as it happens. See the skill's **Account-key mode** section for setup.

See the [skill](./agentkv/skills/agentkv/SKILL.md) for the full tool reference, pricing, spend-cap
guidance, account-key/managed-wallet setup, and the shared-fleet-state pattern.

## Layout

- [`agentkv/`](./agentkv) — the plugin:
  [`.claude-plugin/plugin.json`](./agentkv/.claude-plugin/plugin.json) (manifest + config schema),
  [`.mcp.json`](./agentkv/.mcp.json) (MCP server wiring), and the
  [skill](./agentkv/skills/agentkv/SKILL.md).
- The plugin is published through the shared **agentx402 marketplace**
  ([`agentx402-ai/claude-plugins`](https://github.com/agentx402-ai/claude-plugins)), which
  references this directory by `git-subdir`. This repo carries no marketplace manifest of its own.

## License

[MIT](../LICENSE)
