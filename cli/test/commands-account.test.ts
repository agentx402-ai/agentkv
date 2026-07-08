/**
 * Tests for `agentkv account` (cli/src/commands/account.ts), driven through runCli
 * so dispatch + the lazy account-mode client wiring are covered too.
 *
 * Uses the AGENTKV_HOME-temp-dir keystore pattern so account.json lands in an isolated
 * dir, and the injected-client pattern so `account show` balance never hits the network.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it, vi } from "vitest";
import { runCli } from "../src/cli";
import { peekStoredAccount } from "../src/keystore";

function tmpEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { AGENTKV_HOME: mkdtempSync(join(tmpdir(), "agentkv-acct-")), ...extra };
}
const clean = (env: NodeJS.ProcessEnv) =>
  rmSync(env.AGENTKV_HOME as string, { recursive: true, force: true });

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

describe("account new", () => {
  it("prints an ak_ key + enc key + path + funding note, and creates the file", async () => {
    const env = tmpEnv();
    try {
      const io = makeIo();
      const code = await runCli(["account", "new"], { env, stdout: io.stdout, stderr: io.stderr });
      expect(code).toBe(0);
      const j = io.outJson();
      expect(j.accountKey).toMatch(/^ak_[0-9a-f]{64}$/);
      expect(j.encryptionKey).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(typeof j.path).toBe("string");
      expect(j.note).toMatch(/unrecoverable/i);
      expect(j.note).toMatch(/account\/deposit/); // funding instructions
      // the file now exists and round-trips
      expect(peekStoredAccount(env)?.accountKey).toBe(j.accountKey);
    } finally {
      clean(env);
    }
  });

  it("honors --endpoint in the funding note (not the production default)", async () => {
    const env = tmpEnv();
    try {
      const io = makeIo();
      const code = await runCli(["account", "new", "--endpoint", "https://staging.example"], {
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      const j = io.outJson();
      // The note points at the configured endpoint's /account/deposit, not the default host.
      expect(j.note).toContain("https://staging.example/account/deposit");
      expect(j.note).not.toContain("api.agentx402.ai");
    } finally {
      clean(env);
    }
  });

  it("refuses to clobber an existing account file (account_exists, EXIT.GENERIC)", async () => {
    const env = tmpEnv();
    try {
      await runCli(["account", "new"], { env, stdout: () => {}, stderr: () => {} });
      const before = peekStoredAccount(env)?.accountKey;

      const io = makeIo();
      const code = await runCli(["account", "new"], { env, stdout: io.stdout, stderr: io.stderr });
      expect(code).toBe(1); // EXIT.GENERIC
      expect(io.errJson().code).toBe("account_exists");
      expect(io.out).toHaveLength(0); // no second secret printed
      expect(peekStoredAccount(env)?.accountKey).toBe(before); // unchanged
    } finally {
      clean(env);
    }
  });
});

describe("account show", () => {
  it("with no account file → configured:false + a hint to run 'account new'", async () => {
    const env = tmpEnv();
    try {
      const io = makeIo();
      const code = await runCli(["account", "show"], { env, stdout: io.stdout, stderr: io.stderr });
      expect(code).toBe(0);
      const j = io.outJson();
      expect(j.configured).toBe(false);
      expect(j.note).toMatch(/account new/);
    } finally {
      clean(env);
    }
  });

  it("with AGENTKV_ACCOUNT_KEY set and no file → configured (source env), not 'no account'", async () => {
    const AK = `ak_${"a".repeat(64)}`;
    const env = tmpEnv({ AGENTKV_ACCOUNT_KEY: AK });
    try {
      // Sanity: no account.json exists — the env key alone must drive account mode.
      expect(peekStoredAccount(env)).toBeNull();
      const io = makeIo();
      const code = await runCli(["account", "show"], { env, stdout: io.stdout, stderr: io.stderr });
      expect(code).toBe(0);
      const j = io.outJson();
      expect(j.configured).toBe(true); // NOT the "no account" (configured:false) path
      expect(j.source).toMatch(/env/i); // reported as coming from the environment
      // The raw bearer key is NOT surfaced without --reveal.
      expect(io.out.join("")).not.toContain(AK);
    } finally {
      clean(env);
    }
  });

  it("--reveal with AGENTKV_ACCOUNT_KEY (env source) prints the env key", async () => {
    const AK = `ak_${"a".repeat(64)}`;
    const ENC = `0x${"b".repeat(64)}`;
    const env = tmpEnv({ AGENTKV_ACCOUNT_KEY: AK, AGENTKV_ENCRYPTION_KEY: ENC });
    try {
      const io = makeIo();
      const code = await runCli(["account", "show", "--reveal"], {
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      const j = io.outJson();
      expect(j.source).toMatch(/env/i);
      expect(j.accountKey).toBe(AK);
      expect(j.encryptionKey).toBe(ENC);
    } finally {
      clean(env);
    }
  });

  it("with a file → source/path + balance via the injected client, NOT the raw secrets", async () => {
    const env = tmpEnv();
    try {
      await runCli(["account", "new"], { env, stdout: () => {}, stderr: () => {} });
      const stored = peekStoredAccount(env)!;

      const balance = vi.fn(async () => 4242);
      const io = makeIo();
      const code = await runCli(["account", "show"], {
        client: { balance } as any,
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      const j = io.outJson();
      expect(j.source).toBe("local account file");
      expect(j.path).toBe(stored.path);
      expect(j.balance).toBe(4242);
      expect(balance).toHaveBeenCalledOnce();
      // secrets are NOT surfaced without --reveal
      expect(j.accountKey).toBeUndefined();
      expect(j.encryptionKey).toBeUndefined();
      const blob = io.out.join("");
      expect(blob).not.toContain(stored.accountKey);
      expect(blob).not.toContain(stored.encryptionKey);
    } finally {
      clean(env);
    }
  });

  it("show with a file but a failing balance() still succeeds (best-effort)", async () => {
    const env = tmpEnv();
    try {
      await runCli(["account", "new"], { env, stdout: () => {}, stderr: () => {} });
      const io = makeIo();
      const code = await runCli(["account", "show"], {
        client: {
          balance: vi.fn(async () => {
            throw new Error("offline");
          }),
        } as any,
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      const j = io.outJson();
      expect(j.source).toBe("local account file");
      expect(j.balance).toBeUndefined();
      expect(j.balanceError).toMatch(/offline/);
    } finally {
      clean(env);
    }
  });

  it("--reveal prints the raw account key + encryption key for backup", async () => {
    const env = tmpEnv();
    try {
      await runCli(["account", "new"], { env, stdout: () => {}, stderr: () => {} });
      const stored = peekStoredAccount(env)!;

      const io = makeIo();
      const code = await runCli(["account", "show", "--reveal"], {
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      const j = io.outJson();
      expect(j.accountKey).toBe(stored.accountKey);
      expect(j.encryptionKey).toBe(stored.encryptionKey);
      expect(j.source).toBe("local account file");
    } finally {
      clean(env);
    }
  });

  // FIX (a): account.json present AND AGENTKV_PRIVATE_KEY exported (no AGENTKV_ACCOUNT_KEY).
  // clientFromConfig would hand back a WALLET-mode client (privateKey wins), whose balance()
  // is the wallet's namespace — the WRONG account. `show` must report the ACCOUNT's balance
  // from an ACCOUNT-mode client built from the file.
  it("with a file AND AGENTKV_PRIVATE_KEY set → reports the ACCOUNT's balance (account bearer), NOT the wallet's", async () => {
    const env = tmpEnv({ AGENTKV_PRIVATE_KEY: `0x${"a".repeat(64)}` });
    try {
      await runCli(["account", "new"], { env, stdout: () => {}, stderr: () => {} });
      const stored = peekStoredAccount(env)!;

      // Stub fetch so balance() hits no network; capture each request's auth headers.
      const seen: { url: string; auth: string | null; sig: string | null }[] = [];
      vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        seen.push({
          url: typeof input === "string" ? input : input.url,
          auth: h.get("Authorization"),
          sig: h.get("X-AgentKV-Signature"),
        });
        return new Response(JSON.stringify({ balance: 777 }), { status: 200 });
      });

      const io = makeIo();
      // NO injected client: runAccount must build its OWN account-mode client from the file.
      const code = await runCli(["account", "show"], { env, stdout: io.stdout, stderr: io.stderr });
      expect(code).toBe(0);
      const j = io.outJson();
      expect(j.source).toBe("local account file");
      expect(j.balance).toBe(777); // the ACCOUNT's balance
      // The balance request used the ACCOUNT bearer (its namespace), never a wallet signature.
      expect(seen).toHaveLength(1);
      expect(seen[0].url).toContain("/credits/balance");
      expect(seen[0].auth).toBe(`Bearer ${stored.accountKey}`);
      expect(seen[0].sig).toBeNull();
    } finally {
      vi.restoreAllMocks();
      clean(env);
    }
  });

  // FIX (b): account configured purely via AGENTKV_ACCOUNT_KEY env (no file). `show` must
  // build an account-mode client from the env vars and report configured:true WITH a balance
  // (previously omitted because cli.ts only built a client when an account FILE existed).
  it("env-only account (AGENTKV_ACCOUNT_KEY + enc key, no file) → configured:true WITH a balance (account bearer)", async () => {
    const AK = `ak_${"c".repeat(64)}`;
    const ENC = `0x${"d".repeat(64)}`;
    const env = tmpEnv({ AGENTKV_ACCOUNT_KEY: AK, AGENTKV_ENCRYPTION_KEY: ENC });
    try {
      expect(peekStoredAccount(env)).toBeNull(); // env-only, no file
      const seen: { url: string; auth: string | null }[] = [];
      vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        seen.push({
          url: typeof input === "string" ? input : input.url,
          auth: h.get("Authorization"),
        });
        return new Response(JSON.stringify({ balance: 555 }), { status: 200 });
      });
      const io = makeIo();
      const code = await runCli(["account", "show"], { env, stdout: io.stdout, stderr: io.stderr });
      expect(code).toBe(0);
      const j = io.outJson();
      expect(j.configured).toBe(true);
      expect(j.source).toMatch(/env/i);
      expect(j.balance).toBe(555);
      expect(seen[0].url).toContain("/credits/balance");
      expect(seen[0].auth).toBe(`Bearer ${AK}`); // env account's bearer, never a wallet
      expect(io.out.join("")).not.toContain(AK); // secret still hidden without --reveal
    } finally {
      vi.restoreAllMocks();
      clean(env);
    }
  });

  // FIX 3: valid AGENTKV_ACCOUNT_KEY + MALFORMED AGENTKV_ENCRYPTION_KEY. The client
  // construction (which validates the enc key) is now INSIDE the try/catch, so a bad key
  // degrades to a balanceError instead of crashing out of `account show`. The account is
  // still reported (configured:true, source env), exit 0.
  it("valid AGENTKV_ACCOUNT_KEY + malformed AGENTKV_ENCRYPTION_KEY → configured:true + balanceError, exit 0 (no crash)", async () => {
    const AK = `ak_${"a".repeat(64)}`;
    const env = tmpEnv({ AGENTKV_ACCOUNT_KEY: AK, AGENTKV_ENCRYPTION_KEY: "0xdeadbeef" });
    try {
      const io = makeIo();
      // NO injected client: runAccount builds its own AgentKV, whose ctor throws on the bad key.
      const code = await runCli(["account", "show"], { env, stdout: io.stdout, stderr: io.stderr });
      expect(code).toBe(0); // degrades, not a crash
      const j = io.outJson();
      expect(j.configured).toBe(true);
      expect(j.source).toMatch(/env/i);
      expect(typeof j.balanceError).toBe("string"); // the ctor error, surfaced as balanceError
      expect(j.balance).toBeUndefined();
      expect(io.err).toHaveLength(0); // did not throw out of runAccount
    } finally {
      clean(env);
    }
  });

  // FIX 4: a SET-but-malformed AGENTKV_ACCOUNT_KEY must ERROR (mirroring clientFromConfig),
  // NOT silently fall back to reporting the stored file account as configured.
  it("malformed AGENTKV_ACCOUNT_KEY (+ a stored file) → clear error, does NOT report the file account", async () => {
    const env = tmpEnv({ AGENTKV_ACCOUNT_KEY: "not-an-ak-key" });
    try {
      // A valid file account exists — the old code would have reported IT as configured.
      await runCli(["account", "new"], { env, stdout: () => {}, stderr: () => {} });
      const io = makeIo();
      const code = await runCli(["account", "show"], { env, stdout: io.stdout, stderr: io.stderr });
      expect(code).not.toBe(0); // errors, does not report the file account
      const e = io.errJson();
      expect(e.code).toBe("invalid_config");
      expect(e.error).toMatch(/ak_<64 lowercase hex>/);
      // The file account is NOT surfaced as configured.
      expect(io.out.join("")).not.toContain("local account file");
      expect(io.out.join("")).not.toContain('"configured": true');
    } finally {
      clean(env);
    }
  });

  // Same env-only case, but via an INJECTED fake client (the DI seam the task calls out):
  // configured:true + the injected balance, secret still hidden.
  it("env-only account → balance via an injected fake client (configured:true + balance)", async () => {
    const AK = `ak_${"e".repeat(64)}`;
    const env = tmpEnv({ AGENTKV_ACCOUNT_KEY: AK });
    try {
      const balance = vi.fn(async () => 999);
      const io = makeIo();
      const code = await runCli(["account", "show"], {
        client: { balance } as any,
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      const j = io.outJson();
      expect(j.configured).toBe(true);
      expect(j.source).toMatch(/env/i);
      expect(j.balance).toBe(999);
      expect(balance).toHaveBeenCalledOnce();
      expect(io.out.join("")).not.toContain(AK); // secret not revealed
    } finally {
      clean(env);
    }
  });
});

describe("account fund", () => {
  // A fixed payer wallet (deliberately separate from the configured account).
  const PAYER = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
  const PAYER_ADDR = privateKeyToAccount(PAYER as `0x${string}`).address;
  const AK = `ak_${"a".repeat(64)}`;
  const ENC = `0x${"b".repeat(64)}`;

  // A v2 PAYMENT-REQUIRED challenge for /account/deposit. Network + asset must match the
  // account-mode client's configured network (default eip155:8453 / Base-mainnet USDC), or
  // the client's network-parity guard refuses to sign the payment.
  function depositChallenge(): string {
    return Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            amount: "1000000",
            asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            payTo: "0x0000000000000000000000000000000000000001",
            resource: "/account/deposit",
            maxTimeoutSeconds: 300,
          },
        ],
      }),
    ).toString("base64");
  }

  it("resolves payer (--from-key) + the env account, calls fundAccount, prints the result (payer key never logged)", async () => {
    const env = tmpEnv({ AGENTKV_ACCOUNT_KEY: AK, AGENTKV_ENCRYPTION_KEY: ENC });
    try {
      const fundAccount = vi.fn(async (_signer: { address: string }, _usd: number) => ({
        credits_added: 50000,
        balance: 50000,
      }));
      const io = makeIo();
      const code = await runCli(["account", "fund", "5", "--from-key", PAYER], {
        client: { fundAccount } as any,
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      expect(io.outJson()).toEqual({ credits_added: 50000, balance: 50000 });
      expect(fundAccount).toHaveBeenCalledOnce();
      const [payerArg, amountArg] = fundAccount.mock.calls[0];
      expect(amountArg).toBe(5);
      // A viem signer built from --from-key (its address), NOT the account bearer.
      expect(payerArg.address).toBe(PAYER_ADDR);
      // The raw payer key is NEVER emitted (stdout or stderr).
      expect(io.out.join("")).not.toContain(PAYER);
      expect(io.err.join("")).not.toContain(PAYER);
    } finally {
      clean(env);
    }
  });

  it("resolves the payer from AGENTKV_PAYER_KEY when no --from-key is given", async () => {
    const env = tmpEnv({
      AGENTKV_ACCOUNT_KEY: AK,
      AGENTKV_ENCRYPTION_KEY: ENC,
      AGENTKV_PAYER_KEY: PAYER,
    });
    try {
      const fundAccount = vi.fn(async (_signer: { address: string }, _usd: number) => ({
        credits_added: 10000,
        balance: 10000,
      }));
      const io = makeIo();
      const code = await runCli(["account", "fund", "1"], {
        client: { fundAccount } as any,
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      expect(fundAccount).toHaveBeenCalledOnce();
      expect(fundAccount.mock.calls[0][0].address).toBe(PAYER_ADDR);
    } finally {
      clean(env);
    }
  });

  it("builds a REAL account-mode client from the file + funds via /account/deposit (owner bearer + payer PAYMENT-SIGNATURE)", async () => {
    const env = tmpEnv();
    try {
      await runCli(["account", "new"], { env, stdout: () => {}, stderr: () => {} });
      const stored = peekStoredAccount(env)!;

      const seen: { url: string; auth: string | null; paySig: string | null }[] = [];
      vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        const url = typeof input === "string" ? input : input.url;
        seen.push({ url, auth: h.get("Authorization"), paySig: h.get("PAYMENT-SIGNATURE") });
        if (!h.get("PAYMENT-SIGNATURE")) {
          return new Response(JSON.stringify({ code: "payment_required" }), {
            status: 402,
            headers: { "PAYMENT-REQUIRED": depositChallenge() },
          });
        }
        return new Response(JSON.stringify({ credits_added: 10000, balance: 10000 }), {
          status: 200,
        });
      });

      const io = makeIo();
      // NO injected client: runAccount builds its own account-mode AgentKV from the file.
      const code = await runCli(["account", "fund", "1", "--from-key", PAYER], {
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      expect(io.outJson()).toEqual({ credits_added: 10000, balance: 10000 });
      expect(seen).toHaveLength(2);
      for (const s of seen) {
        expect(s.url).toContain("/account/deposit");
        expect(s.auth).toBe(`Bearer ${stored.accountKey}`); // the OWNER's account bearer
      }
      expect(seen[0].paySig).toBeNull(); // challenge probe, no payment
      expect(seen[1].paySig).toBeTruthy(); // paid retry
      // Neither secret is printed.
      expect(io.out.join("")).not.toContain(PAYER);
      expect(io.out.join("")).not.toContain(stored.accountKey);
    } finally {
      vi.restoreAllMocks();
      clean(env);
    }
  });

  it("missing payer (no --from-key / env / wallet.json) → no_payer, client not called", async () => {
    const env = tmpEnv({ AGENTKV_ACCOUNT_KEY: AK, AGENTKV_ENCRYPTION_KEY: ENC });
    try {
      const fundAccount = vi.fn();
      const io = makeIo();
      const code = await runCli(["account", "fund", "5"], {
        client: { fundAccount } as any,
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(1); // EXIT.GENERIC
      expect(io.errJson().code).toBe("no_payer");
      expect(fundAccount).not.toHaveBeenCalled();
    } finally {
      clean(env);
    }
  });

  it("no account configured → no_account, client not called", async () => {
    const env = tmpEnv(); // no AGENTKV_ACCOUNT_KEY, no account.json
    try {
      const fundAccount = vi.fn();
      const io = makeIo();
      const code = await runCli(["account", "fund", "5", "--from-key", PAYER], {
        client: { fundAccount } as any,
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(1);
      expect(io.errJson().code).toBe("no_account");
      expect(fundAccount).not.toHaveBeenCalled();
    } finally {
      clean(env);
    }
  });

  it("a malformed --from-key → invalid_payer (USAGE), client not called", async () => {
    const env = tmpEnv({ AGENTKV_ACCOUNT_KEY: AK, AGENTKV_ENCRYPTION_KEY: ENC });
    try {
      const fundAccount = vi.fn();
      const io = makeIo();
      const code = await runCli(["account", "fund", "5", "--from-key", "0xnothex"], {
        client: { fundAccount } as any,
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(2); // EXIT.USAGE
      expect(io.errJson().code).toBe("invalid_payer");
      expect(fundAccount).not.toHaveBeenCalled();
    } finally {
      clean(env);
    }
  });

  it("non-whole / sub-$1 amounts → USAGE before touching the client", async () => {
    const env = tmpEnv({ AGENTKV_ACCOUNT_KEY: AK, AGENTKV_ENCRYPTION_KEY: ENC });
    try {
      const fundAccount = vi.fn();
      for (const amt of ["0.5", "1.5", "0", "abc"]) {
        const io = makeIo();
        const code = await runCli(["account", "fund", amt, "--from-key", PAYER], {
          client: { fundAccount } as any,
          env,
          stdout: io.stdout,
          stderr: io.stderr,
        });
        expect(code).toBe(2); // EXIT.USAGE
        expect(io.errJson().code).toBe("usage");
      }
      expect(fundAccount).not.toHaveBeenCalled();
    } finally {
      clean(env);
    }
  });
});

describe("account with no/bad subcommand", () => {
  it("'account' alone → EXIT.USAGE + stderr code 'usage'", async () => {
    const env = tmpEnv();
    try {
      const io = makeIo();
      const code = await runCli(["account"], { env, stdout: io.stdout, stderr: io.stderr });
      expect(code).toBe(2); // EXIT.USAGE
      expect(io.errJson().code).toBe("usage");
      expect(io.out).toHaveLength(0);
    } finally {
      clean(env);
    }
  });

  it("'account bogus' → EXIT.USAGE", async () => {
    const env = tmpEnv();
    try {
      const io = makeIo();
      const code = await runCli(["account", "bogus"], {
        env,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(2);
      expect(io.errJson().code).toBe("usage");
    } finally {
      clean(env);
    }
  });
});
