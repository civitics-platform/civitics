/**
 * FIX-1285 — the front-door watchdog restarts a wedged project itself.
 *
 * THE CASE. Three wedges — 2026-08-31 (~17 h), 09-22 (~8 h), 10-06 (8 h 40 m) —
 * each with Postgres alive or recovered underneath, the front door at 95-100 %
 * Cloudflare-class 52x, and each ended ONLY by a hand restart. The FIX-1130
 * watchdog paged DOWN every time; the remediation was a human at work. The
 * Management API exposes the remediation (`POST /v1/projects/{ref}/restart`,
 * fine-grained permission `project_admin_write`, 200 `{}`), so the watchdog can
 * issue it.
 *
 * WHAT THIS IS NOT. Not a Postgres-health detector (the box can be slow and
 * healthy — FIX-1130 removed its 5xx arm for that reason), and not a fix for
 * whatever wedged the box. It bounds how long a wedge lasts once armed.
 *
 * ── THE DECISION IS BUILT ON THE VERDICT, NEVER BESIDE IT ─────────────────────
 *
 * `decideRestart` reads `decideFrontDoorVerdict`'s state and holds it: DOWN has
 * to have been the verdict for 30 minutes of ticks before anything fires. Then,
 * in order: the direct probe must NOT be answering (the Logs half alone never
 * restarts), no restart in the last 60 minutes, fewer than two in 24 hours (a
 * restart loop is worse than an outage). The mode decides last.
 *
 * The project health endpoint is read and REPORTED in the reason, never gated
 * on: what the control plane says about itself during a wedge is unmeasured,
 * and an instrument does not gate another until both are shown to describe the
 * same population.
 *
 * ── STATE LIVES IN UPSTASH ────────────────────────────────────────────────────
 *
 * The hold, the spacing and the cap need memory across ticks, and the one store
 * that survives the outage this exists for is the Upstash database the box
 * memory ring already writes (FIX-1125). Four keys, one MGET per tick. When
 * Upstash does not answer, the decision is `none` — fail SAFE (no restart),
 * never fail open.
 *
 * Pure decision + parse/plan here; the three HTTP calls (Upstash, health,
 * restart) are thin wrappers with an injectable fetch. The route
 * (/api/cron/front-door-watch) only sequences them — the FIX-1130 discipline.
 */

import { upstashRequest, type UpstashCreds, type UpstashReply } from "./box-health-store";
import type { FrontDoorVerdict } from "./front-door-verdict";
import { MGMT_BASE, PROJECT_REF } from "./supabase-logs";

/** DOWN must have been the verdict this long before a restart is considered. */
export const RESTART_HOLD_MS = 30 * 60 * 1000;
/** No second restart within this long of the last one. */
export const RESTART_SPACING_MS = 60 * 60 * 1000;
/** At most this many restarts in any 24 hours. */
export const RESTART_CAP_24H = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Expiry of the WOULD FIRE dedup key: one report-mode email per outage, re-armed after 6 h. */
export const WOULD_RESTART_SENT_TTL_S = 6 * 60 * 60;
/** Expiry of every other key: the cap's window. */
export const RESTART_STATE_TTL_S = 24 * 60 * 60;

export const FRONT_DOOR_RESTART_KEYS = {
  downSince: "civitics:front_door:down_since",
  lastRestartAt: "civitics:front_door:last_restart_at",
  restarts: "civitics:front_door:restarts",
  wouldRestartSent: "civitics:front_door:would_restart_sent",
} as const;

/** MGET order — the order parseRestartState reads. */
export const FRONT_DOOR_RESTART_MGET_KEYS = [
  FRONT_DOOR_RESTART_KEYS.downSince,
  FRONT_DOOR_RESTART_KEYS.lastRestartAt,
  FRONT_DOOR_RESTART_KEYS.restarts,
  FRONT_DOOR_RESTART_KEYS.wouldRestartSent,
] as const;

export type RestartMode = "off" | "report" | "arm";
export type ProjectHealth = "unhealthy" | "healthy" | "unknown";
export type RestartAction = "none" | "would_restart" | "restart" | "skip";

export type RestartInput = {
  verdictState: FrontDoorVerdict["state"];
  probeAnswered: boolean;
  nowMs: number;
  downSinceMs: number | null;
  lastRestartMs: number | null;
  restartsLast24h: number;
  mode: RestartMode;
  tokenPresent: boolean;
  health: ProjectHealth;
  /** Set when the Upstash read failed. The decision is then `none` — fail safe. */
  stateError?: string | null;
};

export type RestartDecision = {
  action: RestartAction;
  reason: string;
  /** How long DOWN has held, or null when the front door is not DOWN. */
  downForMs: number | null;
};

/**
 * `FRONT_DOOR_AUTO_RESTART`: off | report | arm. Unset is `report` — this ships
 * reporting, and arming is a deliberate act in Vercel. Anything else is also
 * `report`, with a warning, so a typo can never arm it.
 */
export function parseRestartMode(raw: string | undefined): { mode: RestartMode; warning: string | null } {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return { mode: "report", warning: null };
  if (v === "off" || v === "report" || v === "arm") return { mode: v, warning: null };
  return { mode: "report", warning: `FRONT_DOOR_AUTO_RESTART="${raw}" is not off|report|arm — reporting` };
}

/** The decision table. See the module header; the order of the rules is the design. */
export function decideRestart(input: RestartInput): RestartDecision {
  const { verdictState, nowMs, downSinceMs, lastRestartMs } = input;
  if (verdictState !== "down") {
    return { action: "none", reason: `front door not DOWN (${verdictState})`, downForMs: null };
  }
  if (input.stateError) {
    return {
      action: "none",
      reason: `state store unreachable (${input.stateError}) — fail safe, no restart`,
      downForMs: null,
    };
  }
  if (downSinceMs === null) {
    return { action: "none", reason: "first DOWN tick — the hold starts now", downForMs: 0 };
  }
  const downForMs = nowMs - downSinceMs;
  const held = Math.floor(downForMs / 60000);
  if (downForMs < RESTART_HOLD_MS) {
    return { action: "none", reason: `held ${held} min, threshold ${RESTART_HOLD_MS / 60000}`, downForMs };
  }
  // Past the hold every reason carries the health read — reported, never gated on.
  const health = `health ${input.health}`;
  if (input.probeAnswered) {
    return {
      action: "skip",
      reason: `the direct probe answers — the Logs half alone never restarts (DOWN ${held} min; ${health})`,
      downForMs,
    };
  }
  if (lastRestartMs !== null && nowMs - lastRestartMs < RESTART_SPACING_MS) {
    const ago = Math.floor((nowMs - lastRestartMs) / 60000);
    return {
      action: "skip",
      reason: `last restart ${ago} min ago — spacing ${RESTART_SPACING_MS / 60000} min (DOWN ${held} min; ${health})`,
      downForMs,
    };
  }
  if (input.restartsLast24h >= RESTART_CAP_24H) {
    return {
      action: "skip",
      reason: `cap ${RESTART_CAP_24H}/24 h — a loop is worse than an outage (DOWN ${held} min; ${health})`,
      downForMs,
    };
  }
  if (input.mode === "off") {
    return { action: "none", reason: `FRONT_DOOR_AUTO_RESTART=off (DOWN ${held} min; ${health})`, downForMs };
  }
  if (input.mode === "report") {
    return { action: "would_restart", reason: `report mode — DOWN ${held} min, probe dark; ${health}`, downForMs };
  }
  if (!input.tokenPresent) {
    return {
      action: "would_restart",
      reason: `FRONT_DOOR_AUTO_RESTART=arm but SUPABASE_MANAGEMENT_RESTART_KEY is not set — reporting only (DOWN ${held} min, probe dark; ${health})`,
      downForMs,
    };
  }
  return { action: "restart", reason: `DOWN ${held} min, probe dark — restarting; ${health}`, downForMs };
}

// ── State ────────────────────────────────────────────────────────────────────

export type RestartState = {
  downSinceMs: number | null;
  lastRestartMs: number | null;
  /** Every stored restart instant (trimmed to 24 h on write, filtered again on read). */
  restartsMs: number[];
  wouldRestartSentMs: number | null;
};

function parseInstant(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/** The MGET reply, in FRONT_DOOR_RESTART_MGET_KEYS. A value that does not parse reads as absent. */
export function parseRestartState(values: unknown[]): RestartState {
  const [down, last, list, sent] = values;
  let restartsMs: number[] = [];
  if (typeof list === "string") {
    try {
      const arr = JSON.parse(list) as unknown;
      if (Array.isArray(arr)) restartsMs = arr.map(parseInstant).filter((x): x is number => x !== null);
    } catch {
      restartsMs = [];
    }
  }
  return {
    downSinceMs: parseInstant(down),
    lastRestartMs: parseInstant(last),
    restartsMs,
    wouldRestartSentMs: parseInstant(sent),
  };
}

/** Restarts inside the cap's window, as of `nowMs`. */
export function restartsWithin24h(state: RestartState, nowMs: number): number {
  return state.restartsMs.filter((t) => nowMs - t < DAY_MS && t <= nowMs).length;
}

/** Report mode emails WOULD FIRE once per outage: when the dedup key is absent. */
export function shouldEmailWouldRestart(decision: RestartDecision, state: RestartState | null): boolean {
  return decision.action === "would_restart" && state !== null && state.wouldRestartSentMs === null;
}

/**
 * The Upstash commands one tick writes after deciding. Pure, so the replay
 * tests drive the same transitions the route does.
 *
 *   - Not DOWN, and something is set → DEL down_since + would_restart_sent (the
 *     outage is over; RECOVERED's edge is one such tick).
 *   - DOWN with no down_since → SET it (NX, so two overlapping ticks agree).
 *   - A restart POST went out (whatever it answered) → last_restart_at, and the
 *     restarts list trimmed to 24 h. Every attempt counts toward the spacing and
 *     the cap: a token that answers 401 must not retry every 15 minutes.
 *   - A WOULD FIRE email is going out → its dedup key, EX 6 h.
 */
export function planRestartStateCommands(args: {
  verdictState: FrontDoorVerdict["state"];
  state: RestartState;
  nowMs: number;
  restartIssued: boolean;
  wouldRestartEmailed: boolean;
}): string[][] {
  const { verdictState, state, nowMs, restartIssued, wouldRestartEmailed } = args;
  const iso = new Date(nowMs).toISOString();
  const K = FRONT_DOOR_RESTART_KEYS;
  const cmds: string[][] = [];

  if (verdictState !== "down") {
    if (state.downSinceMs !== null || state.wouldRestartSentMs !== null) {
      cmds.push(["DEL", K.downSince, K.wouldRestartSent]);
    }
    return cmds;
  }
  if (state.downSinceMs === null) {
    cmds.push(["SET", K.downSince, iso, "EX", String(RESTART_STATE_TTL_S), "NX"]);
  }
  if (restartIssued) {
    const kept = state.restartsMs.filter((t) => nowMs - t < DAY_MS && t <= nowMs);
    const list = JSON.stringify([...kept, nowMs].map((t) => new Date(t).toISOString()));
    cmds.push(["SET", K.lastRestartAt, iso, "EX", String(RESTART_STATE_TTL_S)]);
    cmds.push(["SET", K.restarts, list, "EX", String(RESTART_STATE_TTL_S)]);
  }
  if (wouldRestartEmailed) {
    cmds.push(["SET", K.wouldRestartSent, iso, "EX", String(WOULD_RESTART_SENT_TTL_S)]);
  }
  return cmds;
}

export type RestartStateRead = { ok: true; state: RestartState } | { ok: false; error: string };

/** One MGET of the four keys. */
export async function readRestartState(
  creds: UpstashCreds,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<RestartStateRead> {
  const r = await upstashRequest(creds, "", ["MGET", ...FRONT_DOOR_RESTART_MGET_KEYS], fetchImpl, timeoutMs);
  if (!r.ok) return r;
  const values = (r.reply as UpstashReply | null)?.result;
  if (!Array.isArray(values) || values.length !== FRONT_DOOR_RESTART_MGET_KEYS.length) {
    return { ok: false, error: `upstash MGET: unexpected ${JSON.stringify(values).slice(0, 120)}` };
  }
  return { ok: true, state: parseRestartState(values) };
}

/** Write a tick's commands in ONE pipelined request. No commands, no request. */
export async function writeRestartState(
  creds: UpstashCreds,
  commands: string[][],
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<{ ok: true; commands: number } | { ok: false; error: string }> {
  if (commands.length === 0) return { ok: true, commands: 0 };
  const r = await upstashRequest(creds, "/pipeline", commands, fetchImpl, timeoutMs);
  if (!r.ok) return r;
  const replies = Array.isArray(r.reply) ? (r.reply as UpstashReply[]) : null;
  if (replies === null || replies.length !== commands.length) {
    return { ok: false, error: `upstash pipeline: expected ${commands.length} replies, got ${JSON.stringify(r.reply).slice(0, 120)}` };
  }
  const failed = replies.findIndex((x) => x?.error);
  if (failed >= 0) return { ok: false, error: `upstash ${commands[failed]![0]}: ${replies[failed]!.error}` };
  return { ok: true, commands: commands.length };
}

// ── Management API ───────────────────────────────────────────────────────────

/** Edge-safe timeout: fetch + AbortController only (the FIX-1278 idiom). */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

const HEALTH_SERVICES = "db,pooler,rest";

/**
 * `GET /v1/projects/{ref}/health?services=db,pooler,rest` with the read token
 * (fine-grained `project_admin_read`). 200 is `[{name, healthy, status, …}]`.
 * Read 2026-10-07 02:33:29Z with the existing token: 200, all three
 * `ACTIVE_HEALTHY`. Anything but a parseable 200 is `unknown`.
 */
export async function readProjectHealth(
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5_000,
): Promise<{ health: ProjectHealth; detail: string }> {
  const t = timeoutSignal(timeoutMs);
  try {
    const res = await fetchImpl(`${MGMT_BASE}/projects/${PROJECT_REF}/health?services=${HEALTH_SERVICES}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: t.signal,
    } as RequestInit);
    if (res.status !== 200) return { health: "unknown", detail: `health HTTP ${res.status}` };
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body) || body.length === 0) return { health: "unknown", detail: "health: unexpected body" };
    const rows = body as Array<{ name?: unknown; healthy?: unknown; status?: unknown }>;
    const bad = rows.filter((s) => s.healthy !== true);
    const detail = rows.map((s) => `${String(s.name)} ${String(s.status)}`).join(", ");
    return { health: bad.length ? "unhealthy" : "healthy", detail };
  } catch (err) {
    return { health: "unknown", detail: `health: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    t.clear();
  }
}

export type RestartCall = { ok: boolean; status: number | null; detail: string; ms: number };

/**
 * `POST /v1/projects/{ref}/restart` with the RESTART token (fine-grained
 * `project_admin_write`, nothing else). 200 `{}` on success; 401/403/429 are
 * the documented refusals. A timeout is `status: null` — the request may or may
 * not have landed, which is why the caller counts every attempt.
 */
export async function issueProjectRestart(
  token: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
  now: () => number = Date.now,
): Promise<RestartCall> {
  const t0 = now();
  const t = timeoutSignal(timeoutMs);
  try {
    const res = await fetchImpl(`${MGMT_BASE}/projects/${PROJECT_REF}/restart`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: t.signal,
    } as RequestInit);
    const text = await res.text().catch(() => "");
    return { ok: res.status === 200, status: res.status, detail: text.slice(0, 200), ms: now() - t0 };
  } catch (err) {
    return { ok: false, status: null, detail: err instanceof Error ? err.message : String(err), ms: now() - t0 };
  } finally {
    t.clear();
  }
}

// ── What a reader sees ───────────────────────────────────────────────────────

/** The one line the DOWN email carries about the restart decision. */
export function restartLine(decision: RestartDecision, mode: RestartMode): string {
  return `Auto-restart (FIX-1285, FRONT_DOOR_AUTO_RESTART=${mode}): ${decision.action} — ${decision.reason}`;
}

/** RESTART ISSUED (armed) and RESTART WOULD FIRE (report mode). Plain `<pre>`, like the DOWN email. */
export function renderRestartEmail(args: {
  kind: "issued" | "would_fire";
  decision: RestartDecision;
  mode: RestartMode;
  nowMs: number;
  health: { health: ProjectHealth; detail: string };
  call?: RestartCall | null;
  stateWrite?: string | null;
}): { subject: string; html: string } {
  const { kind, decision, mode, nowMs, health, call, stateWrite } = args;
  const downMin = decision.downForMs === null ? "?" : String(Math.round(decision.downForMs / 60000));
  const outcome = call ? (call.ok ? `HTTP ${call.status}` : `FAILED — ${call.status === null ? call.detail : `HTTP ${call.status}`}`) : "";
  const subject =
    kind === "issued"
      ? `[Civitics][FRONT DOOR RESTART ISSUED] ${outcome} — Supabase project restart after ${downMin} min DOWN`
      : `[Civitics][FRONT DOOR RESTART WOULD FIRE] report mode — the watchdog would restart the project now (${downMin} min DOWN)`;

  const lines = [
    `${kind === "issued" ? "FRONT DOOR RESTART ISSUED" : "FRONT DOOR RESTART WOULD FIRE"} — ${new Date(nowMs).toISOString()}`,
    "",
    `decision: ${decision.action} — ${decision.reason}`,
    `mode: FRONT_DOOR_AUTO_RESTART=${mode}`,
    `project health (Management API, reported, never gated on): ${health.health} — ${health.detail}`,
  ];
  if (call) {
    lines.push(
      `POST /v1/projects/${PROJECT_REF}/restart: ${call.status === null ? "NO RESPONSE" : `HTTP ${call.status}`} in ${call.ms} ms${call.detail ? ` — ${call.detail}` : ""}`,
    );
  }
  if (stateWrite) lines.push(`state store: ${stateWrite}`);
  lines.push(
    "",
    kind === "issued"
      ? "Confirm it landed with pg_postmaster_start_time(). RECOVERED should follow within about 10 minutes of the restart plus the two clean 15-minute buckets the verdict waits for. No second restart for 60 minutes, and at most 2 in 24 hours."
      : "Nothing was restarted. This is what the armed watchdog would have done at this tick. Set FRONT_DOOR_AUTO_RESTART=arm and SUPABASE_MANAGEMENT_RESTART_KEY in Vercel to arm it; until then the hand restart is the remediation (dashboard -> Project Settings -> General -> Restart project). One of these per outage (re-armed after 6 h).",
  );

  const html = `<pre style="font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace">
${lines.join("\n").replace(/</g, "&lt;")}
</pre>`;
  return { subject, html };
}
