import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/index.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("@agentkv/client scaffold", () => {
  // Asserts LOCKSTEP with the manifest, not a hardcoded literal. VERSION is compiled into the
  // published bundle and reported to the service, so a drift ships a client that misreports
  // itself — that is the invariant worth pinning, and it is the one scripts/check-versions.mjs
  // enforces across all six sources. A pinned literal here tested nothing except whether
  // someone had remembered to edit this line, and broke on every release.
  it("exports a VERSION matching package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
