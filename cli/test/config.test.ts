import { describe, expect, it } from "vitest";
import { clientFromConfig, resolveConfig } from "../src/config";

describe("resolveConfig", () => {
  it("defaults endpoint to the hosted service when none is provided", () => {
    expect(resolveConfig({}, {}).endpoint).toBe("https://api.agentx402.ai");
  });

  it("flags override env override file override defaults; secrets only from env", () => {
    const cfg = resolveConfig(
      { endpoint: "https://flag", maxSpendUsd: 2 },
      {
        AGENTKV_ENDPOINT: "https://env",
        AGENTKV_NETWORK: "eip155:8453",
        AGENTKV_PRIVATE_KEY: "0xabc",
      },
      () => ({ endpoint: "https://file", network: "eip155:84532" }),
    );
    expect(cfg.endpoint).toBe("https://flag"); // flag wins
    expect(cfg.network).toBe("eip155:8453"); // env wins over file
    expect(cfg.maxSpendUsd).toBe(2);
    expect(cfg.privateKey).toBe("0xabc"); // secret from env only
  });
  it("ignores any privateKey present in the config file", () => {
    const cfg = resolveConfig(
      {},
      { AGENTKV_ENDPOINT: "https://e" },
      () => ({ privateKey: "0xLEAK" }) as any,
    );
    expect(cfg.privateKey).toBeUndefined();
  });
  it("malformed/negative AGENTKV_MAX_SPEND_USD throws (fail closed — a typo'd cap must not become 'unlimited')", () => {
    expect(() =>
      resolveConfig({}, { AGENTKV_ENDPOINT: "https://e", AGENTKV_MAX_SPEND_USD: "abc" }),
    ).toThrow(/AGENTKV_MAX_SPEND_USD/);
    expect(() =>
      resolveConfig({}, { AGENTKV_ENDPOINT: "https://e", AGENTKV_MAX_SPEND_USD: "-5" }),
    ).toThrow(/AGENTKV_MAX_SPEND_USD/);
  });
  // biome-ignore lint/suspicious/noTemplateCurlyInString: `${...:-}` is literal shell-expansion syntax quoted in the test name, not a JS template.
  it("treats empty-string env vars as unset (the plugin's ${...:-} fallbacks pass empty strings)", () => {
    const cfg = resolveConfig(
      {},
      {
        AGENTKV_ENDPOINT: "https://e",
        AGENTKV_PRIVATE_KEY: "0xabc",
        AGENTKV_NETWORK: "", // optional, unset by the plugin -> empty
        AGENTKV_ENCRYPTION_KEY: "", // optional secret, unset -> empty
        AGENTKV_MAX_SPEND_USD: "", // empty must NOT become a $0 cap
      },
    );
    expect(cfg.network).toBe("eip155:8453"); // empty -> default, not ""
    expect(cfg.encryptionKey).toBeUndefined(); // empty -> unset (HKDF), not "" key
    expect(cfg.maxSpendUsd).toBeUndefined(); // empty -> no cap, NOT 0
  });

  it("whitespace-only AGENTKV_MAX_SPEND_USD -> undefined (no cap), never Number(' ')===0", () => {
    const cfg = resolveConfig({}, { AGENTKV_ENDPOINT: "https://e", AGENTKV_MAX_SPEND_USD: "   " });
    expect(cfg.maxSpendUsd).toBeUndefined(); // a $0 cap would block every paid op
  });

  it("wires maxSessionSpendUsd ONLY from AGENTKV_MAX_SESSION_SPEND_USD (decoupled from per-op)", () => {
    const perOp = resolveConfig({}, { AGENTKV_ENDPOINT: "https://e", AGENTKV_MAX_SPEND_USD: "5" });
    expect(perOp.maxSpendUsd).toBe(5);
    expect(perOp.maxSessionSpendUsd).toBeUndefined(); // a per-op cap is NOT a lifetime budget

    const both = resolveConfig(
      {},
      {
        AGENTKV_ENDPOINT: "https://e",
        AGENTKV_MAX_SPEND_USD: "5",
        AGENTKV_MAX_SESSION_SPEND_USD: "100",
      },
    );
    expect(both.maxSpendUsd).toBe(5);
    expect(both.maxSessionSpendUsd).toBe(100);
  });
});

describe("AGENTKV_TOPOFF (account-key auto top-off)", () => {
  const AK = `ak_${"a".repeat(64)}`;
  const ENC = `0x${"11".repeat(32)}`;
  const accountEnv = {
    AGENTKV_ACCOUNT_KEY: AK,
    AGENTKV_ENCRYPTION_KEY: ENC,
    AGENTKV_ENDPOINT: "https://api.agentx402.ai",
  };

  it("resolves topoff + prepay amounts from env", () => {
    const cfg = resolveConfig(
      {},
      {
        ...accountEnv,
        AGENTKV_TOPOFF: "awal",
        AGENTKV_PREPAY_WATERMARK: "0.25",
        AGENTKV_PREPAY_TOPOFF: "2",
      },
    );
    expect(cfg.topoff).toBe("awal");
    expect(cfg.prepayWatermarkUsd).toBe(0.25);
    expect(cfg.prepayTopoffUsd).toBe(2);
  });

  it("AGENTKV_TOPOFF=awal in account mode builds a client with prepay defaults + payer", () => {
    const cfg = resolveConfig({}, { ...accountEnv, AGENTKV_TOPOFF: "awal" });
    const kv = clientFromConfig(cfg, { env: accountEnv as NodeJS.ProcessEnv });
    const internals = kv as unknown as { prepay?: object; topoffPayer?: unknown };
    expect(internals.prepay).toEqual({ watermark: 0.5, topoff: 1 });
    expect(typeof internals.topoffPayer).toBe("function");
  });

  it("rejects an unrecognized AGENTKV_TOPOFF value", () => {
    const cfg = resolveConfig({}, { ...accountEnv, AGENTKV_TOPOFF: "venmo" });
    expect(() => clientFromConfig(cfg, { env: accountEnv as NodeJS.ProcessEnv })).toThrow(
      /AGENTKV_TOPOFF/,
    );
  });

  it("rejects AGENTKV_TOPOFF in wallet mode (account-key only)", () => {
    const walletEnv = {
      AGENTKV_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      AGENTKV_ENDPOINT: "https://api.agentx402.ai",
      AGENTKV_TOPOFF: "awal",
    };
    const cfg = resolveConfig({}, walletEnv);
    expect(() => clientFromConfig(cfg, { env: walletEnv as NodeJS.ProcessEnv })).toThrow(
      /account-key/,
    );
  });

  it("rejects AGENTKV_PREPAY_* without AGENTKV_TOPOFF (inert config, fail closed)", () => {
    const cfg = resolveConfig({}, { ...accountEnv, AGENTKV_PREPAY_TOPOFF: "2" });
    expect(() => clientFromConfig(cfg, { env: accountEnv as NodeJS.ProcessEnv })).toThrow(
      /AGENTKV_TOPOFF/,
    );
  });

  it("without AGENTKV_TOPOFF, account mode is unchanged (no prepay, no payer)", () => {
    const cfg = resolveConfig({}, accountEnv);
    const kv = clientFromConfig(cfg, { env: accountEnv as NodeJS.ProcessEnv });
    const internals = kv as unknown as { prepay?: object; topoffPayer?: unknown };
    expect(internals.prepay).toBeUndefined();
    expect(internals.topoffPayer).toBeUndefined();
  });
});

describe("AGENTKV_INLINE (account-key inline pay-per-op)", () => {
  const AK = `ak_${"a".repeat(64)}`;
  const ENC = `0x${"11".repeat(32)}`;
  const accountEnv = {
    AGENTKV_ACCOUNT_KEY: AK,
    AGENTKV_ENCRYPTION_KEY: ENC,
    AGENTKV_ENDPOINT: "https://api.agentx402.ai",
  };

  it("resolves inline from env", () => {
    const cfg = resolveConfig({}, { ...accountEnv, AGENTKV_INLINE: "awal" });
    expect(cfg.inline).toBe("awal");
  });

  it("AGENTKV_INLINE=awal in account mode builds a client with opInlinePayer set (no prepay)", () => {
    const cfg = resolveConfig({}, { ...accountEnv, AGENTKV_INLINE: "awal" });
    const kv = clientFromConfig(cfg, { env: accountEnv as NodeJS.ProcessEnv });
    const internals = kv as unknown as { prepay?: object; opInlinePayer?: unknown };
    expect(typeof internals.opInlinePayer).toBe("function");
    expect(internals.prepay).toBeUndefined(); // opInlinePayer is pay-per-op; no prepay required
  });

  it("rejects an unrecognized AGENTKV_INLINE value", () => {
    const cfg = resolveConfig({}, { ...accountEnv, AGENTKV_INLINE: "venmo" });
    expect(() => clientFromConfig(cfg, { env: accountEnv as NodeJS.ProcessEnv })).toThrow(
      /AGENTKV_INLINE/,
    );
  });

  it("rejects AGENTKV_INLINE in wallet mode (account-key only)", () => {
    const walletEnv = {
      AGENTKV_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      AGENTKV_ENDPOINT: "https://api.agentx402.ai",
      AGENTKV_INLINE: "awal",
    };
    const cfg = resolveConfig({}, walletEnv);
    expect(() => clientFromConfig(cfg, { env: walletEnv as NodeJS.ProcessEnv })).toThrow(
      /account-key/,
    );
  });

  it("without AGENTKV_INLINE, account mode is unchanged (no opInlinePayer)", () => {
    const cfg = resolveConfig({}, accountEnv);
    const kv = clientFromConfig(cfg, { env: accountEnv as NodeJS.ProcessEnv });
    const internals = kv as unknown as { opInlinePayer?: unknown };
    expect(internals.opInlinePayer).toBeUndefined();
  });

  it("both AGENTKV_TOPOFF=awal and AGENTKV_INLINE=awal wire BOTH hooks (SDK's topoffPayer precedence applies at call time)", () => {
    const cfg = resolveConfig(
      {},
      { ...accountEnv, AGENTKV_TOPOFF: "awal", AGENTKV_INLINE: "awal" },
    );
    const kv = clientFromConfig(cfg, { env: accountEnv as NodeJS.ProcessEnv });
    const internals = kv as unknown as { topoffPayer?: unknown; opInlinePayer?: unknown };
    expect(typeof internals.topoffPayer).toBe("function");
    expect(typeof internals.opInlinePayer).toBe("function");
  });
});

describe("AGENTKV_BOOTSTRAP (pay-per-call bootstrap opt-in)", () => {
  const AK = `ak_${"a".repeat(64)}`;
  const ENC = `0x${"11".repeat(32)}`;
  const accountEnv = {
    AGENTKV_ACCOUNT_KEY: AK,
    AGENTKV_ENCRYPTION_KEY: ENC,
    AGENTKV_ENDPOINT: "https://api.agentx402.ai",
  };

  it("unset by default", () => {
    expect(resolveConfig({}, accountEnv).bootstrap).toBeUndefined();
  });

  it("env account key + no AGENTKV_BOOTSTRAP -> bootstrap:false on the constructed client (opt-in stays opt-in)", () => {
    const cfg = resolveConfig({}, accountEnv);
    const kv = clientFromConfig(cfg, { env: accountEnv as NodeJS.ProcessEnv });
    expect((kv as unknown as { bootstrap: boolean }).bootstrap).toBe(false);
  });

  it("env account key + AGENTKV_BOOTSTRAP=1 -> bootstrap:true on the constructed client", () => {
    const env = { ...accountEnv, AGENTKV_BOOTSTRAP: "1" };
    const cfg = resolveConfig({}, env);
    expect(cfg.bootstrap).toBe(true);
    const kv = clientFromConfig(cfg, { env: env as NodeJS.ProcessEnv });
    expect((kv as unknown as { bootstrap: boolean }).bootstrap).toBe(true);
  });

  it("AGENTKV_BOOTSTRAP=true (word form, case-insensitive) -> true", () => {
    expect(resolveConfig({}, { ...accountEnv, AGENTKV_BOOTSTRAP: "TRUE" }).bootstrap).toBe(true);
  });

  it("AGENTKV_BOOTSTRAP=0 -> false (explicitly set, not just unset)", () => {
    expect(resolveConfig({}, { ...accountEnv, AGENTKV_BOOTSTRAP: "0" }).bootstrap).toBe(false);
  });

  it("AGENTKV_BOOTSTRAP=yes (unrecognized) throws instead of silently coercing — parity with AGENTKV_TOPOFF/AGENTKV_INLINE", () => {
    // A typo ("ture", "yes") must not silently become false: fail-safe today, but
    // the user believes they opted in and gets an unexplained bootstrap denial later.
    expect(() => resolveConfig({}, { ...accountEnv, AGENTKV_BOOTSTRAP: "yes" })).toThrow(
      /AGENTKV_BOOTSTRAP.*unrecognized/,
    );
    expect(() => resolveConfig({}, { ...accountEnv, AGENTKV_BOOTSTRAP: "ture" })).toThrow(
      /1\/true\/0\/false/,
    );
  });

  it("rejects AGENTKV_BOOTSTRAP in wallet mode (account-key only), like AGENTKV_TOPOFF/AGENTKV_INLINE", () => {
    const walletEnv = {
      AGENTKV_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      AGENTKV_ENDPOINT: "https://api.agentx402.ai",
      AGENTKV_BOOTSTRAP: "1",
    };
    const cfg = resolveConfig({}, walletEnv);
    expect(() => clientFromConfig(cfg, { env: walletEnv as NodeJS.ProcessEnv })).toThrow(
      /account-key/,
    );
  });
});
