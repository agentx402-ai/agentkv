import { describe, expect, it } from "vitest";
import {
  CoinbaseOnramp,
  DEFAULT_ONRAMP_PROVIDER,
  getOnrampProvider,
  PROVIDERS,
} from "../src/onramp";

const ADDR = "0x1234567890abcdef1234567890abcdef12345678" as const;

describe("CoinbaseOnramp.buildUrl", () => {
  it("builds a pay.coinbase.com URL containing the address, USDC, Base, and the appId", () => {
    const url = new CoinbaseOnramp().buildUrl({
      address: ADDR,
      network: "eip155:8453",
      config: { appId: "proj-123" },
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://pay.coinbase.com/buy/select-asset");
    expect(u.searchParams.get("appId")).toBe("proj-123");
    expect(u.searchParams.get("defaultAsset")).toBe("USDC");
    expect(u.searchParams.get("defaultNetwork")).toBe("base");
    // addresses is a JSON map of { address: [networks] }
    expect(JSON.parse(u.searchParams.get("addresses") ?? "")).toEqual({ [ADDR]: ["base"] });
    // the buyable asset list is pinned to USDC
    expect(JSON.parse(u.searchParams.get("assets") ?? "")).toEqual(["USDC"]);
    // the raw address appears in the URL string
    expect(url).toContain(ADDR);
  });

  it("includes presetFiatAmount when a positive amount is given, omits it otherwise", () => {
    const with25 = new CoinbaseOnramp().buildUrl({
      address: ADDR,
      network: "eip155:8453",
      amountUsd: 25,
      config: { appId: "p" },
    });
    expect(new URL(with25).searchParams.get("presetFiatAmount")).toBe("25");

    const none = new CoinbaseOnramp().buildUrl({
      address: ADDR,
      network: "eip155:8453",
      config: { appId: "p" },
    });
    expect(new URL(none).searchParams.has("presetFiatAmount")).toBe(false);
  });

  it("rounds preset fiat to 2 decimals half-up, correcting IEEE-754 error (money formatter)", () => {
    // These 2dp dollar values aren't exactly representable in IEEE-754, so a bare
    // Math.round(n*100) mis-rounds them (5.015→5.01, 1.005→1, 0.145→0.14). The formatter
    // must round half-up on the intended 2dp value instead.
    const cases: [number, string][] = [
      [5.015, "5.02"],
      [1.005, "1.01"],
      [0.145, "0.15"],
      [25, "25"], // whole numbers unchanged
      [10.005, "10.01"],
      [5.01, "5.01"], // already-2dp values unchanged
    ];
    for (const [amountUsd, expected] of cases) {
      const url = new CoinbaseOnramp().buildUrl({
        address: ADDR,
        network: "eip155:8453",
        amountUsd,
        config: { appId: "p" },
      });
      expect(new URL(url).searchParams.get("presetFiatAmount")).toBe(expected);
    }
  });

  it("a positive sub-cent amount THROWS (never presetFiatAmount=0), $0.01 is the floor", () => {
    // 0.004 rounds to $0 at cent granularity — emitting presetFiatAmount=0 would pre-fill a
    // $0 onramp. Reject it with a clear minimum instead.
    let url: string | undefined;
    expect(() => {
      url = new CoinbaseOnramp().buildUrl({
        address: ADDR,
        network: "eip155:8453",
        amountUsd: 0.004,
        config: { appId: "p" },
      });
    }).toThrow(/0\.01 minimum/);
    expect(url).toBeUndefined(); // no URL produced

    // Exactly at the floor: $0.01 is fine and pre-fills presetFiatAmount=0.01.
    const ok = new CoinbaseOnramp().buildUrl({
      address: ADDR,
      network: "eip155:8453",
      amountUsd: 0.01,
      config: { appId: "p" },
    });
    expect(new URL(ok).searchParams.get("presetFiatAmount")).toBe("0.01");
  });

  it("THROWS an actionable error naming the env var when appId is missing", () => {
    expect(() =>
      new CoinbaseOnramp().buildUrl({ address: ADDR, network: "eip155:8453", config: {} }),
    ).toThrow(/AGENTKV_ONRAMP_APP_ID/);
    // empty / whitespace appId is treated as missing (never a broken URL)
    expect(() =>
      new CoinbaseOnramp().buildUrl({
        address: ADDR,
        network: "eip155:8453",
        config: { appId: "   " },
      }),
    ).toThrow(/AGENTKV_ONRAMP_APP_ID/);
  });

  it("throws on a non-Base network (delivering to the wrong chain would lose funds)", () => {
    expect(() =>
      new CoinbaseOnramp().buildUrl({
        address: ADDR,
        network: "eip155:1",
        config: { appId: "p" },
      }),
    ).toThrow(/Base/);
  });

  it("accepts only Base MAINNET ids (and the literal 'base') as Base", () => {
    for (const network of ["eip155:8453", "base", "8453"]) {
      const url = new CoinbaseOnramp().buildUrl({ address: ADDR, network, config: { appId: "p" } });
      expect(new URL(url).searchParams.get("defaultNetwork")).toBe("base");
    }
  });

  it("THROWS a clear testnet error for Base Sepolia — never a mainnet URL (real-money bug)", () => {
    // Coinbase Onramp buys REAL mainnet USDC and has no Base Sepolia support. Mapping a
    // testnet id to "base" would hand a testnet-configured user a real mainnet buy link.
    for (const network of ["eip155:84532", "84532"]) {
      let url: string | undefined;
      expect(() => {
        url = new CoinbaseOnramp().buildUrl({ address: ADDR, network, config: { appId: "p" } });
      }).toThrow(/testnet|Base mainnet only/i);
      expect(url).toBeUndefined(); // no URL was produced
    }
    // The message is actionable (names the network + a faucet alternative).
    expect(() =>
      new CoinbaseOnramp().buildUrl({
        address: ADDR,
        network: "eip155:84532",
        config: { appId: "p" },
      }),
    ).toThrow(/eip155:84532/);
    expect(() =>
      new CoinbaseOnramp().buildUrl({
        address: ADDR,
        network: "eip155:84532",
        config: { appId: "p" },
      }),
    ).toThrow(/faucet/i);
  });
});

describe("getOnrampProvider", () => {
  it("returns the Coinbase provider for 'coinbase'", () => {
    const p = getOnrampProvider("coinbase");
    expect(p.id).toBe("coinbase");
    expect(p).toBe(PROVIDERS.coinbase);
  });

  it("throws on an unknown id, listing the known providers", () => {
    expect(() => getOnrampProvider("nope")).toThrow(/unknown onramp provider/);
    expect(() => getOnrampProvider("nope")).toThrow(/coinbase/);
  });

  it("the default provider id is registered", () => {
    expect(() => getOnrampProvider(DEFAULT_ONRAMP_PROVIDER)).not.toThrow();
  });
});
