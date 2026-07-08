// Card → USDC onramp provider abstraction.
//
// `agentkv fund` builds a funding URL that lets a user buy USDC with a card and have
// it delivered to their AgentKV wallet address. The provider is a DECOUPLED, SELECTABLE
// abstraction: the `fund` command only knows the `OnrampProvider` interface, so a new
// provider is added by writing a class + one registry entry — nothing in the command
// (or its tests) changes.

/** Options passed to a provider to build a funding URL. */
export interface OnrampBuildOpts {
  /** Destination wallet address (where the purchased USDC is delivered). */
  address: `0x${string}`;
  /** CAIP-2 network the wallet/credits live on, e.g. "eip155:8453" (Base mainnet). */
  network: string;
  /** Optional preset fiat (USD) amount to pre-fill in the onramp. */
  amountUsd?: number;
  /** Free-form provider config bag (e.g. Coinbase `appId`). Values may be undefined. */
  config: Record<string, string | undefined>;
}

/** A card→USDC onramp provider. Implementations only build a URL — no network calls. */
export interface OnrampProvider {
  /** Stable id used to select the provider (matches the registry key). */
  id: string;
  /** Human-readable name (shown to the user). */
  name: string;
  /** Build a funding URL for `opts`. THROWS a clear, actionable error if mis-configured. */
  buildUrl(opts: OnrampBuildOpts): string;
}

/**
 * Map a CAIP-2 / AgentKV network id to the network name Coinbase Onramp expects in its
 * `addresses` map. Coinbase Onramp buys REAL Base **mainnet** USDC and does NOT support
 * Base Sepolia, so ONLY the Base mainnet ids map to "base". A testnet id throws a clear,
 * actionable error (mapping it to "base" would emit a real-money mainnet onramp URL —
 * FIX: a testnet-configured deployment must never hand a user a mainnet buy link), and any
 * non-Base chain throws too (an onramp that delivered to the wrong chain would lose funds).
 */
function coinbaseNetworkName(network: string): "base" {
  // Accept the CAIP-2 form ("eip155:8453"), a bare chain id ("8453"), or the literal "base".
  const n = network.trim().toLowerCase();
  if (n === "base" || n === "eip155:8453" || n === "8453") {
    return "base";
  }
  // Base Sepolia (84532): supported by AgentKV for testing, but Coinbase Onramp has no
  // testnet — refuse rather than emit a mainnet URL that would buy real mainnet USDC.
  if (n === "eip155:84532" || n === "84532") {
    throw new Error(
      "Coinbase Onramp supports Base mainnet only; no onramp is available for the " +
        `configured testnet network (${network}). Fund a testnet account from a testnet ` +
        "faucet + a signing wallet instead.",
    );
  }
  throw new Error(
    `coinbase onramp supports Base only; got network ${JSON.stringify(network)}. ` +
      "AgentKV uses Base (eip155:8453) — set AGENTKV_NETWORK accordingly.",
  );
}

/**
 * Coinbase Onramp (https://pay.coinbase.com/buy/select-asset).
 *
 * Builds the "one-click-buy"-style hosted URL with an `appId` (a CDP project id) and an
 * `addresses` map. Verified against Coinbase's docs/demo: the URL is
 *   https://pay.coinbase.com/buy/select-asset
 *     ?appId=<CDP project id>
 *     &addresses={"0x..":["base"]}   (JSON, URL-encoded)
 *     &defaultNetwork=base
 *     &defaultAsset=USDC
 *     &presetFiatAmount=<usd>        (optional)
 * Sources:
 *   - https://docs.cdp.coinbase.com/onramp/docs/api-oneclickbuy
 *   - https://github.com/coinbase/onramp-demo-application
 *
 * Note: Coinbase also offers a secure `sessionToken` flow (POST to mint a single-use
 * token). That needs a server-side CDP secret key + a network round-trip, which is out of
 * scope for a local URL-builder; the appId+addresses direct URL is the documented
 * client-side form and is what we emit.
 */
export class CoinbaseOnramp implements OnrampProvider {
  readonly id = "coinbase";
  readonly name = "Coinbase Onramp";

  buildUrl(opts: OnrampBuildOpts): string {
    const appId = opts.config.appId?.trim();
    if (!appId) {
      // Never emit a broken URL (an empty appId silently fails on Coinbase's side).
      throw new Error(
        "coinbase onramp requires a CDP project id — set AGENTKV_ONRAMP_APP_ID " +
          "(or --onramp-app-id) to the App/Project ID from https://portal.cdp.coinbase.com " +
          "(Onramp → your project).",
      );
    }
    const networkName = coinbaseNetworkName(opts.network);
    const url = new URL("https://pay.coinbase.com/buy/select-asset");
    url.searchParams.set("appId", appId);
    // addresses is a JSON map of { address: [networks] }; URLSearchParams handles the
    // percent-encoding of the JSON for us.
    url.searchParams.set("addresses", JSON.stringify({ [opts.address]: [networkName] }));
    url.searchParams.set("defaultNetwork", networkName);
    url.searchParams.set("defaultAsset", "USDC");
    // assets pins the buyable asset list to USDC (defaultAsset alone only pre-selects it).
    url.searchParams.set("assets", JSON.stringify(["USDC"]));
    if (opts.amountUsd !== undefined && Number.isFinite(opts.amountUsd) && opts.amountUsd > 0) {
      // Coinbase expects a plain number; round to 2 decimals (cents). A bare
      // `Math.round(n * 100)` mis-rounds common 2dp dollar values because they
      // aren't exactly representable in IEEE-754 (5.015*100 = 501.4999… → 5.01,
      // 1.005 → 1). The relative epsilon `(1 + Number.EPSILON)` nudges a value
      // sitting one ULP below a half-cent boundary back up so it rounds half-up
      // correctly, while leaving values that are genuinely below the boundary
      // untouched (the nudge is far smaller than a real sub-cent amount).
      const cents = Math.round(opts.amountUsd * 100 * (1 + Number.EPSILON));
      if (cents === 0) {
        // A positive but sub-half-cent amount (e.g. 0.004) rounds to $0 at cent
        // granularity — emitting presetFiatAmount=0 would pre-fill an onramp with $0.
        // Reject it with a clear minimum instead of silently building a $0 URL.
        throw new Error(
          `amount ${opts.amountUsd} is below the $0.01 minimum an onramp can pre-fill; ` +
            "use an amount of at least $0.01.",
        );
      }
      url.searchParams.set("presetFiatAmount", (cents / 100).toString());
    }
    return url.toString();
  }
}

/**
 * Provider registry. Adding a provider = add a class above + one entry here. The `fund`
 * command and config never need to change.
 */
export const PROVIDERS: Record<string, OnrampProvider> = {
  coinbase: new CoinbaseOnramp(),
};

/** The default provider id when none is configured. */
export const DEFAULT_ONRAMP_PROVIDER = "coinbase";

/** Look up a provider by id; throws (listing known ids) on an unknown id. */
export function getOnrampProvider(id: string): OnrampProvider {
  const provider = PROVIDERS[id];
  if (!provider) {
    const known = Object.keys(PROVIDERS).sort().join(", ");
    throw new Error(`unknown onramp provider ${JSON.stringify(id)}; known providers: ${known}`);
  }
  return provider;
}
