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
  // Reject sub-$1 and sub-atomic (fractional) amounts up front, mirroring the
  // client's deposit() guard, so the CLI fails with USAGE instead of a round-trip.
  if (!Number.isFinite(usd) || usd < 1 || usd * 1_000_000 !== Math.round(usd * 1_000_000)) {
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
