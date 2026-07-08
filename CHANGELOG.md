# Changelog

All notable changes to AgentKV are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project adheres to
[Semantic Versioning](https://semver.org/).

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
