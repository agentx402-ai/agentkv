import { describe, expect, it } from "vitest";
import { AgentKV } from "../src/index";
import { AgentKVError } from "../src/types";

const PK = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const EP = "https://api.agentx402.ai";

describe("constructor option validation", () => {
  it("rejects a missing endpoint with invalid_config (not a bare TypeError)", () => {
    const err = (() => {
      try {
        new AgentKV({ privateKey: PK } as any);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AgentKVError);
    expect((err as AgentKVError).code).toBe("invalid_config");
  });

  it("rejects a non-URL endpoint at construction, not at first op", () => {
    expect(() => new AgentKV({ endpoint: "not a url", privateKey: PK })).toThrow(/endpoint/);
    expect(() => new AgentKV({ endpoint: "ftp://x.test", privateKey: PK })).toThrow(/http/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects retries=%s (non-finite would disable or unbound the retry loop)",
    (retries) => {
      expect(() => new AgentKV({ endpoint: EP, privateKey: PK, retries })).toThrow(/retries/);
    },
  );

  it("keeps retries: 0 (no retries), floors fractions, clamps negatives to 0", () => {
    expect(new AgentKV({ endpoint: EP, privateKey: PK, retries: 0 }).maxRetries).toBe(0);
    expect(new AgentKV({ endpoint: EP, privateKey: PK, retries: 2.9 }).maxRetries).toBe(2);
    expect(new AgentKV({ endpoint: EP, privateKey: PK, retries: -1 }).maxRetries).toBe(0);
  });
});

describe("conflicting auth material", () => {
  const AK = `ak_${"ab".repeat(32)}`;
  const ENC = `0x${"11".repeat(32)}` as const;

  it("rejects accountKey + privateKey instead of silently dropping the wallet", () => {
    expect(
      () =>
        new AgentKV({ endpoint: EP, accountKey: AK, encryptionKey: ENC, privateKey: PK } as any),
    ).toThrow(/mutually exclusive|exactly one/i);
  });

  it("rejects accountKey + signer", () => {
    const signer = {
      address: "0x0000000000000000000000000000000000000001",
      signTypedData: async () => "0x",
    } as any;
    expect(
      () => new AgentKV({ endpoint: EP, accountKey: AK, encryptionKey: ENC, signer } as any),
    ).toThrow(/mutually exclusive|exactly one/i);
  });

  it("still accepts accountKey with an explicitly-undefined privateKey (spread configs)", () => {
    const kv = new AgentKV({
      endpoint: EP,
      accountKey: AK,
      encryptionKey: ENC,
      privateKey: undefined,
    } as any);
    expect(kv.accountKey).toBe(AK);
  });

  it("regression: privateKey + encryptionKey stays rejected (the sibling silent-ignore guard)", () => {
    const err = (() => {
      try {
        new AgentKV({ endpoint: EP, privateKey: PK, encryptionKey: ENC } as any);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AgentKVError);
    expect((err as AgentKVError).code).toBe("invalid_config");
    expect((err as AgentKVError).message).toMatch(/signer, encryptionKey/);
  });
});
