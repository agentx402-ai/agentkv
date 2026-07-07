import { privateKeyToAccount } from "viem/accounts";
import { parseFlags } from "../args";
import { readConfigFile, resolveConfig } from "../config";
import { peekStoredAccount, peekStoredWallet } from "../keystore";
import { getOnrampProvider } from "../onramp";
import { EXIT, printError, printJson, type Writer } from "../output";

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

// `agentkv fund [amountUsd]` — print a card→USDC onramp URL that delivers USDC to the
// agent's wallet. This is a LOCAL command (like `wallet` / `account`): building a URL needs
// no client or network round-trip. The onramp provider is selectable/decoupled — this
// command only knows the `OnrampProvider` interface (via getOnrampProvider).

export function runFund(
  args: string[],
  io: { stdout: Writer; stderr: Writer; env?: NodeJS.ProcessEnv },
): number {
  const env = io.env ?? process.env;
  const { flags, positionals } = parseFlags(args);

  // Optional preset amount (first positional). Reject a malformed/non-positive value rather
  // than silently dropping it — a typo'd amount shouldn't quietly fund $0.
  let amountUsd: number | undefined;
  if (positionals.length > 0) {
    const n = Number(positionals[0]);
    if (!Number.isFinite(n) || n <= 0) {
      printError(
        io.stderr,
        "usage",
        `amount must be a positive number (got ${JSON.stringify(positionals[0])})`,
      );
      return EXIT.USAGE;
    }
    amountUsd = n;
  }

  const cfg = resolveConfig(flags, env, () => readConfigFile(env));
  const providerId = cfg.onrampProvider ?? "coinbase";
  const onrampConfig = cfg.onrampConfig ?? {};

  // Resolve the destination wallet address. Precedence mirrors the client/`wallet show`:
  //   1. AGENTKV_PRIVATE_KEY (explicit wallet key) -> its address
  //   2. the local keystore wallet (auto-provisioned), if one exists
  // We do NOT auto-provision here (peekStoredWallet never creates) — funding should target
  // a wallet the user already has, not silently mint one as a side effect of `fund`.
  let address: `0x${string}` | undefined;
  const envKey = env.AGENTKV_PRIVATE_KEY?.trim();
  if (envKey) {
    // A SET-but-malformed AGENTKV_PRIVATE_KEY is an ERROR, not "absent": clientFromConfig
    // hands the same malformed key to the SDK constructor which THROWS on every real op, so
    // silently funding the DIFFERENT keystore wallet here would deliver real USDC to a wallet
    // the client never uses. (Mirrors the account-key fix in commands/account.ts.)
    if (!KEY_RE.test(envKey)) {
      printError(
        io.stderr,
        "invalid_config",
        "AGENTKV_PRIVATE_KEY is set but malformed (expected 0x followed by 64 hex chars)",
      );
      return EXIT.GENERIC;
    }
    address = privateKeyToAccount(envKey as `0x${string}`).address;
  } else {
    address = peekStoredWallet(env)?.address;
  }

  if (!address) {
    // No fundable wallet. If we're in account-key mode, explain how account credits are
    // funded (a deposit from a signing wallet) — there's no single wallet address to onramp
    // to. Either way, guide the user; never crash or emit a broken URL.
    const account = peekStoredAccount(env);
    const inAccountMode = !!(env.AGENTKV_ACCOUNT_KEY?.trim() || account);
    if (inAccountMode) {
      printJson(io.stdout, {
        provider: providerId,
        url: null,
        address: null,
        note:
          "Account-key mode has no single wallet to onramp into. Account credits are funded by " +
          `depositing USDC to ${cfg.endpoint}/account/deposit from a wallet that can sign (e.g. awal). ` +
          "An onramp can fund such a signing wallet: fund a wallet first (e.g. send USDC to it, " +
          "or set AGENTKV_PRIVATE_KEY and re-run `agentkv fund`), then deposit to the account.",
      });
      return EXIT.OK;
    }
    // No wallet and not account mode: a wallet is auto-provisioned on first paid use. Tell
    // the user how to materialize one so `fund` has an address to target.
    printJson(io.stdout, {
      provider: providerId,
      url: null,
      address: null,
      note:
        "No wallet yet — one is auto-provisioned on the first paid op (e.g. `agentkv balance`), or set " +
        "AGENTKV_PRIVATE_KEY to use your own. Provision/configure a wallet, then re-run `agentkv fund` for a funding URL.",
    });
    return EXIT.OK;
  }

  // Build the URL via the selected provider. A bad provider id or missing provider config
  // (e.g. Coinbase appId) throws a clear, actionable error — surfaced as a non-zero exit.
  let provider: ReturnType<typeof getOnrampProvider>;
  try {
    provider = getOnrampProvider(providerId);
  } catch (e) {
    printError(io.stderr, "unknown_provider", e instanceof Error ? e.message : String(e));
    return EXIT.USAGE;
  }

  let url: string;
  try {
    url = provider.buildUrl({ address, network: cfg.network, amountUsd, config: onrampConfig });
  } catch (e) {
    printError(io.stderr, "onramp_config", e instanceof Error ? e.message : String(e));
    return EXIT.GENERIC;
  }

  printJson(io.stdout, {
    provider: provider.id,
    url,
    address,
    ...(amountUsd !== undefined ? { amountUsd } : {}),
    note: `Open this URL to buy USDC with a card and deliver it to ${address} on Base via ${provider.name}.`,
  });
  return EXIT.OK;
}
