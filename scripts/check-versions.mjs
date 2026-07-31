// scripts/check-versions.mjs — the version-lockstep gate (RELEASING.md).
// Usage:
//   node scripts/check-versions.mjs           # all sources agree with each other (CI `versions` job)
//   node scripts/check-versions.mjs v0.2.3    # ...and with the given release tag — manual/local use
//   node scripts/check-versions.mjs ""        # REJECTED (exit 1): an empty tag is a caller bug,
//                                             # never a request for the sources-only mode
//
// ci.yml's `versions` job is this script's only automated caller on this branch, and it always
// runs with no tag argument. publish.yml does NOT call this script — it carries its own separate
// inline tag-vs-source guard (see AGENTS.md / RELEASING.md). The tag-argument mode above still
// works and is useful to run by hand before cutting a release; it just isn't wired into any
// workflow here.
import { readFileSync } from "node:fs";

// Sources resolve relative to the repo root (this file's parent), not the process cwd, so the
// answer is the same run by hand from client/ or cli/ as from CI's checkout root. The tag mode
// above is documented as the local pre-release check, and reading cwd-relative made that crash
// with a bare ENOENT anywhere but the root.
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const ver = (p) => JSON.parse(read(p)).version;
const konst = (p) => (read(p).match(/VERSION = "([^"]+)"/) || [])[1];

const v = {
  clientPkg: ver("client/package.json"),
  cliPkg: ver("cli/package.json"),
  clientConst: konst("client/src/index.ts"),
  cliConst: konst("cli/src/version.ts"),
  plugin: ver("plugin/agentkv/.claude-plugin/plugin.json"),
  // The plugin runtime pin: without it the five-source lockstep never bound what runs.
  mcpPin: (read("plugin/agentkv/.mcp.json").match(/"@agentkv\/cli@([^"]+)"/) || [])[1],
};
const uniq = [...new Set(Object.values(v))];
if (uniq.length !== 1 || uniq[0] === undefined) {
  console.error("::error::version sources diverge:", JSON.stringify(v));
  process.exit(1);
}
const dep = JSON.parse(read("cli/package.json")).dependencies["@agentkv/client"];
if (dep !== `^${v.clientPkg}`) {
  console.error(`::error::cli dependency on @agentkv/client (${dep}) != ^${v.clientPkg}`);
  process.exit(1);
}
// ABSENT argument = "no tag to check": run as a source-agreement-only check. ci.yml's
// `versions` job is what relies on that — it always calls with no argument (`argv[2]` is
// undefined), so it only ever exercises this branch.
//
// An EXPLICITLY EMPTY argument is different, and must NOT be lumped in with it. It means the
// caller TRIED to resolve a release tag and came up empty. Treating that as "no tag" silently
// downgrades a release-time tag check into the weaker sources-only check — and that check
// passes when every source agrees with every other source at the WRONG version, which is
// exactly the drift a tag check exists to catch. A release guard must fail CLOSED, so an
// empty or whitespace-only argument is an error, not a mode.
//   (Deliberately not byte-identical to the sibling agentscout script on this point: there,
//   publish.yml calls the equivalent guard behind a `^v[0-9]+\.[0-9]+\.[0-9]+…` tag validation.
//   Here publish.yml carries its own inline guard and does not call this script at all, so no
//   automated caller passes a tag today — this closes the hole against a FUTURE one.)
const tag = process.argv[2];
if (tag !== undefined && tag.trim() === "") {
  console.error("::error::empty tag argument — the caller failed to resolve a release tag");
  process.exit(1);
}
if (tag && tag.replace(/^v/, "") !== uniq[0]) {
  console.error(
    `::error::release tag ${tag} does not match the version sources (${uniq[0]}) — ` +
      "bump every source before cutting the release (RELEASING.md)",
  );
  process.exit(1);
}
console.log(`ok: all version sources${tag ? " + release tag" : ""} at ${uniq[0]}`);
