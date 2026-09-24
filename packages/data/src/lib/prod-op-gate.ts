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
 * via cancellation-census.ts, before it claims and while it runs. A runner
 * that must WAIT on the census rather than read it once passes it as `andAlso`
 * (cc-151 D2): a second half, read only on polls where the gate reads ok, so a
 * blocked gate costs no Logs API read. The window is open when both are.
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

/** The second half of a poll (cc-151 D2) — e.g. the census. */
export interface AlsoReading {
  /** Short name, used as the block token when this half holds the window: `census`. */
  name: string;
  ok: boolean;
  /** One line: `pass (0/60 min, ratio 0.00, floor 6)`, `FAIL (…)`, `dark (…)`, `skipped — local`. */
  summary: string;
}

/** One poll, as the receipt records it. */
export interface GatePoll {
  at: string;
  /** The window: the gate AND, when a second half is given, that half. */
  ok: boolean;
  /**
   * `check:name` per gate block, `read-error` when the gate could not be read,
   * or the second half's name (`census`) when the gate read ok and it did not.
   */
  blocked: string[];
  error?: string;
  /** The gate's own verdict, present when a second half is given. */
  gate_ok?: boolean;
  /** The second half, when it was read (only on polls where the gate read ok). */
  also?: AlsoReading;
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

/**
 * The poll line with a second half:
 *   [gate] 05:00:00Z ok=false blocked_by=[c:blackout(→09:00)] census=skipped (gate blocked) next_poll=05:05:00Z
 *   [gate] 09:00:00Z ok=false blocked_by=[census] census=FAIL (7/60 min, ratio 3.54, floor 6; …) next_poll=09:05:00Z
 *   [gate] 09:05:00Z ok=true blocked_by=[] census=pass (2/60 min, ratio 1.01, floor 6; …) (expected 3600 s, span to 11:05Z)
 */
export function formatPollLine(
  g: ProdOpGate | null, also: AlsoReading | null, name: string, at: Date, nextPoll: Date | null, error?: string,
): string {
  const open = g !== null && g.ok && also !== null && also.ok;
  const blocked = g === null ? ["read-error"] : !g.ok ? g.blocked_by.map(blockToken) : also && !also.ok ? [also.name] : [];
  const half = also ? also.summary : g === null ? "skipped (gate unreadable)" : "skipped (gate blocked)";
  return `[gate] ${hhmmss(at)} ok=${open} blocked_by=[${blocked.join(", ")}] ${name}=${half}` +
    (error ? ` (gate READ ERROR: ${error})` : "") +
    (open && g ? ` (expected ${g.expected_seconds} s, span to ${hhmm(g.span_end)}Z)` : "") +
    (!open && nextPoll ? ` next_poll=${hhmmss(nextPoll)}` : "");
}

/** Thrown when the gate never opened inside `maxWaitSeconds`. */
export class GateTimeout extends Error {
  readonly last: ProdOpGate | null;
  readonly polls: GatePoll[];
  /** The half that held the LAST poll: the second half with its summary, else the gate's last blocks. */
  readonly lastBlockedBy: string;
  constructor(last: ProdOpGate | null, polls: GatePoll[], waitedSeconds: number) {
    const p = polls[polls.length - 1];
    const lastBlockedBy = p?.also && !p.also.ok
      ? `${p.also.name}: ${p.also.summary}`
      : last
        ? last.blocked_by.map(blockToken).join(", ") || "(read error)"
        : "(never read)";
    super(
      `prod_op_gate() did not open in ${Math.round(waitedSeconds / 60)} min (${polls.length} polls); last: ` +
        lastBlockedBy,
    );
    this.name = "GateTimeout";
    this.last = last;
    this.polls = polls;
    this.lastBlockedBy = lastBlockedBy;
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
  /**
   * A second half (cc-151 D2), read ONLY on polls where the gate reads ok; the
   * window opens when both do. It must not throw — a reading it cannot take
   * (the Logs API dark) returns `ok: false`, so the wait keeps polling. If it
   * does throw anyway, the poll counts as blocked by it (fail closed).
   */
  andAlso?: { name: string; read: () => Promise<AlsoReading> };
  /** Test seams. */
  readGate?: (dbUrl: string, expectedSeconds: number) => Promise<ProdOpGate>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface WaitResult {
  gate: ProdOpGate;
  /** The second half's opening reading, when one was given. */
  also: AlsoReading | null;
  polls: GatePoll[];
  waitedSeconds: number;
}

/**
 * Poll until the gate reads `ok=true` — and, with `andAlso`, until its second
 * half does too on the same poll; return that reading. Throws
 * {@link GateTimeout} with the last reading when `maxWaitSeconds` passes.
 * The first poll is immediate.
 */
export async function waitForProdOpGate(opts: WaitOptions): Promise<WaitResult> {
  const pollMs = Math.max(1, opts.pollSeconds ?? 300) * 1000;
  const log = opts.log ?? ((l: string) => console.log(l));
  const read = opts.readGate ?? readProdOpGateOnce;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const also = opts.andAlso ?? null;

  const t0 = now();
  const deadline = t0 + opts.maxWaitSeconds * 1000;
  const polls: GatePoll[] = [];
  let last: ProdOpGate | null = null;

  for (;;) {
    const at = new Date(now());
    const next = new Date(at.getTime() + pollMs);
    const lastChance = next.getTime() > deadline;
    let g: ProdOpGate | null = null;
    let error: string | undefined;
    try {
      g = await read(opts.dbUrl, opts.expectedSeconds);
      last = g;
    } catch (err) {
      error = errText(err);
    }
    if (!also) {
      if (g) {
        polls.push({ at: at.toISOString(), ok: g.ok, blocked: g.blocked_by.map((b) => `${b.check}:${b.name}`) });
        log(formatGateLine(g, at, g.ok || lastChance ? null : next));
        if (g.ok) return { gate: g, also: null, polls, waitedSeconds: (now() - t0) / 1000 };
      } else {
        polls.push({ at: at.toISOString(), ok: false, blocked: ["read-error"], error });
        log(`[gate] ${hhmmss(at)} READ ERROR — counted as blocked: ${error}` +
          (lastChance ? "" : ` next_poll=${hhmmss(next)}`));
      }
    } else {
      // The second half is read only when the gate itself is open.
      let a: AlsoReading | null = null;
      if (g?.ok) {
        try {
          a = await also.read();
        } catch (err) {
          a = { name: also.name, ok: false, summary: `error (${errText(err)}) — counted as blocked` };
        }
      }
      const open = g !== null && g.ok && a !== null && a.ok;
      const blocked = g === null ? ["read-error"]
        : !g.ok ? g.blocked_by.map((b) => `${b.check}:${b.name}`)
          : open ? [] : [also.name];
      polls.push({
        at: at.toISOString(), ok: open, blocked, gate_ok: g?.ok ?? false,
        ...(a ? { also: a } : {}), ...(error ? { error } : {}),
      });
      log(formatPollLine(g, a, also.name, at, open || lastChance ? null : next, error));
      if (open) return { gate: g!, also: a, polls, waitedSeconds: (now() - t0) / 1000 };
    }
    if (lastChance) throw new GateTimeout(last, polls, (now() - t0) / 1000);
    await sleep(Math.max(0, next.getTime() - now()));
  }
}
