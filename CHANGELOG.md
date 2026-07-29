# Changelog

All notable changes to AgentKV are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Security

- **The release pipeline no longer runs third-party code in the job that can publish.**
  `publish.yml` is split into an unprivileged build job (install, lint, build, test, audit)
  and a publish job that holds the OIDC trusted-publishing rights but runs no dependency
  code — no install, no bundler, no test runner, and `--ignore-scripts` on every npm
  invocation. It publishes only the `client/dist` + `cli/dist` handed over from the build
  job, after verifying they are a complete build. See `SECURITY.md` for what that does and
  does not cover.
- A release now refuses any ref that is not a `vX.Y.Z` tag whose commit matches all five
  version sources, so a Release tagged ahead of the committed version cannot publish the
  wrong one. A prerelease tag publishes under the `next` dist-tag rather than failing at
  npm. GitHub Actions are pinned to commit SHAs, both workflows declare least-privilege
  `permissions`, and `npm audit` gates CI and release.
- Lockfile advisories cleared: `fast-uri` 3.1.3 → 3.1.4 and `postcss` 8.5.16 → 8.5.24 (both
  high, dev chain), and `@modelcontextprotocol/sdk` 1.29.0 → 1.30.0, which pulls
  `@hono/node-server` 2.x and resolves a moderate `serve-static` path-traversal advisory.
  That advisory was **not reachable from this CLI** — `agentkv mcp` uses the stdio
  transport only, never an HTTP one — and because the SDK is declared `^1.0.0`, consumers
  resolve it through their own tree regardless. No runtime behavior change in either
  published package.

## [0.2.2] - 2026-07-29

### Changed

- Dependency floors raised to match what installs already resolve: `@agentx402-ai/core`
  `^0.1.1` (metadata-only release: corrected npm repository link) and `viem` `^2.55.10`.
  No runtime behavior change in this package.

## [0.2.1] — 2026-07-10

### Changed

- **`@agentkv/client`**: `bootstrap` is now rejected (`invalid_config`) in wallet mode
  instead of being silently ignored — parity with `topoffPayer`/`opInlinePayer` and the
  CLI's `AGENTKV_BOOTSTRAP` guard. Wallet mode signs its own x402 challenges; there is
  no unprovisioned-account bootstrap to authorize, so a misplaced option now fails loudly.
- **`@agentkv/cli`**: `AGENTKV_BOOTSTRAP` now accepts only `1`/`true`/`0`/`false`
  (case-insensitive) and throws `invalid_config` on anything else — a typo (`yes`,
  `ture`) previously coerced silently to `false`, leaving users who believed they had
  opted in with an unexplained bootstrap denial later.
- CI now cross-checks all five version sources (both `package.json`s, both `VERSION`
  constants, `plugin.json`) plus the cli→client dependency range, matching what
  `RELEASING.md` and the `version.ts` comment always claimed.

[0.2.1]: https://github.com/agentx402-ai/agentkv/releases/tag/v0.2.1

## [0.2.0] — 2026-07-10

### Added

- **`@agentkv/client`**: a new `account_not_provisioned` `402` (distinct from
  `insufficient_credits`) on a paid op against a brand-new, never-funded `ak_…` account. It is
  gated behind a new opt-in `bootstrap` constructor option (default `false`): with `bootstrap`
  unset/`false`, the `402` throws a distinguishing `AgentKVError` instead of silently paying —
  auto-funding an unprovisioned key is indistinguishable from funding a typo'd or rotated one.
  `bootstrap: true` lets `topoffPayer` / `opInlinePayer` fire on that first `402` too, funding
  and using the account in one call. `insufficient_credits` (an already-provisioned account
  merely out of credit) is unaffected — those hooks still fire unconditionally.
- **`@agentkv/cli`**: `AGENTKV_BOOTSTRAP` env var (`1`/`true`) opts a configured account-key
  client in to pay-per-call bootstrap, mirroring the client's `bootstrap` option. Account-key
  auto-authorization: when the account key is read from this CLI's own minted
  `~/.agentkv/account.json` (`agentkv account new`), `bootstrap` is enabled automatically — a
  file the CLI wrote itself can't be a typo. An `AGENTKV_ACCOUNT_KEY` supplied via the
  environment stays opt-in and requires the explicit flag. `AGENTKV_BOOTSTRAP` is rejected
  (`invalid_config`) in wallet mode, like `AGENTKV_TOPOFF` / `AGENTKV_INLINE`.

### Changed

- The worker's unpaid, unprovisioned request path for paid `kv`/`account` operations now
  returns `402 account_not_provisioned` (previously `401 account_not_found`), so a payer can
  discover and fund a fresh namespace from the same challenge that gates the operation.
  Free routes (`getBalance`, `listKeys`, `del`) on an unprovisioned account are unchanged —
  still `401 account_not_found`.
- Hook-less account-key clients (no `topoffPayer`/`opInlinePayer`) hitting
  `account_not_provisioned` now get the actionable bootstrap error message (deposit, or opt in
  via `bootstrap`/`AGENTKV_BOOTSTRAP`) instead of the raw server error — same code and status,
  friendlier text.

[0.2.0]: https://github.com/agentx402-ai/agentkv/releases/tag/v0.2.0

## [0.1.0] — Initial release

### Added

- `@agentx402-ai/core` — the shared x402/EIP-712 platform SDK: payment-header
  construction (EIP-3009 `transferWithAuthorization`), host-bound EIP-712 identity
  signing, CAIP-2 network handling, idempotency-key nonces, and a
  timeout/jitter/`Retry-After` retry layer.
- `@agentkv/client` — the SDK: client-side AES-256-GCM encryption in a versioned,
  self-describing envelope, x402/EIP-712 payments, and wallet, signer, and
  account-key auth modes. Encryption keys come from an explicit key, a private key,
  or domain-scoped EIP-712 sign-to-derive. Per-attempt request timeouts (`timeoutMs`)
  and an injectable `fetch`.
- `@agentkv/cli` — the `agentkv` CLI and `agentkv mcp` MCP server, with secret-safe
  tools, fail-closed argument parsing, and `--help` / `--version`.
- Claude Code plugin wrapping the MCP server.

### Security

- Client-side encryption uses HKDF domain-separated key material (value / key-name /
  blind-index MAC) and binds the key's blind-index digest into the AES-GCM AAD, so a
  compromised server cannot serve one key's ciphertext for a different key's request
  (the auth tag fails).
- Sign-to-derive is domain-scoped (EIP-712), so a generic-text phishing prompt cannot
  reproduce the encryption key.
- Money movement is bounded client-side: the signed EIP-3009 authorization window is
  clamped, the challenge network and canonical USDC asset are pinned, and the payer
  path is capped by `maxSpendUsd` and pre-reserved against the session spend cap before
  paying.
- `AGENTKV_PAYER_KEY` (and any `AGENTKV_*` key-material env var) is scrubbed from the
  MCP server environment and refused as a secret source.

[0.1.0]: https://github.com/agentx402-ai/agentkv/releases/tag/v0.1.0
