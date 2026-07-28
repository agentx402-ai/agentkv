// scripts/check-versions.mjs — the version-lockstep gate (RELEASING.md).
// Usage:
//   node scripts/check-versions.mjs           # all sources agree with each other (CI `versions` job)
//   node scripts/check-versions.mjs v0.2.3    # ...and with the given release tag (publish.yml)
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
// Falsy (absent OR empty) means "no tag to check": publish.yml passes '' on
// workflow_dispatch re-runs, which must not fail the source-agreement-only check.
const tag = process.argv[2];
if (tag && tag.replace(/^v/, "") !== uniq[0]) {
  console.error(
    `::error::release tag ${tag} does not match the version sources (${uniq[0]}) — ` +
      "bump every source before cutting the release (RELEASING.md)",
  );
  process.exit(1);
}
console.log(`ok: all version sources${tag ? " + release tag" : ""} at ${uniq[0]}`);
