# @agentx402-ai/core

Shared x402/EIP-712 platform SDK plumbing — auth, payment, usage, error, and retry handling —
extracted from `@agentkv/client` for reuse across future `agentx402` service SDKs.

## Error handling

`@agentkv/client` re-exports this package's `AgentXError` as `AgentKVError`, so both names refer
to the same class object and `instanceof AgentKVError` holds across the workspace. This relies on
a single resolved copy of `@agentx402-ai/core` — if a downstream project ever resolves two
incompatible majors of it (e.g. one dependency pinning `^0.1.0` and another `^1.0.0`), each copy's
`AgentXError` is a distinct class, and `instanceof` checks silently fail across them.

## License

MIT
