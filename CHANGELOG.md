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
- Per-attempt request timeouts and an injectable `fetch` on the SDK.
- Optional idempotency keys and recipient (`expectedPayTo`) pinning on `deposit()` / `fundAccount()`.
- `agentkv --help` and `--version`; unknown CLI flags are now rejected (fail-closed).

### Security

- The `opInlinePayer` path is bounded by the configured `maxSpendUsd` and pre-reserved against
  the session cap before paying.
- `AGENTKV_PAYER_KEY` (and any `AGENTKV_*` key-material env var) is scrubbed from the MCP server
  env and refused as a secret source.

[Unreleased]: https://github.com/agentx402-ai/agentkv/commits/main
