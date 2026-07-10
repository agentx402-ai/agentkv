# AGENTS.md — agent/contributor guide for this repo

Cross-tool agent instructions (the [agents.md](https://agents.md) convention).
`CLAUDE.md` references this file; keep tool-specific notes there, shared truth here.

## What this repo is

Open-source **client surface** for AgentKV — an agent-native, x402-paid, zero-knowledge
encrypted KV store (service at `api.agentx402.ai`; the server is not in this repo).
npm-workspaces monorepo:

| Workspace | Package | What it is |
|---|---|---|
| `client/` | `@agentkv/client` | SDK — encryption, x402 payments, credits, bootstrap |
| `cli/` | `@agentkv/cli` | CLI + `agentkv mcp` MCP server (wraps the client) |
| `plugin/` | (not published to npm) | Claude Code plugin wrapping the MCP server |

`@agentx402-ai/core` (shared x402/EIP-712 platform SDK) lives in its own repo
(`agentx402-ai/core`) and is consumed as a normal dependency.

## Commands

```bash
npm ci                 # install (root; workspaces hoisted)
npm run build          # client then cli (order matters — cli depends on client)
npm run typecheck      # tsc --noEmit, both workspaces
npm test               # builds client first (pretest), then client + cli suites (vitest)
npm run lint           # biome ci .   (CI gate — run before pushing)
npm run format         # biome check --write .
npm --workspace client test -- account-topoff   # one file, vitest filename filter
```

Git hooks come from `.githooks/` (wired by `npm ci` via `core.hooksPath`).

## Conventions

- TypeScript, ESM, Biome for lint+format. Match the existing comment density — this
  codebase explains *why*, especially around payment logic.
- Conventional commits: `type(scope): subject` (`feat(client): …`, `fix(cli): …`),
  imperative, with a short explanatory body for anything non-obvious. No trailers.
- Tests live in `<workspace>/test/`, colocated by feature (`account-inline.test.ts`,
  `account-topoff.test.ts`, …). New behavior ships with tests; bug fixes ship with a
  regression test that fails on the pre-fix code.
- This is a public repo: no scratch files, planning notes, or internal references in
  commits. `.superpowers/` is gitignored scratch — leave it that way.

## Money-safety invariants (do not weaken)

Client code here authorizes real USDC payments. Two invariants are load-bearing:

1. **Bootstrap gating.** A `402` with body code `account_not_provisioned` fires the
   payer hooks (`topoffPayer`, `opInlinePayer`) ONLY when bootstrap is authorized
   (`bootstrap: true` / `AGENTKV_BOOTSTRAP` / a CLI-minted `~/.agentkv/account.json`
   key). The gate runs BEFORE credits-header ingestion (`assertBootstrapAllowed` in
   `client/src/index.ts`) so a denied 402 never seeds `knownCredits` — this ordering
   closes a race where a concurrent op could auto-fund a typo'd key. The deterministic
   regressions in `client/test/account-topoff.test.ts` (setter-trap window tests) pin
   it; if your change breaks one, the change is wrong, not the test.
2. **Spend caps.** `maxSpendUsd` / `AGENTKV_MAX_SPEND_USD` must bound every path that
   can spend, including payer-hook ceilings (`--max-amount` handed to the hook).

Error-code strings (`account_not_provisioned`, `insufficient_credits`, …) and the
x402/EIP-712 domain constants are pinned to the server's canon; parity tests here
mirror server behavior. Never rename or repurpose one unilaterally — client and
service must change in lockstep.

## Versioning & release

`RELEASING.md` is authoritative. Five version sources move in lockstep:
both `package.json`s, `client/src/index.ts` `VERSION`, `cli/src/version.ts` `VERSION`,
`plugin/agentkv/.claude-plugin/plugin.json` — plus the marketplace pin synced on
release. CI's `versions` job only cross-checks the two `package.json`s; update the
rest by hand. Publishing happens via a GitHub Release → the `publish.yml` OIDC
trusted-publishing workflow (client before cli — dependency order). Never
`npm publish` from a laptop.

## Security

See `SECURITY.md`. Never print, log, or commit account keys (`ak_…`), encryption
keys, or wallet private keys — in code, tests, or your own command output. Error
paths must keep redacting bearers. Report vulnerabilities per `SECURITY.md`, not via
public issues.
