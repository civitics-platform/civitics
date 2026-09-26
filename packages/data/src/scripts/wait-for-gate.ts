/**
 * FIX-1215 — session:wait-for-gate: wait for the prod-op window, then
 * (optionally) claim the supervised session and run one command under it.
 *
 *   pnpm --filter @civitics/data session:wait-for-gate:prod --expected-minutes 30
 *       → polls public.prod_op_gate(1800) every 5 min; prints the first clear
 *         reading and exits 0. A "when can I?" tool — it claims nothing.
 *
 *   pnpm --filter @civitics/data session:wait-for-gate:prod --expected-minutes 30 \
 *       --reason "FIX-NNN landing" \
 *       --then "node ../../scripts/db-query.mjs --prod --call --yes-i-mean-prod --file step.sql"
 *       → wait → withProdSession({reason}) → run the command → release → exit
 *         with the command's code.
 *
 * ORDER: the WAIT happens BEFORE the claim. A claim held through a four-hour
 * wait would hold every guarded pipeline for nothing (rule 102: a hold must not
 * blind instruments or starve intake).
 *
 * THE CHILD RUNS UNDER THE CLAIM, NOT AS IT. It gets
 * CIVITICS_PROD_SESSION_CLAIMANT=<reason> in its environment, and must itself
 * `SET civitics.prod_session_claimant` on every connection that CALLs a guarded
 * procedure (FIX-1213) — the claim's lock lives on this process's private
 * connection, and a GUC cannot cross a process boundary. `db-query.mjs --call`
 * reads the variable when `--claimant` is not given.
 *
 * THE CENSUS (cc-159 D2, rule 177: every pre-launch condition lives INSIDE the
 * wait loop). `--census stop|report|off`, default `stop` against prod and `off`
 * against local. It is composed exactly as the donor-party runner composes it
 * (cc-151 D2): the second half of a poll, read only when prod_op_gate() reads
 * ok, through the same cancellation-census.ts child.
 *   stop    a FAIL or dark reading holds the window like a blocked gate
 *   report  the reading is taken and logged; a FAIL is recorded as would_trip
 *           and does not hold
 *   off     no Logs API read at all
 * With the census on, every poll is paced off :00/:15/:30/:45 +0–1 min (rule
 * 190 — front-door-watch spends the same token there); the interval stays
 * --poll-seconds.
 *
 * EXIT CODES
 *   0  gate opened (no --then), or the --then command exited 0
 *   2  the claim was refused (another session held, or heavy writers live)
 *   7  the gate never opened inside --max-wait-minutes
 *   64 usage
 *   N  otherwise, the --then command's own exit code
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { CENSUS_EXIT } from "../lib/cancellation-census";
import { buildDbUrl } from "../lib/heavy-rebuild";
import {
  GateTimeout,
  paceOffQuarterHour,
  waitForProdOpGate,
  type AlsoReading,
  type WaitOptions,
} from "../lib/prod-op-gate";
import {
  ProdSessionRefused,
  readProdSessionState,
  withClient,
  withProdSession,
} from "../lib/prod-session";
import { censusHalfReading, runCensus } from "./donor-party-bootstrap-runner";

/** packages/data — the --then command's cwd (rule 135: say where a relative path resolves). */
export const THEN_CWD = path.resolve(__dirname, "..", "..");

/** cc-159 D2 — how the census half takes part in the wait. */
export type GateCensusMode = "stop" | "report" | "off";

/** The window the census half reads, in minutes — the runner's gate half reads the same 60. */
export const GATE_CENSUS_MINUTES = 60;

export interface WaitArgs {
  expectedMinutes: number;
  reason: string | null;
  pollSeconds: number;
  maxWaitMinutes: number;
  then: string | null;
  /** null = not given; {@link resolveCensusMode} picks the default from the target. */
  census: GateCensusMode | null;
}

function argValue(argv: readonly string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1] ?? null;
  const inline = argv.find((a) => a.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : null;
}

/** Parse, or return the usage error. Pure, for the unit suite. */
export function parseWaitArgs(argv: readonly string[]): WaitArgs | { error: string } {
  const num = (flag: string, dflt: number | null): number | null | { error: string } => {
    const raw = argValue(argv, flag);
    if (raw == null) return dflt;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : { error: `${flag} must be a positive number (got ${JSON.stringify(raw)})` };
  };
  const exp = num("--expected-minutes", null);
  if (exp === null) return { error: "--expected-minutes is required" };
  if (typeof exp === "object") return exp;
  const poll = num("--poll-seconds", 300);
  if (poll !== null && typeof poll === "object") return poll;
  const maxWait = num("--max-wait-minutes", 480);
  if (maxWait !== null && typeof maxWait === "object") return maxWait;
  const reason = argValue(argv, "--reason");
  const then = argValue(argv, "--then");
  if (then !== null && (!reason || reason.trim() === "")) return { error: "--then needs --reason (it becomes the claim's reason)" };
  if (reason !== null && /[\r\n\0]/.test(reason)) return { error: "--reason must be one line" };
  const census = argValue(argv, "--census");
  if (census !== null && census !== "stop" && census !== "report" && census !== "off") {
    return { error: `--census must be stop|report|off (got ${JSON.stringify(census)})` };
  }
  return {
    expectedMinutes: exp,
    reason: reason && reason.trim() !== "" ? reason : null,
    pollSeconds: poll as number,
    maxWaitMinutes: maxWait as number,
    then,
    census,
  };
}

/** Local Docker has no Logs API; anything else is prod. The runner's test, verbatim. */
export function isLocalDbUrl(dbUrl: string): boolean {
  return /127\.0\.0\.1|localhost/.test(dbUrl);
}

/** The flag when given; otherwise `stop` against prod and `off` against local. */
export function resolveCensusMode(explicit: GateCensusMode | null, dbUrl: string): GateCensusMode {
  return explicit ?? (isLocalDbUrl(dbUrl) ? "off" : "stop");
}

/**
 * One census reading as the wait's second half. `stop` is the runner's
 * censusHalfReading unchanged (pass or unavailable opens; FAIL or dark holds).
 * `report` never holds: the reading is recorded, and a FAIL says would_trip.
 */
export function gateCensusHalf(mode: "stop" | "report", code: number, summary: string): AlsoReading {
  if (mode === "stop") return censusHalfReading(code, summary);
  const note = code === CENSUS_EXIT.fail
    ? " — would_trip (census report mode: recorded, not held)"
    : code === CENSUS_EXIT.pass || code === CENSUS_EXIT.unavailable
      ? ""
      : " — not held (census report mode)";
  return { name: "census", ok: true, summary: summary + note };
}

/**
 * The census half and the pacing, as the two `waitForProdOpGate` options, or
 * neither for `off` — so `off` cannot read the Logs API: there is no reader to
 * call. `readCensus` is the seam the unit suite replaces.
 */
export function censusWaitOptions(
  mode: GateCensusMode,
  readCensus: () => Promise<{ code: number; summary: string }>,
): Pick<WaitOptions, "andAlso" | "pace"> {
  if (mode === "off") return {};
  return {
    andAlso: {
      name: "census",
      read: async () => {
        const cen = await readCensus();
        return gateCensusHalf(mode, cen.code, cen.summary);
      },
    },
    pace: paceOffQuarterHour,
  };
}

/** The child's environment: the parent's, plus the claimant for FIX-1213. */
export function childEnv(base: NodeJS.ProcessEnv, reason: string): NodeJS.ProcessEnv {
  return { ...base, CIVITICS_PROD_SESSION_CLAIMANT: reason };
}

function usage(msg?: string): never {
  if (msg) console.error(`✗ ${msg}\n`);
  console.error(
    "Usage: session:wait-for-gate[:prod] --expected-minutes N\n" +
      "         [--poll-seconds 300] [--max-wait-minutes 480]\n" +
      "         [--census stop|report|off]\n" +
      "         [--reason \"<why>\" --then \"<command>\"]\n" +
      "\n" +
      "  Polls public.prod_op_gate(N*60) until it reads ok=true (FIX-1215).\n" +
      "  --census (cc-159 D2; default stop on prod, off on local): the 60-min\n" +
      "  cancellation census is read on polls where the gate is ok; stop holds the\n" +
      "  window on FAIL/dark, report records would_trip, off never reads the Logs\n" +
      "  API. With the census on, polls are paced off :00/:15/:30/:45 +0-1 min.\n" +
      "  Without --then: prints the first clear reading and exits 0.\n" +
      "  With --then: claims the supervised prod session (--reason is the claim's\n" +
      "  reason), runs the command through a shell with cwd = packages/data\n" +
      `  (${THEN_CWD}),\n` +
      "  with CIVITICS_PROD_SESSION_CLAIMANT=<reason> in its env, releases, and\n" +
      "  exits with the command's code. The command must SET\n" +
      "  civitics.prod_session_claimant on its own CALL connections (FIX-1213);\n" +
      "  db-query.mjs --call does so from the env var.\n" +
      "\n" +
      "  Exit: 0 ok · 2 claim refused · 7 gate never opened · 64 usage · N the command's code",
  );
  process.exit(64);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) usage();
  const parsed = parseWaitArgs(argv);
  if ("error" in parsed) usage(parsed.error);
  const args = parsed;

  const dbUrl = buildDbUrl();
  const censusMode = resolveCensusMode(args.census, dbUrl);
  console.log(`[gate] target: ${dbUrl.replace(/:\/\/([^:]+):[^@]*@/, "://$1:***@")}`);
  console.log(`[gate] expected ${args.expectedMinutes} min · poll ${args.pollSeconds} s · max wait ${args.maxWaitMinutes} min` +
    ` · census ${censusMode}${args.census === null ? " (default)" : ""}`);

  try {
    const opened = await waitForProdOpGate({
      dbUrl,
      expectedSeconds: args.expectedMinutes * 60,
      pollSeconds: args.pollSeconds,
      maxWaitSeconds: args.maxWaitMinutes * 60,
      ...censusWaitOptions(censusMode, () => runCensus(GATE_CENSUS_MINUTES, (l) => console.log(l))),
    });
    if (opened.also) console.log(`[gate] open: gate ok at ${opened.gate.checked_at}; census ${opened.also.summary}`);
  } catch (err) {
    if (err instanceof GateTimeout) {
      console.error(`✗ ${err.message}`);
      process.exit(7);
    }
    throw err;
  }

  if (args.then === null) {
    console.log("[gate] clear — nothing to run (no --then).");
    process.exit(0);
  }

  const reason = args.reason!;
  let code = 1;
  try {
    code = await withProdSession({ reason, expectedMinutes: args.expectedMinutes }, async () => {
      // withProdSession fails OPEN on an infra error and does not surface a
      // lost acquire race; a --then command must not run believing it is
      // claimed when it is not. The label's pid is this process only if the
      // claim is ours.
      const s = await withClient(dbUrl, readProdSessionState);
      if (!s || !s.held || s.pid !== process.pid) {
        console.error(`✗ the session is not held by this process (${s ? s.reason_text : "unreadable"}) — not running --then`);
        return 2;
      }
      console.log(`[gate] claimed — running: ${args.then} (cwd ${THEN_CWD})`);
      return await new Promise<number>((resolve) => {
        const child = spawn(args.then!, {
          shell: true,
          cwd: THEN_CWD,
          stdio: "inherit",
          env: childEnv(process.env, reason),
        });
        child.on("exit", (c, sig) => resolve(c ?? (sig ? 1 : 0)));
        child.on("error", (e) => { console.error(`✗ --then failed to start: ${e.message}`); resolve(1); });
      });
    });
  } catch (err) {
    if (err instanceof ProdSessionRefused) {
      console.error(`✗ REFUSED — ${err.verdict.detail}`);
      process.exit(2);
    }
    throw err;
  }
  console.log(`[gate] released; --then exited ${code}`);
  process.exit(code);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
