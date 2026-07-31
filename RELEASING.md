# Releasing

AgentKV ships two coordinated npm packages (`@agentkv/client`, `@agentkv/cli`) plus a Claude
Code plugin. They MUST be published together, in dependency order, at the same version. The
shared `@agentx402-ai/core` is released separately from [its own repo](https://github.com/agentx402-ai/core).

## Version sources (keep in sync)

Seven sources move in lockstep on every release — six in this repo, plus one cross-repo pin:

1. `client/package.json` — the published `@agentkv/client` version
2. `cli/package.json` — the published `@agentkv/cli` version
3. `client/src/index.ts` (`VERSION`) — reported by the SDK
4. `cli/src/version.ts` (`VERSION`) — `agentkv --version` and the MCP server handshake
5. `plugin/agentkv/.claude-plugin/plugin.json` (`version`)
6. `plugin/agentkv/.mcp.json` — the MCP runtime pin (`@agentkv/cli@<version>` in `args`).
   Without it the plugin spawns whatever is latest at install time, so the lockstep binds the
   declared version but not the one that actually runs.
7. `agentx402-ai/claude-plugins` → `.claude-plugin/marketplace.json` (the `agentkv` plugin's
   `source.ref`) — the cross-repo pin the shared marketplace serves; synced on release (step 7).

`client/test/scaffold.test.ts` is **not** a version source and needs no edit on a bump: it
asserts `VERSION === package.json.version`, i.e. the lockstep itself. (An earlier revision of
this list called it a pinned literal that must be moved by hand. It was a pinned literal once;
that broke on every release, which is why it now reads the manifest.)

Both gates check all **six in-repo** sources AND the cli→client dependency range
(`cli/package.json`'s `@agentkv/client` must be `^<clientVersion>`):

- CI's `versions` job runs `scripts/check-versions.mjs` on every pull request.
- `publish.yml` re-checks the same six against the release **tag**, then re-checks just the two
  `package.json`s immediately before the `npm publish` steps.

The two are deliberately independent implementations — `publish.yml` does not call the script —
so a bug or an edit in one cannot disable both. Keep them in sync by hand. The seventh
(marketplace) pin lives in another repo and is synced automatically on release.

## Publish order (required)

Each higher package depends on a lower one at `^0.x`, so they publish bottom-up — **client, then
cli**. This order is enforced by `publish.yml` (OIDC trusted publishing): cutting the GitHub
Release runs the workflow, which publishes `@agentkv/client` before `@agentkv/cli`. Do NOT run
`npm publish` from a laptop — it bypasses provenance and, once the workflow has already
published, fails `EEXIST`. (Publishing a higher package before the one it depends on would
`E404` for consumers until the dependency lands; the enforced order prevents that.) If you also
changed `@agentx402-ai/core`, release it first from its own repo and bump the `^` range in
`client`/`cli`.

## Steps

1. Bump every in-repo version source above (all six, including the `@agentkv/cli@<version>` pin
   in `.mcp.json`, and the cli→client dep range) to the new version.
2. Update `CHANGELOG.md` — add a dated `## [<version>]` section for the release.
3. `npm ci && npm run lint && npm run build && npm test` — all green.
4. `npm pack --dry-run --workspaces` — confirm each tarball's contents.
5. Publishing is automated — do NOT run `npm publish` by hand. Cutting the Release (next step)
   runs `publish.yml`, which publishes client then cli via OIDC in the enforced order above.
6. Cut the GitHub Release: `gh release create v<version> --generate-notes`. This tags AND
   publishes a Release — a plain `git push --tags` will NOT fire the publish or the marketplace
   auto-sync. Publishing the Release runs `publish.yml` (OIDC trusted publishing, client then cli).
7. The marketplace pin then syncs automatically: publishing the Release dispatches to
   `agentx402-ai/claude-plugins`, which pins the `agentkv` plugin's `source.ref` to `v<version>`
   (`.github/workflows/notify-marketplace.yml` here → `sync-release.yml` there). Manual
   fallback: `gh workflow run sync-release.yml -R agentx402-ai/claude-plugins -f plugin=agentkv -f ref=v<version>`.

### Prereleases

A tag with a semver prerelease suffix (`v0.4.0-rc.1`) publishes to the **`next`** npm dist-tag,
never `latest`, so `npm install @agentkv/cli` keeps resolving to the last stable release. Cut it
with `gh release create v0.4.0-rc.1 --prerelease --generate-notes`. The marketplace pin is
deliberately NOT moved by a prerelease — `marketplace.json` serves one `source.ref` per plugin,
so pinning an rc would point every plugin install at a prerelease CLI. `notify-marketplace.yml`
enforces that for Release events (it checks both the prerelease flag and a `-` in the tag); a
manual `workflow_dispatch` naming the ref is deliberately unfiltered, so pinning a prerelease
by hand stays possible if you actually want it.

### If the publish fails

`publish.yml` runs from the tag it publishes, so a fix pushed to `main` does not apply to an
already-cut Release. Recovery depends on what failed:

- **Transient (registry blip, rate limit):** "Re-run all jobs" on the run, or
  `gh workflow run publish.yml --ref v<version>`. It must run FROM THE TAG — a branch dispatch
  is refused, because npm builds provenance from `GITHUB_REF` and a dispatch from `main` would
  attest the tag's code under main's HEAD.
- **Half-published** (client landed, cli did not): re-run. The publish steps skip an
  already-published exact version on a re-run attempt, so the run completes the missing half. A
  first attempt still fails loudly on an already-taken version.
- **A bug in the workflow itself:** it cannot be fixed by re-running, since the run executes the
  workflow file at its own ref. Move the tag onto a commit carrying both the fix and the matching
  versions, or bump every source and cut the next version.
