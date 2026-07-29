# Releasing

AgentKV ships two coordinated npm packages (`@agentkv/client`, `@agentkv/cli`) plus a Claude
Code plugin. They MUST be published together, in dependency order, at the same version. The
shared `@agentx402-ai/core` is released separately from [its own repo](https://github.com/agentx402-ai/core).

## Version sources (keep in sync)

- `client/package.json`, `cli/package.json` — the published versions
- `client/src/index.ts` (`VERSION`) — reported by the SDK
- `cli/src/version.ts` (`VERSION`) — `agentkv --version` and the MCP server handshake
- `plugin/agentkv/.claude-plugin/plugin.json` (`version`)
- `plugin/agentkv/.mcp.json` — the MCP runtime pin (`@agentkv/cli@<version>` in args)
- `client/test/scaffold.test.ts` — pins the exported `VERSION` literal (the suite fails
  on a bump until it moves too; discovered the release after this list was written)
- `agentx402-ai/claude-plugins` → `.claude-plugin/marketplace.json` (the `agentkv` plugin's
  `source.ref`) — the cross-repo pin the shared marketplace serves; synced on release (step 7).

CI's `versions` job (`scripts/check-versions.mjs`) cross-checks all six sources — including
the `.mcp.json` runtime pin — plus the cli→client dependency range, on every pull request.
`publish.yml` does not call that script: it carries its own inline guard that re-checks the
release tag against five of the six sources (both `package.json`s, both `VERSION` consts,
`plugin.json`) plus the cli→client dependency range, then a narrower re-check of just the two
`package.json`s immediately before publishing. The `.mcp.json` runtime pin is therefore
checked by CI, not by the release-time guard.

## Publish order (required)

Each higher package depends on a lower one at `^0.x`, so publish bottom-up:

1. `npm publish -w client` — `@agentkv/client` (depends on the already-published `@agentx402-ai/core`)
2. `npm publish -w cli` — `@agentkv/cli` (depends on `@agentkv/client`)

Do NOT publish a higher package before the one it depends on, or `npm install` will
`E404` for consumers until the dependency lands. If you also changed `@agentx402-ai/core`,
release it first from its own repo and bump the `^` range in `client`/`cli`.

## Steps

1. Bump every version source above to the new version (including the `@agentkv/cli@<version>` pin in `.mcp.json`).
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
