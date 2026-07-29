// scripts/check-versions.mjs — the version-lockstep gate (RELEASING.md).
// Usage:
//   node scripts/check-versions.mjs           # all sources agree with each other (CI `versions` job)
//   node scripts/check-versions.mjs v0.2.3    # ...and with the given release tag — manual/local use
//
// ci.yml's `versions` job is this script's only automated caller on this branch, and it always
// runs with no tag argument. publish.yml does NOT call this script — it carries its own separate
// inline tag-vs-source guard (see AGENTS.md / RELEASING.md). The tag-argument mode above still
// works and is useful to run by hand before cutting a release; it just isn't wired into any
// workflow here.
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(p, "utf8");
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
// Falsy (absent OR empty) means "no tag to check" — this also runs as a source-agreement-only
// check with nothing to compare against a tag. ci.yml's `versions` job is what actually relies
// on this: it always calls the script with no argument (`argv[2]` is undefined), so it only
// ever exercises this branch. The empty-string case is accepted the same way for a caller that
// resolves a tag dynamically and might come up empty; nothing on this branch currently does that.
const tag = process.argv[2];
if (tag && tag.replace(/^v/, "") !== uniq[0]) {
  console.error(
    `::error::release tag ${tag} does not match the version sources (${uniq[0]}) — ` +
      "bump every source before cutting the release (RELEASING.md)",
  );
  process.exit(1);
}
console.log(`ok: all version sources${tag ? " + release tag" : ""} at ${uniq[0]}`);
