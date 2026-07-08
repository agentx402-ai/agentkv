import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { peekStoredWallet } from "../keystore";
import { EXIT, printError, printJson, type Writer } from "../output";

const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

export function runWallet(
  args: string[],
  io: { stdout: Writer; stderr: Writer; env?: NodeJS.ProcessEnv },
): number {
  const sub = args[0];

  if (sub === "new") {
    // Generate a key to manage yourself via AGENTKV_PRIVATE_KEY. (You don't have to:
    // with no key set, AgentKV creates + manages a local wallet for you on first use.)
    const privateKey = generatePrivateKey();
    printJson(io.stdout, {
      address: privateKeyToAccount(privateKey).address,
      privateKey,
      note: "Optional: set AGENTKV_PRIVATE_KEY to this to manage your own key. Otherwise AgentKV mints + manages a local wallet on first use.",
    });
    return EXIT.OK;
  }

  if (sub === "show") {
    // Surface the active wallet so it can be funded + backed up. Precedence mirrors the
    // client: an explicit AGENTKV_PRIVATE_KEY wins; otherwise the local keystore wallet.
    const env = io.env ?? process.env;
    const envKey = env.AGENTKV_PRIVATE_KEY?.trim();
    if (envKey) {
      // A SET-but-malformed AGENTKV_PRIVATE_KEY is an ERROR, not "absent": every real op
      // throws on it (clientFromConfig -> privateKeyToAccount), so reporting the keystore
      // wallet as the active source would show an identity the client never uses.
      if (!KEY_RE.test(envKey)) {
        printError(
          io.stderr,
          "invalid_config",
          "AGENTKV_PRIVATE_KEY is set but malformed (expected 0x followed by 64 hex chars)",
        );
        return EXIT.GENERIC;
      }
      printJson(io.stdout, {
        address: privateKeyToAccount(envKey as `0x${string}`).address,
        source: "env (AGENTKV_PRIVATE_KEY)",
      });
      return EXIT.OK;
    }
    const stored = peekStoredWallet(env);
    if (stored) {
      printJson(io.stdout, {
        address: stored.address,
        source: "local keystore",
        path: stored.path,
        note: "Back up this file — it is your namespace and holds your funds.",
      });
      return EXIT.OK;
    }
    printJson(io.stdout, {
      address: null,
      note: "No wallet yet — one is created automatically on first use (set / get / deposit / …).",
    });
    return EXIT.OK;
  }

  printError(io.stderr, "usage", "wallet new | wallet show");
  return EXIT.USAGE;
}
