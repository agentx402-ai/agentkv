# Changelog

All notable changes to AgentKV are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

Initial public release.

### Added

- `@agentx402/core` — shared x402/EIP-712 auth, payment, usage, error, and retry plumbing.
- `@agentkv/client` — the SDK: client-side AES-256-GCM encryption + x402/EIP-712 payments;
  wallet, signer, and account-key auth modes.
- `@agentkv/cli` — the `agentkv` CLI and `agentkv mcp` MCP server, with secret-safe tools.
- Claude Code plugin wrapping the MCP server.
- Per-attempt request timeouts (`timeoutMs`) and an injectable `fetch` on the SDK.
- Optional idempotency keys and recipient (`expectedPayTo`) pinning on `deposit()` / `fundAccount()`.
- `agentkv --help` and `--version`; unknown CLI flags are now rejected (fail-closed).

### Changed (breaking — pre-1.0)

- `SetOptions`: `ttl_days`/`strict_ttl` renamed to camelCase `ttlDays`/`strictTtl` (wire unchanged).
- Account-key mode: `client.address` is now `undefined` (was the zero-address sentinel).
- Removed the `apiVersion` option; all requests target `/v1/*`.
- Sign-to-derive now signs domain-bound EIP-712 typed data (was a bare `personal_sign` string);
  `Signer` requires only `address` + `signTypedData`.
- Removed the pre-release legacy crypto scheme (no-magic trial-decrypt, `deriveKey`, `legacyValue`).

### Security

- Values now bind the key's blind-index digest into the AES-GCM AAD, so a compromised server
  cannot serve one key's ciphertext for a different key's request (fails the auth tag).
- Sign-to-derive is domain-scoped (EIP-712), so a generic-text phishing prompt can't reproduce
  the encryption key.
- The `opInlinePayer` path is bounded by the configured `maxSpendUsd` and pre-reserved against
  the session cap before paying.
- `AGENTKV_PAYER_KEY` (and any `AGENTKV_*` key-material env var) is scrubbed from the MCP server
  env and refused as a secret source.

### Fixed

- Concurrent account-mode ops hitting an insufficient-credits 402 now await the single in-flight
  top-off and retry, instead of surfacing the 402 (single-flight still deposits exactly once).
- Retry backoff gains full jitter + HTTP-date `Retry-After`; a real 402 maps to the CLI payment
  exit code.

### Internal

- Unified `set()` and `getInternal()`'s duplicated money/transport state machine into a single
  `performOp()` (no behavior change; removes the "fix one copy, not the other" hazard).

[Unreleased]: https://github.com/agentx402-ai/agentkv/commits/main
