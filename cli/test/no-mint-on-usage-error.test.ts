import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { walletPath } from "../src/keystore";
import { EXIT } from "../src/output";

const sink = () => {};

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "agentkv-no-mint-"));
}

// Regression: a valid COMMAND with a missing or invalid required argument used to mint and
// persist a wallet to disk (clientFromConfig, built during client construction in cli.ts) BEFORE
// the usage error was ever reported. The observation that matters is whether wallet.json landed
// on disk, not merely the error text — a reintroduced bug here could still print the right error
// while silently minting again.
//
// Deliberately does NOT inject a `client` into runCli's deps, unlike this repo's other command
// tests: an injected client makes `deps.client ?? clientFromConfig(...)` skip clientFromConfig
// entirely regardless of whether the bug is present, so it would never actually exercise the
// mint path either way (see commands-kv.test.ts's "set with no key" for exactly that shape).
describe("a usage error never mints a wallet", () => {
  const usageErrorShapes: Array<{ name: string; argv: string[] }> = [
    { name: "get with no key", argv: ["get"] },
    { name: "set with no key", argv: ["set"] },
    { name: "delete with no key", argv: ["delete"] },
    {
      name: "delete with a disallowed --out flag",
      argv: ["delete", "k", "--out", "backup.json"],
    },
    {
      name: "delete with a disallowed --from-env flag",
      argv: ["delete", "k", "--from-env", "SOME_VAR"],
    },
    {
      name: "delete with a disallowed --file flag",
      argv: ["delete", "k", "--file", "x.json"],
    },
    {
      name: "set with an invalid JSON positional value",
      argv: ["set", "k", "{bad"],
    },
    {
      name: "set --file pointing at a missing file",
      argv: ["set", "k", "--file", "/no/such/file.json"],
    },
    {
      name: "set --from-env with an unset var",
      argv: ["set", "k", "--from-env", "AGENTKV_NO_MINT_TEST_UNSET"],
    },
    {
      name: "set --from-env refusing the wallet key",
      argv: ["set", "k", "--from-env", "AGENTKV_PRIVATE_KEY"],
    },
    { name: "deposit with no amount", argv: ["deposit"] },
    { name: "deposit with a below-minimum amount", argv: ["deposit", "0.5"] },
    { name: "deposit with a non-numeric amount", argv: ["deposit", "abc"] },
  ];

  it.each(usageErrorShapes)("$name -> usage error, no wallet.json written", async ({ argv }) => {
    const home = tmpHome();
    try {
      const err: string[] = [];
      const code = await runCli(argv, {
        env: { AGENTKV_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.USAGE);
      expect(typeof JSON.parse(err.join("")).code).toBe("string"); // a machine-readable code is always present
      expect(existsSync(walletPath({ AGENTKV_HOME: home }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Already correct before this fix (an unknown command is rejected before any client-building
  // work runs at all) — pinned here too so a future change can't regress it silently.
  it("unknown command -> usage error, no wallet.json written (already correct)", async () => {
    const home = tmpHome();
    try {
      const err: string[] = [];
      const code = await runCli(["--definitely-not-a-real-flag"], {
        env: { AGENTKV_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.USAGE);
      expect(existsSync(walletPath({ AGENTKV_HOME: home }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // Also already correct: a malformed --limit is caught by cli.ts's OWN unrestricted
  // parseFlags(rest) call (used to extract global config flags), which runs before client
  // construction regardless of this fix — list-keys has no command-specific check to add.
  it("list-keys with a malformed --limit -> usage error, no wallet.json written (already correct)", async () => {
    const home = tmpHome();
    try {
      const err: string[] = [];
      const code = await runCli(["list-keys", "--limit", "abc"], {
        env: { AGENTKV_HOME: home },
        stdout: sink,
        stderr: (s) => err.push(s),
      });
      expect(code).toBe(EXIT.USAGE);
      expect(existsSync(walletPath({ AGENTKV_HOME: home }))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  // The mirror image of every case above: a genuinely VALID invocation must still mint on first
  // use — this fix only moves WHEN validation happens, it must never suppress the mint itself.
  // `balance` takes no arguments, so parsing always succeeds and clientFromConfig is reached;
  // point at a local port nothing listens on so the (unavoidable, post-mint) network call fails
  // fast rather than reaching the real API.
  it("a genuinely valid invocation still mints on first use (onboarding unchanged)", async () => {
    const home = tmpHome();
    try {
      await runCli(["balance"], {
        env: { AGENTKV_HOME: home, AGENTKV_ENDPOINT: "http://127.0.0.1:1" },
        stdout: sink,
        stderr: sink,
      });
      expect(existsSync(walletPath({ AGENTKV_HOME: home }))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
