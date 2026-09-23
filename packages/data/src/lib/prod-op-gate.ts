/**
 * FIX-1215 — read and wait on `public.prod_op_gate()`.
 *
 * The DB half is migration 20260920120000_fix1215_prod_op_gate.sql: the
 * prod-op window (PROMPT_TEMPLATE.md gates (a), (d), (e), (g) and rule 155's
 * vacuum spacing) as a function of the instruments. This is the side that
 * polls it, so a runner WAITS for the window rather than a human computing a
 * clock and staying awake for it (rule 65: prod ops are clocked to CONDITIONS).
 *
 * ── ONE SHORT-LIVED CONNECTION PER POLL ─────────────────────────────────────
 * Connect, `SET statement_timeout = '30s'` as its own statement, one SELECT,
 * close. A connection held open across a 4-hour wait is one of prod's 60
 * `max_connections` doing nothing, and an idle one is exactly what a pooler
 * hiccup strands. The 30 s bound sits far above the function's cost (a few ms
 * over an 11 MB cron.job_run_details) and far below the role's 3 h ceiling.
 *
 * ── A READ THAT FAILS IS "NOT OK", NEVER "OK" ───────────────────────────────
 * The wait fails CLOSED: an unreachable database, a missing function or a
 * timeout is logged as its own line and the poll counts as blocked. A gate
 * that opened because it could not be read would be the one failure this
 * exists to prevent.
 *
 * ── NOT HERE ────────────────────────────────────────────────────────────────
 * The 57014 / front-door census (Logs API, rule 20). A runner reads it itself
 * via cancellation-census.ts, before it claims and while it runs.
 */

import type { Client } from "pg";
import { errText } from "./session-lock";

/** One entry of `prod_op_gate()->'blocked_by'`. */
export interface GateBlock {
  check: string;
  name: string;
  detail: string;
  retry_after: string | null;
}

/** The shape `public.prod_op_gate()` returns. */
export interface ProdOpGate {
  ok: boolean;
  checked_at: string;
  expected_seconds: number;
  span_end: string;
  blocked_by: GateBlock[];
  readings: Record<string, unknown>;
}

/** One poll, as the receipt records it. */
export interface GatePoll {
  at: string;
  ok: boolean;
  /** `check:name` per block, or `read-error` when the gate could not be read. */
  blocked: string[];
  error?: string;
}

/** Read the gate on an already-open client. Throws on any failure. */
export async function readProdOpGate(client: Client, expectedSeconds: number): Promise<ProdOpGate> {
  await client.query("SET statement_timeout = '30s'");
  const r = await client.query<{ g: ProdOpGate }>(
    "SELECT public.prod_op_gate($1::int) AS g",
    [Math.max(1, Math.round(expectedSeconds))],
  );
  const g = r.rows[0]?.g;
  if (!g || typeof g.ok !== "boolean") throw new Error("prod_op_gate() returned no verdict");
  return g;
}

/** Open, read, close — the per-poll connection. */
export async function readProdOpGateOnce(dbUrl: string, expectedSeconds: number): Promise<ProdOpGate> {
  const { Client: PgClient } = await import("pg");
  const c = new PgClient({
    connectionString: dbUrl,
    application_name: "civitics_prod_op_gate",
    connectionTimeoutMillis: 15_000,
  });
  await c.connect();
  try {
    return await readProdOpGate(c, expectedSeconds);
  } finally {
    await c.end().catch(() => { /* best effort */ });
  }
}

const hhmmss = (d: Date) => d.toISOString().slice(11, 19) + "Z";
const hhmm = (iso: string) => new Date(iso).toISOString().slice(11, 16);

/** `b:ec-vacuum-analyze(→06:08)` — the compact per-block token. */
export function blockToken(b: GateBlock): string {
  return `${b.check}:${b.name}${b.retry_after ? `(→${hhmm(b.retry_after)})` : ""}`;
}

/**
 * ONE line per poll:
 *   [gate] 05:00:00Z blocked_by=b:ec-vacuum-analyze(→06:10), c:blackout(→09:00) next_poll=05:05:00Z
 *   [gate] 09:05:00Z OK (expected 5400 s, span to 12:05) watchdogs max 0.02/0.01 s
 */
export function formatGateLine(g: ProdOpGate, at: Date, nextPoll: Date | null): string {
  if (g.ok) {
    const wd = (g.readings["watchdogs"] as { jobs?: Array<{ max_wall_10m_s: number | null }> } | undefined)?.jobs ?? [];
    return `[gate] ${hhmmss(at)} OK (expected ${g.expected_seconds} s, span to ${hhmm(g.span_end)}Z)` +
      (wd.length ? ` watchdogs max ${wd.map((w) => w.max_wall_10m_s ?? "?").join("/")} s` : "");
  }
  return `[gate] ${hhmmss(at)} blocked_by=${g.blocked_by.map(blockToken).join(", ")}` +
    (nextPoll ? ` next_poll=${hhmmss(nextPoll)}` : "");
}

/** Thrown when the gate never opened inside `maxWaitSeconds`. */
export class GateTimeout extends Error {
  readonly last: ProdOpGate | null;
  readonly polls: GatePoll[];
  constructor(last: ProdOpGate | null, polls: GatePoll[], waitedSeconds: number) {
    super(
      `prod_op_gate() did not open in ${Math.round(waitedSeconds / 60)} min (${polls.length} polls); last: ` +
        (last ? last.blocked_by.map(blockToken).join(", ") || "(read error)" : "(never read)"),
    );
    this.name = "GateTimeout";
    this.last = last;
    this.polls = polls;
  }
}

export interface WaitOptions {
  dbUrl: string;
  expectedSeconds: number;
  /** Seconds between polls. Default 300. */
  pollSeconds?: number;
  /** Give up after this long. Required: an unbounded wait is not a plan. */
  maxWaitSeconds: number;
  log?: (line: string) => void;
  /** Test seams. */
  readGate?: (dbUrl: string, expectedSeconds: number) => Promise<ProdOpGate>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WaitResult {
  gate: ProdOpGate;
  polls: GatePoll[];
  waitedSeconds: number;
}

/**
 * Poll until the gate reads `ok=true`; return that reading. Throws
 * {@link GateTimeout} with the last reading when `maxWaitSeconds` passes.
 * The first poll is immediate.
 */
export async function waitForProdOpGate(opts: WaitOptions): Promise<WaitResult> {
  const pollMs = Math.max(1, opts.pollSeconds ?? 300) * 1000;
  const log = opts.log ?? ((l: string) => console.log(l));
  const read = opts.readGate ?? readProdOpGateOnce;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;

  const t0 = now();
  const deadline = t0 + opts.maxWaitSeconds * 1000;
  const polls: GatePoll[] = [];
  let last: ProdOpGate | null = null;

  for (;;) {
    const at = new Date(now());
    const next = new Date(at.getTime() + pollMs);
    const lastChance = next.getTime() > deadline;
    try {
      const g = await read(opts.dbUrl, opts.expectedSeconds);
      last = g;
      polls.push({ at: at.toISOString(), ok: g.ok, blocked: g.blocked_by.map((b) => `${b.check}:${b.name}`) });
      log(formatGateLine(g, at, g.ok || lastChance ? null : next));
      if (g.ok) return { gate: g, polls, waitedSeconds: (now() - t0) / 1000 };
    } catch (err) {
      polls.push({ at: at.toISOString(), ok: false, blocked: ["read-error"], error: errText(err) });
      log(`[gate] ${hhmmss(at)} READ ERROR — counted as blocked: ${errText(err)}` +
        (lastChance ? "" : ` next_poll=${hhmmss(next)}`));
    }
    if (lastChance) throw new GateTimeout(last, polls, (now() - t0) / 1000);
    await sleep(Math.max(0, next.getTime() - now()));
  }
}
