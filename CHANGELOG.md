# Changelog

All notable changes to AgentKV are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`@agentkv/cli`**: `agentkv deposit` now accepts fractional USD amounts that resolve to a
  whole number of atomic USDC units (e.g. `$33.30`), reusing the client's exported
  `toWholeAtomicUsd`. A `--limit` flag that isn't a positive integer now fails closed instead
  of forwarding `NaN`/`0` to the wire.
- **`@agentkv/cli`**: `agentkv config` now persists `--onramp-provider` / `--onramp-app-id`,
  matching the endpoint/network/spend-cap flags it already saved.

### Changed

- **`@agentkv/client`**: constructor options now reject three previously-unvalidated shapes at
  construction (`invalid_config`) instead of failing later, or not at all: a missing or
  malformed `endpoint` (must be an absolute `http`/`https` URL), a non-finite `retries`, and
  `accountKey` passed alongside a wallet (`privateKey`/`signer`) — which used to silently drop
  the wallet and proceed in account-key mode instead of rejecting the ambiguous config.
  `set()`'s `ttlDays` and `listKeys()`'s `limit` are now validated the same way
  (`invalid_value`) instead of reaching the wire. A pre-existing guard — rejecting
  `privateKey` alongside an explicit `encryptionKey` — is unchanged but is now pinned by a
  regression test.
- **`@agentkv/client`**: a tampered or corrupted stored value now throws a distinguishing
  `decrypt_failed` `AgentKVError` instead of an opaque low-level crypto exception; `decrypt`
  is re-exported from the package root, so this also changes what a caller using it directly
  sees.
- **`@agentkv/client`**: `listKeys()` now normalizes an empty-string cursor from the server to
  `null`, so a `while (cursor !== null)` pagination loop terminates instead of looping forever.
- **`@agentkv/cli`**: a corrupt `wallet.json` now fails with a descriptive error naming the
  file path instead of a misleading "no wallet yet".
- **`@agentkv/cli`**: `agentkv fund` now refuses onramp amounts above $1,000,000,000 instead of
  building a URL with an implausible amount.
- Claude plugin: `plugin/agentkv/.mcp.json` now pins the MCP server to `@agentkv/cli@0.2.2`
  instead of spawning whatever is currently `@latest`; `AGENTKV_ENDPOINT` also gained the
  empty-value `:-` fallback its sibling vars already had, so a blank endpoint config can't
  leave an unexpanded placeholder overriding the hosted default.
- CI's always-on `no-internal-refs` check now runs as its own workflow instead of living
  inside `ci.yml`'s docs-`paths-ignore`'d job (docs-only pushes are exactly where an internal
  reference is most likely to land), and the build/test matrix gained Node 24 (`publish.yml`'s
  runtime). The version-lockstep check moved into `scripts/check-versions.mjs`, which also
  covers a sixth source — the plugin's pinned MCP runtime — on every pull request.
- **`@agentkv/client`**: `maxSpendUsd` / `maxSessionSpendUsd` now reject a malformed value
  (`NaN`, `Infinity`, negative, or non-number) at construction (`invalid_config`) instead of
  silently accepting it. A `NaN` cap was strictly WORSE than no cap at all: `usd > NaN` is
  always false, so it disabled both the per-op and the session cap, AND — because the built-in
  ceiling only guards an unconfigured client — it also defeated the built-in $0.05 per-op price
  ceiling that protects against a spoofed or compromised worker's inflated quote.
- **`@agentkv/cli`**: the same rule now applies to a spend cap read from `config.json` — a
  malformed persisted value throws `invalid_config` instead of reaching the SDK as `NaN`, and is
  validated even when a `--max-spend-usd` flag or `AGENTKV_MAX_SPEND_USD` env value shadows it,
  so a corrupt file can't become the live cap the moment the override is removed.
- **`@agentkv/client`**: the cumulative session cap (`maxSessionSpendUsd`) is now enforced with
  a synchronous reservation taken at the moment each spend is checked — covering ops, deposits,
  and top-offs alike — instead of only being counted after settlement. Previously, concurrent
  calls could all check against the same stale spent-so-far counter, all pass, and all sign real
  EIP-3009 authorizations, so the cumulative cap provided no bound at all under concurrency.
- **`@agentkv/cli`**: `agentkv account fund` now honors the resolved `maxSpendUsd` /
  `maxSessionSpendUsd` caps the same way `deposit` does (previously unbounded), and now errors
  instead of silently discarding a payer key passed as a stray positional argument — the ambient
  `AGENTKV_PAYER_KEY` / `AGENTKV_PRIVATE_KEY` wallet would otherwise have paid instead, with no
  indication a different wallet was used.
- **`@agentkv/cli`**: a corrupt or non-JSON `config.json` now fails loud (`invalid_config`)
  instead of silently reverting to defaults — which would retarget the endpoint to production
  and drop a persisted spend cap. `agentkv config` now writes atomically (temp file + rename)
  and removes the temp file on a failed write, so a crash mid-write can no longer produce the
  truncated file that the read path now refuses.
- **`@agentkv/client`**: sign-to-derive (the `{ signer }` shape with no explicit
  `encryptionKey`) now rejects a signature whose recovery id (`v`) is not the standard `27`/`28`
  (`invalid_config`) instead of hashing it into different key material. **Migration note:** some
  KMS and raw-secp256k1 signer wrappers return `v ∈ {0,1}`; such signers must now construct with
  an explicit `encryptionKey`. Data already written under the previous silent derivation from a
  `v ∈ {0,1}` signature is not readable through the public API — this makes loud (a thrown
  `invalid_config`) what was previously silent data loss (`get`/`listKeys` quietly returning
  `null`/empty with no error).
- **`@agentkv/client`**: a supplied `encryptionKey` is now copied into the client's retained key
  material instead of aliased — previously, a caller that zeroized its own key buffer after
  construction (good hygiene) would silently cause every subsequent key derivation to use zeros.
- **`@agentkv/cli`**: the `awal`-backed `topoffPayer` now rejects an `{success:false}`
  settlement payload even when it carries no `error` field, instead of treating a missing
  `error` as confirmation that the top-off settled. awal collapses every failure mode (payment
  failure, insufficient balance, network error, non-2xx) into `{success:false, error}` — a
  payload with the flag and no message is still a failure, not a settled deposit.
- **`@agentkv/cli`**: the MCP server's `agentkv_get` tool is now annotated `readOnlyHint:false,
  destructiveHint:false, idempotentHint:false` instead of read-only — a `get` is a paid
  operation (credits, or real USDC settled per call under `AGENTKV_INLINE=awal`), and since the
  optional `idempotency_key` defaults to a fresh nonce per call, two calls with identical tool
  arguments are billed separately. `agentkv mcp` also now warns on stderr at startup when no
  session spend cap (`AGENTKV_MAX_SESSION_SPEND_USD`) is configured, since a long-lived,
  unbudgeted server can otherwise spend without any cumulative bound.

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

[Unreleased]: https://github.com/agentx402-ai/agentkv/compare/v0.2.2...HEAD

## [0.2.2] — 2026-07-28

### Changed

- Dependency floors raised to match what installs already resolve: `@agentx402-ai/core`
  `^0.1.1` (metadata-only release: corrected npm repository link) and `viem` `^2.55.10`.
  No runtime behavior change in this package.

[0.2.2]: https://github.com/agentx402-ai/agentkv/releases/tag/v0.2.2

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
