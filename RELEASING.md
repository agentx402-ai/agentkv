# Releasing

AgentKV ships three coordinated npm packages plus a Claude Code plugin. They MUST be
published together, in dependency order, at the same version.

## Version sources (keep in sync)

- `core/package.json`, `client/package.json`, `cli/package.json` — the published versions
- `client/src/index.ts` (`VERSION`) — reported by the SDK
- `cli/src/version.ts` (`VERSION`) — `agentkv --version` and the MCP server handshake
- `plugin/agentkv/.claude-plugin/plugin.json` (`version`)

CI fails if the three publishable `package.json` versions diverge (the `versions` job).

## Publish order (required)

Each higher package depends on a lower one at `^0.x`, so publish bottom-up:

1. `npm publish -w core` — `@agentx402/core`
2. `npm publish -w client` — `@agentkv/client` (depends on `@agentx402/core`)
3. `npm publish -w cli` — `@agentkv/cli` (depends on `@agentkv/client`)

Do NOT publish a higher package before the one it depends on, or `npm install` will
`E404` for consumers until the dependency lands.

## Steps

1. Bump every version source above to the new version.
2. Update `CHANGELOG.md` (move `Unreleased` to the new version + date).
3. `npm ci && npm run lint && npm run build && npm test` — all green.
4. `npm pack --dry-run --workspaces` — confirm each tarball's contents.
5. Publish in the order above.
6. Tag the release: `git tag v<version> && git push --tags`.
