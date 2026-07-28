import { toWholeAtomicUsd } from "@agentkv/client";
import { parseFlags } from "../args";
import { EXIT, printError, printJson, type Writer } from "../output";

export async function runCredits(
  cmd: string,
  args: string[],
  io: { client: any; stdout: Writer; stderr: Writer },
): Promise<number> {
  if (cmd === "balance") {
    printJson(io.stdout, { balance: await io.client.balance() });
    return EXIT.OK;
  }
  const { positionals } = parseFlags(args);
  const usd = Number(positionals[0]);
  // Same acceptance rule as client deposit() — the client's relative-epsilon converter,
  // not exact float equality (33.3*1e6 !== Math.round(33.3*1e6) in IEEE-754, so the old
  // check rejected whole-atomic amounts the client accepts). Fails with USAGE before a
  // round-trip.
  if (!Number.isFinite(usd) || usd < 1 || toWholeAtomicUsd(usd) === null) {
    printError(
      io.stderr,
      "usage",
      "deposit requires <usd> >= 1 (a whole number of atomic USDC units)",
    );
    return EXIT.USAGE;
  }
  printJson(io.stdout, await io.client.deposit(usd));
  return EXIT.OK;
}
