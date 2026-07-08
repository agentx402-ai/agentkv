/**
 * Tests for `agentkv fund` (cli/src/commands/fund.ts) via runCli dispatch.
 *
 * `fund` is a LOCAL command (builds a card→USDC onramp URL, no client/network). It targets
 * the auto-provisioned/configured WALLET address; in account-key mode (no wallet) it emits
 * graceful guidance instead. The onramp provider is decoupled + selectable.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { getOrCreateStoredWallet } from "../src/keystore";
import { type OnrampProvider, PROVIDERS } from "../src/onramp";

function makeIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (s: string) => out.push(s),
    stderr: (s: string) => err.push(s),
    outJson: () => JSON.parse(out.join("")),
    errJson: () => JSON.parse(err.join("")),
    out,
    err,
  };
}

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), "agentkv-fund-"));
}

describe("fund — wallet mode", () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("with an auto-provisioned wallet + appId configured → prints {provider:'coinbase', url, address}", async () => {
    const { address } = getOrCreateStoredWallet({ AGENTKV_HOME: home });
    const io = makeIo();
    const code = await runCli(["fund"], {
      env: { AGENTKV_HOME: home, AGENTKV_ONRAMP_APP_ID: "proj-abc" },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const j = io.outJson();
    expect(j.provider).toBe("coinbase");
    expect(j.address).toBe(address);
    expect(j.url).toContain(address);
    expect(j.url).toContain("pay.coinbase.com");
    expect(j.url).toContain("USDC");
    expect(io.err).toHaveLength(0);
  });

  it("resolves the wallet address from AGENTKV_PRIVATE_KEY when set", async () => {
    const io = makeIo();
    const code = await runCli(["fund"], {
      // a known throwaway key (never used for funds) — its address is deterministic
      env: {
        AGENTKV_HOME: home,
        AGENTKV_PRIVATE_KEY: `0x${"a".repeat(64)}`,
        AGENTKV_ONRAMP_APP_ID: "proj-abc",
      },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const j = io.outJson();
    expect(j.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(j.url).toContain(j.address);
  });

  it("passes a positive amount through as presetFiatAmount + echoes amountUsd", async () => {
    getOrCreateStoredWallet({ AGENTKV_HOME: home });
    const io = makeIo();
    const code = await runCli(["fund", "25"], {
      env: { AGENTKV_HOME: home, AGENTKV_ONRAMP_APP_ID: "proj-abc" },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const j = io.outJson();
    expect(j.amountUsd).toBe(25);
    expect(j.url).toContain("presetFiatAmount=25");
  });

  it("a positive sub-cent amount → clear error (no presetFiatAmount=0 URL)", async () => {
    getOrCreateStoredWallet({ AGENTKV_HOME: home });
    const io = makeIo();
    const code = await runCli(["fund", "0.004"], {
      env: { AGENTKV_HOME: home, AGENTKV_ONRAMP_APP_ID: "proj-abc" },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).not.toBe(0);
    const e = io.errJson();
    expect(e.code).toBe("onramp_config");
    expect(e.error).toMatch(/0\.01 minimum/);
    expect(io.out).toHaveLength(0); // no URL emitted
    expect(io.err.join("")).not.toContain("presetFiatAmount=0"); // never a $0 pre-fill
  });

  it("an exactly-$0.01 amount → a URL with presetFiatAmount=0.01", async () => {
    getOrCreateStoredWallet({ AGENTKV_HOME: home });
    const io = makeIo();
    const code = await runCli(["fund", "0.01"], {
      env: { AGENTKV_HOME: home, AGENTKV_ONRAMP_APP_ID: "proj-abc" },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const j = io.outJson();
    expect(j.amountUsd).toBe(0.01);
    expect(j.url).toContain("presetFiatAmount=0.01");
  });

  it("a malformed amount → EXIT.USAGE, not a broken URL", async () => {
    getOrCreateStoredWallet({ AGENTKV_HOME: home });
    const io = makeIo();
    const code = await runCli(["fund", "abc"], {
      env: { AGENTKV_HOME: home, AGENTKV_ONRAMP_APP_ID: "proj-abc" },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2); // EXIT.USAGE
    expect(io.errJson().code).toBe("usage");
    expect(io.out).toHaveLength(0);
  });

  it("missing appId → a clear error (non-zero exit), never a broken URL", async () => {
    getOrCreateStoredWallet({ AGENTKV_HOME: home });
    const io = makeIo();
    const code = await runCli(["fund"], {
      env: { AGENTKV_HOME: home }, // no AGENTKV_ONRAMP_APP_ID
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).not.toBe(0);
    const e = io.errJson();
    expect(e.code).toBe("onramp_config");
    expect(e.error).toMatch(/AGENTKV_ONRAMP_APP_ID/);
    expect(io.out).toHaveLength(0); // no URL emitted
  });

  it("a TESTNET network → a clean testnet error (non-zero exit), NEVER a mainnet URL (real-money bug)", async () => {
    getOrCreateStoredWallet({ AGENTKV_HOME: home });
    const io = makeIo();
    const code = await runCli(["fund"], {
      // A testnet-configured deployment must not emit a real mainnet Coinbase buy link.
      env: {
        AGENTKV_HOME: home,
        AGENTKV_ONRAMP_APP_ID: "proj-abc",
        AGENTKV_NETWORK: "eip155:84532",
      },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).not.toBe(0); // non-zero exit, not a URL
    const e = io.errJson();
    expect(e.code).toBe("onramp_config");
    expect(e.error).toMatch(/testnet|Base mainnet only/i);
    expect(io.out).toHaveLength(0); // no URL on stdout
    // Belt-and-suspenders: nothing that looks like a Coinbase mainnet URL leaked.
    expect(io.err.join("")).not.toContain("pay.coinbase.com");
  });
});

describe("fund — provider selection (decoupled/selectable)", () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("AGENTKV_ONRAMP_PROVIDER selects a different registered provider", async () => {
    // Register a trivial second provider to prove selection routes through the registry —
    // the `fund` command itself is unchanged. Clean it up afterwards.
    const fake: OnrampProvider = {
      id: "fake",
      name: "Fake Onramp",
      buildUrl: ({ address }) => `https://fake.example/?to=${address}`,
    };
    PROVIDERS.fake = fake;
    try {
      const { address } = getOrCreateStoredWallet({ AGENTKV_HOME: home });
      const io = makeIo();
      const code = await runCli(["fund"], {
        env: { AGENTKV_HOME: home, AGENTKV_ONRAMP_PROVIDER: "fake" },
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      const j = io.outJson();
      expect(j.provider).toBe("fake");
      expect(j.url).toBe(`https://fake.example/?to=${address}`);
    } finally {
      delete PROVIDERS.fake;
    }
  });

  it("the --onramp-provider flag also selects the provider", async () => {
    const fake: OnrampProvider = {
      id: "fake2",
      name: "Fake2",
      buildUrl: () => "https://fake2.example/",
    };
    PROVIDERS.fake2 = fake;
    try {
      getOrCreateStoredWallet({ AGENTKV_HOME: home });
      const io = makeIo();
      const code = await runCli(["fund", "--onramp-provider", "fake2"], {
        env: { AGENTKV_HOME: home },
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      expect(io.outJson().provider).toBe("fake2");
    } finally {
      delete PROVIDERS.fake2;
    }
  });

  it("an unknown provider id → EXIT.USAGE, error lists the known providers", async () => {
    getOrCreateStoredWallet({ AGENTKV_HOME: home });
    const io = makeIo();
    const code = await runCli(["fund"], {
      env: { AGENTKV_HOME: home, AGENTKV_ONRAMP_PROVIDER: "does-not-exist" },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(2); // EXIT.USAGE
    const e = io.errJson();
    expect(e.code).toBe("unknown_provider");
    expect(e.error).toMatch(/coinbase/);
  });
});

describe("fund — no wallet / account mode (graceful guidance)", () => {
  let home: string;
  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("no wallet at all → OK with url:null + guidance to create a wallet (never crashes)", async () => {
    const io = makeIo();
    const code = await runCli(["fund"], {
      env: { AGENTKV_HOME: home, AGENTKV_ONRAMP_APP_ID: "proj-abc" },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const j = io.outJson();
    expect(j.url).toBeNull();
    expect(j.address).toBeNull();
    expect(j.note).toMatch(/wallet/i);
  });

  it("account-key mode (account.json, no wallet) → graceful deposit guidance, url:null", async () => {
    // Write a valid-looking account file (ak_<64 hex> + 0x<64 hex> enc key).
    writeFileSync(
      join(home, "account.json"),
      JSON.stringify({
        accountKey: `ak_${"0".repeat(64)}`,
        encryptionKey: `0x${"0".repeat(64)}`,
      }),
    );
    const io = makeIo();
    const code = await runCli(["fund"], {
      env: { AGENTKV_HOME: home, AGENTKV_ONRAMP_APP_ID: "proj-abc" },
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(0);
    const j = io.outJson();
    expect(j.url).toBeNull();
    expect(j.address).toBeNull();
    expect(j.note).toMatch(/account\/deposit/);
    expect(j.note).toMatch(/sign/i);
  });
});
