/**
 * FIX-1337 (cc-243) — the child process prod-session-signals.test.ts kills.
 *
 * Claims the session on the DSN in argv[2] through withProdSession(), prints
 * HELD, and waits. The parent sends SIGTERM (POSIX); on Windows, where
 * child.kill() terminates without running any handler, the child raises the
 * signal on itself when SELF_SIGNAL=1 — the handler path is the same.
 */
import { ProdSessionRefused, withProdSession } from "../../lib/prod-session";

async function main(): Promise<void> {
  const dbUrl = process.argv[2];
  if (!dbUrl) throw new Error("usage: prod-session-signal-child.ts <dsn>");
  try {
    await withProdSession({ reason: "cc-243 signal test", expectedMinutes: 1, dbUrl }, async () => {
      process.stdout.write("HELD\n");
      if (process.env["SELF_SIGNAL"] === "1") process.emit("SIGTERM" as NodeJS.Signals);
      await new Promise((r) => setTimeout(r, 60_000));
    });
  } catch (err) {
    if (err instanceof ProdSessionRefused) {
      process.stdout.write("REFUSED\n");
      process.exit(3);
    }
    throw err;
  }
}

void main();
