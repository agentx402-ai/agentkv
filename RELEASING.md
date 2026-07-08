# Releasing

AgentKV ships three coordinated npm packages plus a Claude Code plugin. They MUST be
published together, in dependency order, at the same version.

## Version sources (keep in sync)

- `core/package.json`, `client/package.json`, `cli/package.json` — the published versions
- `client/src/index.ts` (`VERSION`) — reported by the SDK
- `cli/src/version.ts` (`VERSION`) — `agentkv --version` and the MCP server handshake
- `plugin/agentkv/.claude-plugin/plugin.json` (`version`)
- `agentx402-ai/claude-plugins` → `.claude-plugin/marketplace.json` (the `agentkv` plugin's
  `source.ref`) — the cross-repo pin the shared marketplace serves; synced on release (step 7).

CI fails if the three publishable `package.json` versions diverge (the `versions` job).

## Publish order (required)

Each higher package depends on a lower one at `^0.x`, so publish bottom-up:

1. `npm publish -w core` — `@agentx402-ai/core`
2. `npm publish -w client` — `@agentkv/client` (depends on `@agentx402-ai/core`)
3. `npm publish -w cli` — `@agentkv/cli` (depends on `@agentkv/client`)

Do NOT publish a higher package before the one it depends on, or `npm install` will
`E404` for consumers until the dependency lands.

## Steps

1. Bump every version source above to the new version.
2. Update `CHANGELOG.md` — add a dated `## [<version>]` section for the release.
3. `npm ci && npm run lint && npm run build && npm test` — all green.
4. `npm pack --dry-run --workspaces` — confirm each tarball's contents.
5. Publish in the order above.
6. Cut the GitHub Release: `gh release create v<version> --generate-notes`. This tags AND
   publishes a Release — a plain `git push --tags` will NOT fire the marketplace auto-sync.
7. The marketplace pin then syncs automatically: publishing the Release dispatches to
   `agentx402-ai/claude-plugins`, which pins the `agentkv` plugin's `source.ref` to `v<version>`
   (`.github/workflows/notify-marketplace.yml` here → `sync-release.yml` there). Manual
   fallback: `gh workflow run sync-release.yml -R agentx402-ai/claude-plugins -f plugin=agentkv -f ref=v<version>`.
