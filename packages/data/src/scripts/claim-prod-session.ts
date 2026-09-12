/**
 * FIX-950 — `session:claim-prod`: hold the supervised-prod-session lock in the
 * foreground for as long as a human is working on the box.
 *
 *     pnpm --filter @civitics/data session:claim-prod --reason "FIX-954 set 3 apply" --minutes 90
 *     pnpm --filter @civitics/data session:claim       --reason "clone walk-through"   # active env
 *
 * While this runs, every guarded pg_cron procedure and every nightly writer
 * phase sees `prod_session_state()->>'defer' = true` and logs a `skipped` row
 * with this session's reason instead of running. Ctrl-C releases. So does
 * `kill`. So does the process dying, because the lock is SESSION-scoped and
 * Postgres drops it with the backend — which is why there is no expiry to tune
 * and no stranded-hold mode to recover from.
 *
 * ── THERE IS DELIBERATELY NO `session:release-prod` ─────────────────────────
 * A release command implies detached state that can outlive the thing that set
 * it — and then it implies a TTL, a reaper, a "did someone forget to release?"
 * check, and a stale-hold incident. This design has none of those because the
 * hold IS the process: to release it, stop the process. The one residue a crash
 * can leave is the `pipeline_state.prod_session` LABEL, which is documentation,
 * is reported by the canary as `prod_session_label_stale`, defers nothing, and
 * is overwritten by the next claim.
 *
 * ── THE PREFLIGHT IS THE OTHER HALF OF THE INTERLOCK ────────────────────────
 * This refuses to claim while a heavy writer is live (D4). That is rule 43's
 * first clause — "no concurrent heavy reads during a supervised run" — moved
 * out of prompt prose and into code. `--force` overrides and records what it
 * overrode; a second supervised session is never forceable.
 */

import {
  claimProdSession,
  describeWriters,
  formatAge,
  readProdSessionState,
  withClient,
  ProdSessionRefused,
  DEFAULT_EXPECTED_MINUTES,
  type ProdSessionState,
} from "../lib/prod-session";
import { buildDbUrl } from "../lib/heavy-rebuild";
import type { NamedSessionLock } from "../lib/session-lock";

const TICK_MS = 60_000;

function argValue(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1] ?? null;
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

function usage(): never {
  console.error(
    "Usage: session:claim-prod --reason \"<what you are doing>\" [--minutes N] [--force]\n" +
      "\n" +
      "  --reason   REQUIRED. Reaches every deferred firing's skip_reason, so write\n" +
      "             what an operator reading data_sync_log in six weeks needs.\n" +
      `  --minutes  Expected duration; default ${DEFAULT_EXPECTED_MINUTES}. Twice this is the\n` +
      "             canary's prod_session_overrun threshold. Not an expiry — nothing\n" +
      "             releases the hold but this process ending.\n" +
      "  --force    Claim even though heavy writers are live. Recorded in the label.\n" +
      "             Cannot override another supervised session.\n" +
      "\n" +
      "Ctrl-C to release. There is no release command by design — see the header of\n" +
      "packages/data/src/scripts/claim-prod-session.ts.",
  );
  process.exit(64); // EX_USAGE
}

function statusLine(s: ProdSessionState | null, expected: number): string {
  if (!s) return "  [prod-session] status unreadable (the hold is still live)";
  const age = s.age_seconds == null ? "?" : formatAge(s.age_seconds);
  const writers = (s.live_writers ?? []).length === 0 ? "none" : s.live_writers.join(", ");
  const over = s.age_seconds != null && s.age_seconds > expected * 60 ? "  ⚠ OVER ESTIMATE" : "";
  return `  [prod-session] held ${age} · expected ${expected}m · live_writers: ${writers}${over}`;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const reason = argValue(argv, "--reason");
  const minutesRaw = argValue(argv, "--minutes");
  const force = argv.includes("--force");

  if (!reason || reason.trim() === "") usage();
  const expected = minutesRaw == null ? DEFAULT_EXPECTED_MINUTES : Number(minutesRaw);
  if (!Number.isFinite(expected) || expected <= 0) {
    console.error(`✗ --minutes must be a positive number (got ${JSON.stringify(minutesRaw)})`);
    process.exit(64);
  }

  const dbUrl = buildDbUrl();
  // Redact the password before anything is printed.
  const target = dbUrl.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@");
  console.log(`[prod-session] target: ${target}`);
  console.log(`[prod-session] reason: ${reason}`);

  let lock: NamedSessionLock;
  try {
    lock = await claimProdSession({ reason, expectedMinutes: expected, force });
  } catch (err) {
    if (err instanceof ProdSessionRefused) {
      console.error(`\n✗ REFUSED — ${err.verdict.detail}`);
      if (err.verdict.code === "session-held") {
        console.error(
          "  Two supervised sessions on one box is the thing this lock exists to\n" +
            "  prevent, so --force does not apply here. Wait, or talk to the holder.",
        );
      }
      process.exit(2);
    }
    throw err;
  }

  if (!lock.acquired) {
    // Only reachable if the lock was taken between the preflight and the
    // acquire — a race the preflight cannot close and does not need to.
    console.error(`\n✗ REFUSED — the session lock was taken first: ${lock.blockedBy ?? "unknown"}`);
    process.exit(2);
  }

  console.log(
    `[prod-session] HELD. Every guarded writer now defers with this reason.\n` +
      `[prod-session] Ctrl-C to release.\n`,
  );

  let releasing = false;
  const release = async (signal: string): Promise<void> => {
    if (releasing) return;
    releasing = true;
    clearInterval(ticker);
    console.log(`\n[prod-session] ${signal} — releasing.`);
    await lock.release();
    process.exit(0);
  };

  // The ticker is not decoration. It re-reads the interlock from the DB, which
  // is the only way to notice that the lock's own connection died underneath
  // us — otherwise this process would go on printing that it holds the box
  // while holding nothing, which is strictly worse than not claiming at all.
  const ticker = setInterval(() => {
    void withClient(dbUrl, readProdSessionState)
      .then((s) => {
        if (s && !s.held) {
          console.error(
            "\n✗ [prod-session] THE HOLD IS GONE — prod_session_state() reports held=false\n" +
              "  while this process still thinks it is holding. The lock connection died.\n" +
              "  Scheduled writers are NO LONGER deferring. Re-claim before continuing.",
          );
          clearInterval(ticker);
          process.exit(1);
        }
        console.log(statusLine(s, expected));
      })
      // A read failure is not evidence either way — it says the status query
      // failed, not that the hold did. Report and keep going.
      .catch(() => console.log("  [prod-session] status read failed (the hold is unchanged)"));
  }, TICK_MS);

  for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.on(sig, () => { void release(sig); });
  }

  // Park until a signal. Both the lock's pg connection and the ticker hold the
  // event loop open, so an exit here is always something the operator asked for
  // or something the ticker above refused to keep quiet about.
  await new Promise<void>(() => { /* until a signal */ });
}

main().catch((err) => {
  console.error("[prod-session] fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
