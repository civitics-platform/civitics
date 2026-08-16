/**
 * Closed-loop Cloudflare auto-mitigation (FIX-1045).
 *
 * On a SUSTAINED origin-reaching volume spike this raises the Cloudflare zone's
 * `security_level` to `under_attack` itself, then emails that it ACTED —
 * evidence, timestamp, and how to undo — rather than asking a human to act.
 *
 * WHY IT EXISTS. On 2026-08-15 a crawler cost ~$21/day for 16 hours. The
 * existing alert system was healthy and structurally could not see it: the
 * threshold bands are monthly-cumulative (a $21/day burn takes days to cross an
 * MTD band) and the one fast-moving leading signal watches Supabase CPU. What
 * actually stopped the burn was a vendor email read by a human, ~16 hours in.
 * Under Attack mode then cut origin-reaching traffic ~99% inside one hour. The
 * mitigation works; the DETECTION AND THE HAND ON THE SWITCH were the missing
 * parts, and both are mechanisable.
 *
 * ── SAFETY RAILS (all mandatory, all tested in cf-mitigation-loop.test.ts) ────
 *
 *  1. ESCALATE-ONLY. The loop may only RAISE the level, and may only revert an
 *     escalation IT made. Before acting it re-reads the live zone level; before
 *     reverting it re-reads again and, if the level is not the one it set, it
 *     does NOTHING and emails the discrepancy. It must never fight a manual
 *     setting. If the zone is already at or above the target when the trip
 *     condition fires, it records no trip at all — claiming ownership of a level
 *     it did not set is what would later cause it to lower a human's choice.
 *
 *  2. SUSTAINED MEANS MEASURED-SUSTAINED. The trigger is origin-reaching
 *     requests in a COMPLETE Cloudflare clock hour, so one reading is already an
 *     hour of evidence. A trip additionally requires the threshold breached in
 *     >= 2 DISTINCT hours. Because the GHA cron's real cadence is p50 46 min /
 *     p90 87 min / max 155 min (measured over 200 runs), "two runs" and "two
 *     hours" are not the same thing — the count is keyed on the CF bucket
 *     timestamp, never on the number of ticks, and duplicate readings of the
 *     same hour can never satisfy it. Detection latency is therefore ~2-3 hours
 *     for this class, which at the measured $1.23e-4/request is ~$1.80 of burn
 *     before the loop acts. That is the accepted trade for never tripping on a
 *     single anomalous hour.
 *
 *  3. AUTO-REVERT WITH RE-TRIP. After REVERT_AFTER_HOURS the loop reverts to the
 *     level it recorded, emails, and lets subsequent runs re-trip if the burn
 *     resumes. Under Attack mode is a dam, not a fix (it 403s legitimate
 *     scripted clients and challenges search crawlers), so leaving it on
 *     indefinitely has its own cost — the revert is what makes the loop safe to
 *     leave armed.
 *
 *  4. DEBOUNCED. Breach evidence is cleared on every transition, and a fresh
 *     trip additionally requires MIN_HOURS_BETWEEN_TRIPS since the last revert,
 *     so the loop cannot flap more than once per revert window.
 *
 *  5. FAIL-SAFE. Any Cloudflare API error → record, alert, take no further
 *     action. A broken loop degrades to today's behaviour (alert-only), never to
 *     flapping. The same is true of a missing scope: the token in use on
 *     2026-08-16 has Zone Settings:READ only, so `setZoneSecurityLevel` returns
 *     9109 and the loop records `scope_missing` and stays advisory until a token
 *     with Zone Settings:EDIT is minted.
 *
 *  6. KILL SWITCH. The `cf_auto_mitigation` kill switch (and its
 *     CF_AUTO_MITIGATION_ENABLED env hard-kill) disarms the WRITE while leaving
 *     detection and alerting fully live.
 *
 * ── DESIGN NOTE: WHERE THE STATE LIVES ───────────────────────────────────────
 *
 * `pipeline_state`, one row, key `cf_mitigation_loop` — the same substrate
 * FIX-1040 used for the Upstash limiter's state transitions, for the same
 * reason: durable signals are state TRANSITIONS, not per-request rows. One read
 * and at most one write per snapshot tick, and the write only happens when
 * something actually changed. `abuse_events` was considered and rejected — it is
 * an edge-middleware substrate needing node:crypto and an admin client.
 *
 * The decision function is PURE (`decideMitigationAction`): no clock, no
 * network, no DB. Everything that can be got wrong here mutates production edge
 * config, so the logic is separated from its effects specifically to be
 * hammered by unit tests.
 */

import {
  SECURITY_LEVEL_RANK,
  isScopeError,
  type CloudflareHourBucket,
  type SecurityLevel,
} from "./cloudflare-analytics";

// ── Tunables ──────────────────────────────────────────────────────────────────

/**
 * Origin-reaching requests in one complete clock hour that count as a breach.
 *
 * DERIVED, NOT PICKED. Census of 147 complete hours of Cloudflare history
 * (2026-08-09 03:00 → 2026-08-15 05:00 UTC — everything before the crawl onset,
 * and the whole of what this Free zone retains, which is 8 days):
 *
 *     p50 77   p75 141   p90 283   p95 841   p99 1,508   max 2,218
 *
 * and the unmitigated crawl, for contrast: min 7,158, p50 7,233, max 7,548.
 * There is a 3.2x gap between the busiest legitimate hour ever recorded and the
 * quietest crawl hour, so any value in [2,500, 7,000] separates them perfectly.
 *
 * 3,000 = max legitimate hour x 1.35, rounded. It sits 35% above everything the
 * zone has ever legitimately done, and 2.4x BELOW the crawl floor — so it also
 * catches a crawl running at only 40% of this one's rate. Zero false positives
 * across all 147 legitimate hours; the busiest (2,218, a 2026-08-13 burst) is
 * 26% clear of it.
 *
 * Cost framing: 3,000 origin req/hr sustained is ~$0.37/hr = ~$8.85/day at the
 * measured $1.23e-4/request — roughly 27x a baseline day's $0.33 of consumption.
 * That is a burn worth waking up for, and it is comfortably above the noise.
 *
 * NB the census window is one week. Re-derive from a longer baseline once the
 * zone has a legitimate-traffic month that is not dominated by an incident, and
 * revisit if real human traffic ever grows — at a handful of sessions a day
 * (measured: `web_analytics_events` ~10/day) this threshold has enormous
 * headroom, but it is a request-VOLUME rule and success would move it.
 */
export const TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR = 3000;

/** Distinct breached CF hours required before the loop acts. See rail 2. */
export const REQUIRED_BREACH_HOURS = 2;

/**
 * Breach evidence older than this is forgotten, so two unrelated bad hours a day
 * apart never add up to a trip. 6h ≈ 4 cron ticks at the measured p90 gap.
 */
export const BREACH_WINDOW_HOURS = 6;

/**
 * How long an auto-escalation stays up before the loop reverts it.
 *
 * 6h: long enough that a crawler which backs off has done so, short enough that
 * the collateral (403s to every scripted client, challenges to search crawlers —
 * see docs/CLOUDFLARE.md) is bounded to a quarter-day without human action. If
 * the burn resumes the next runs re-trip. USER-adjustable; Craig was asked.
 */
export const REVERT_AFTER_HOURS = 6;

/** Anti-flap floor between a revert and the next trip. See rail 4. */
export const MIN_HOURS_BETWEEN_TRIPS = 2;

/**
 * FIX-1047 — how often to re-confirm the token can actually write.
 *
 * 12h is a deliberate compromise. The probe is an idempotent PATCH that changes
 * nothing, but it still lands a Cloudflare AUDIT LOG entry, and the audit log is
 * one of the documented ways to tell an automatic change from a manual one. At
 * the measured cron cadence, probing every tick would produce ~40 no-op entries
 * a day and bury exactly the signal it exists to protect. Twice a day keeps the
 * armed/alert-only status fresh enough to act on while leaving the audit log
 * readable.
 *
 * Staleness is harmless for CORRECTNESS: before a real trip the loop attempts
 * the actual write regardless, and that write is authoritative. A stale cache
 * can only make the *reported* status lag, never cause a wrong action.
 */
export const PROBE_SCOPE_INTERVAL_HOURS = 12;

/**
 * FIX-1047 — env override for the trip threshold, so an operator can force a
 * genuine end-to-end trip in a verify run and watch it revert.
 *
 * Mirrors LEADING_DB_CONN_THRESHOLD (FIX-642) and LEADING_FLUID_USD_THRESHOLD
 * (FIX-648), which are overridable for the same reason: an alarm nobody has ever
 * seen fire is an alarm nobody should trust. Without this the only way to
 * exercise the write path was to wait for a real crawl.
 *
 * The EFFECTIVE value rides in the snapshot payload and onto the card, because a
 * threshold quietly lowered for a verify run and then forgotten is its own
 * incident.
 */
export function resolveTripThreshold(): number {
  const raw = process.env["CF_TRIP_ORIGIN_REQ_THRESHOLD"];
  if (raw === undefined) return TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR;
  const n = Number(raw);
  // A non-numeric or non-positive override is ignored rather than obeyed: a
  // typo'd env var must never be able to set the threshold to 0 and trip the
  // loop on every quiet hour.
  return Number.isFinite(n) && n > 0 ? n : TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR;
}

/** The level the loop escalates TO. Never anything below it. */
export const TARGET_LEVEL: SecurityLevel = "under_attack";

/** Cap on the durable transition log so the state row cannot grow unbounded. */
const MAX_TRANSITION_HISTORY = 40;

const HOUR_MS = 3_600_000;

// ── State + decision types ────────────────────────────────────────────────────

export type MitigationBreach = {
  /** CF bucket start, ISO on the hour. The dedup key. */
  hour: string;
  origin_requests: number;
};

export type MitigationTrip = {
  /** Always 'auto' today; the field exists so a future manual trip is legible. */
  tripped_by: "auto";
  tripped_at: string;
  /** The level read from the zone immediately BEFORE the write. */
  previous_level: SecurityLevel;
  /** The level written. Revert refuses if the live zone no longer matches. */
  set_level: SecurityLevel;
  trigger_hours: string[];
  trigger_values: number[];
};

export type MitigationTransition = {
  at: string;
  action: MitigationAction;
  detail: string;
};

/** FIX-1047 — cached verdict from the idempotent write-scope probe. */
export type MitigationScopeProbe = {
  writable: boolean;
  /** true when the failure was specifically a missing-permission 9109. */
  scope_missing: boolean;
  detail: string | null;
  checked_at: string;
};

export type MitigationLoopState = {
  breaches: MitigationBreach[];
  tripped: MitigationTrip | null;
  last_revert_at: string | null;
  transitions: MitigationTransition[];
  /** FIX-1047. Absent until the first probe runs. */
  scope_probe?: MitigationScopeProbe | null;
};

export type MitigationAction =
  | "none"
  | "trip"
  | "revert"
  | "refuse_revert_manual_change"
  | "skip_already_escalated"
  | "skip_debounced"
  | "skip_disabled"
  | "skip_no_scope"
  | "error";

export type MitigationDecision = {
  action: MitigationAction;
  /** Human-readable, goes verbatim into the email body and the payload. */
  reason: string;
  /** Level to write, when action is trip/revert. */
  target_level?: SecurityLevel;
  /** Breached hours backing a trip. */
  trigger_hours?: string[];
  trigger_values?: number[];
};

export function emptyMitigationState(): MitigationLoopState {
  return {
    breaches: [],
    tripped: null,
    last_revert_at: null,
    transitions: [],
    scope_probe: null,
  };
}

/** Is the cached scope verdict stale (or absent)? FIX-1047. */
export function scopeProbeIsDue(
  probe: MitigationScopeProbe | null | undefined,
  nowMs: number,
): boolean {
  if (!probe?.checked_at) return true;
  const age = nowMs - Date.parse(probe.checked_at);
  if (!Number.isFinite(age)) return true;
  return age >= PROBE_SCOPE_INTERVAL_HOURS * HOUR_MS;
}

// ── Breach bookkeeping ────────────────────────────────────────────────────────

/**
 * Fold this tick's Cloudflare hours into the breach set: add any complete hour
 * at or above the threshold, dedupe by bucket timestamp, drop anything older
 * than BREACH_WINDOW_HOURS.
 *
 * Deduping by `hour` is the load-bearing bit — the cron re-reads a 3-hour window
 * every tick and at a p50 46-minute cadence it sees the same bucket twice most
 * of the time. Counting readings instead of hours would let a single bad hour
 * trip the loop on its own.
 */
export function foldBreaches(
  prior: MitigationBreach[],
  hours: CloudflareHourBucket[],
  nowMs: number,
  // Default resolved at CALL time so a verify-run env override is honoured
  // without every call site having to thread it through.
  threshold: number = resolveTripThreshold(),
): MitigationBreach[] {
  const byHour = new Map<string, MitigationBreach>();
  // Re-validate PRIOR evidence against the threshold in force NOW, not the one
  // it was recorded under. Found by the FIX-1047 verify run: dropping the
  // threshold to 10 recorded three ordinary hours (41, 43, 69 req) as breaches,
  // and raising it back to 3,000 left them sitting in the state row for the full
  // 6h window. They were harmless there only because the zone happened to be at
  // under_attack — with the zone lower, stale sub-threshold evidence could have
  // driven a real escalation. A breach is only evidence while it still clears
  // the current bar.
  for (const b of prior) {
    if (b.origin_requests >= threshold) byHour.set(b.hour, b);
  }
  for (const h of hours) {
    if (h.origin_requests >= threshold) {
      byHour.set(h.hour, { hour: h.hour, origin_requests: h.origin_requests });
    }
  }
  const cutoff = nowMs - BREACH_WINDOW_HOURS * HOUR_MS;
  return [...byHour.values()]
    .filter((b) => {
      const t = Date.parse(b.hour);
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => (a.hour < b.hour ? 1 : -1));
}

// ── The decision ──────────────────────────────────────────────────────────────

export type MitigationInputs = {
  state: MitigationLoopState;
  /** Breach set already folded for this tick. */
  breaches: MitigationBreach[];
  /** Live zone level, re-read this tick. null when the read failed. */
  currentLevel: SecurityLevel | null;
  nowMs: number;
  /** false ⇒ the kill switch is off: detect and alert, never write. */
  writesEnabled: boolean;
  /** false ⇒ the token has no Zone Settings:Edit. Alert-only. */
  hasWriteScope: boolean;
};

/**
 * Decide what to do this tick. Pure — no clock, no network, no DB.
 *
 * Revert is evaluated BEFORE trip so an expiring escalation always gets its
 * chance to come down even on a tick where fresh breaches are also present; the
 * next tick can then re-trip through the normal path, which keeps re-escalation
 * on the same evidence rules as a first escalation instead of a special case.
 */
export function decideMitigationAction(input: MitigationInputs): MitigationDecision {
  const { state, breaches, currentLevel, nowMs, writesEnabled, hasWriteScope } = input;

  if (currentLevel === null) {
    return {
      action: "error",
      reason:
        "could not read the current Cloudflare security level — taking no action (fail-safe)",
    };
  }

  // ── Revert path: only ever for an escalation this loop recorded ────────────
  const trip = state.tripped;
  if (trip) {
    const elapsedH = (nowMs - Date.parse(trip.tripped_at)) / HOUR_MS;
    if (!Number.isFinite(elapsedH)) {
      return {
        action: "error",
        reason: `trip record has an unparseable tripped_at (${trip.tripped_at}) — taking no action`,
      };
    }
    if (elapsedH < REVERT_AFTER_HOURS) {
      return {
        action: "none",
        reason:
          `escalated to ${trip.set_level} ${elapsedH.toFixed(1)}h ago; ` +
          `auto-revert due at ${REVERT_AFTER_HOURS}h`,
      };
    }
    // Rail 1: refuse if the live level is not the one we set. Somebody changed
    // it by hand and it is not ours to move. Drop our claim and say so.
    if (currentLevel !== trip.set_level) {
      return {
        action: "refuse_revert_manual_change",
        reason:
          `auto-revert refused: this loop set security_level=${trip.set_level} at ` +
          `${trip.tripped_at}, but the zone now reads ${currentLevel}. Somebody ` +
          `changed it manually, so the loop is releasing its claim and leaving the ` +
          `zone exactly as found. Nothing was written.`,
      };
    }
    if (!writesEnabled) {
      return {
        action: "skip_disabled",
        reason:
          `auto-revert is due (${elapsedH.toFixed(1)}h >= ${REVERT_AFTER_HOURS}h) but the ` +
          `cf_auto_mitigation kill switch is OFF — the zone is still at ` +
          `${trip.set_level} and needs a manual revert`,
      };
    }
    if (!hasWriteScope) {
      return {
        action: "skip_no_scope",
        reason:
          `auto-revert is due but the Cloudflare token lacks Zone Settings:Edit — ` +
          `the zone is still at ${trip.set_level} and needs a manual revert`,
      };
    }
    return {
      action: "revert",
      reason:
        `auto-revert after ${elapsedH.toFixed(1)}h at ${trip.set_level}; ` +
        `restoring the pre-escalation level ${trip.previous_level}. If the burn ` +
        `resumes the next runs will re-trip on fresh evidence.`,
      target_level: trip.previous_level,
    };
  }

  // ── Trip path ─────────────────────────────────────────────────────────────
  if (breaches.length < REQUIRED_BREACH_HOURS) {
    return {
      action: "none",
      reason:
        breaches.length === 0
          ? "no hour above the origin-volume threshold"
          : `${breaches.length} of ${REQUIRED_BREACH_HOURS} required breach hours ` +
            `(${breaches.map((b) => `${b.hour} = ${b.origin_requests}`).join(", ")})`,
    };
  }

  const triggerHours = breaches.slice(0, REQUIRED_BREACH_HOURS).map((b) => b.hour);
  const triggerValues = breaches
    .slice(0, REQUIRED_BREACH_HOURS)
    .map((b) => b.origin_requests);

  // Rail 4: anti-flap.
  if (state.last_revert_at) {
    const sinceRevertH = (nowMs - Date.parse(state.last_revert_at)) / HOUR_MS;
    if (Number.isFinite(sinceRevertH) && sinceRevertH < MIN_HOURS_BETWEEN_TRIPS) {
      return {
        action: "skip_debounced",
        reason:
          `${breaches.length} breach hours would trip, but the last auto-revert was ` +
          `${sinceRevertH.toFixed(1)}h ago and re-trips are debounced for ` +
          `${MIN_HOURS_BETWEEN_TRIPS}h`,
        trigger_hours: triggerHours,
        trigger_values: triggerValues,
      };
    }
  }

  // Rail 1: escalate-only. Never claim a level we did not raise.
  if (SECURITY_LEVEL_RANK[currentLevel] >= SECURITY_LEVEL_RANK[TARGET_LEVEL]) {
    return {
      action: "skip_already_escalated",
      reason:
        `${breaches.length} breach hours, but the zone is already at ` +
        `security_level=${currentLevel} (>= ${TARGET_LEVEL}) and this loop did not ` +
        `set it. Escalate-only: nothing written, and no trip recorded — the loop ` +
        `must never auto-revert a level a human chose.`,
      trigger_hours: triggerHours,
      trigger_values: triggerValues,
    };
  }

  if (!writesEnabled) {
    return {
      action: "skip_disabled",
      reason:
        `${breaches.length} breach hours would escalate ${currentLevel} → ${TARGET_LEVEL}, ` +
        `but the cf_auto_mitigation kill switch is OFF. Alert only.`,
      trigger_hours: triggerHours,
      trigger_values: triggerValues,
    };
  }
  if (!hasWriteScope) {
    return {
      action: "skip_no_scope",
      reason:
        `${breaches.length} breach hours would escalate ${currentLevel} → ${TARGET_LEVEL}, ` +
        `but the Cloudflare token lacks Zone Settings:Edit. Alert only until a token ` +
        `with that scope is in the Vercel env.`,
      trigger_hours: triggerHours,
      trigger_values: triggerValues,
    };
  }

  return {
    action: "trip",
    reason:
      `origin-reaching volume breached ${TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR}/hr in ` +
      `${breaches.length} distinct hours (${breaches
        .map((b) => `${b.hour} = ${b.origin_requests}`)
        .join(", ")}); escalating ${currentLevel} → ${TARGET_LEVEL}`,
    target_level: TARGET_LEVEL,
    trigger_hours: triggerHours,
    trigger_values: triggerValues,
  };
}

// ── State transitions (pure) ──────────────────────────────────────────────────

/** Apply a decision to the state. Pure; the caller persists the result. */
export function applyMitigationDecision(
  state: MitigationLoopState,
  breaches: MitigationBreach[],
  decision: MitigationDecision,
  currentLevel: SecurityLevel | null,
  nowIso: string,
): MitigationLoopState {
  const log = (detail: string): MitigationTransition[] =>
    [{ at: nowIso, action: decision.action, detail }, ...state.transitions].slice(
      0,
      MAX_TRANSITION_HISTORY,
    );

  switch (decision.action) {
    case "trip":
      return {
        // Evidence is consumed by the trip; the revert path re-gathers from
        // scratch, so a stale breach can never contribute to two decisions.
        breaches: [],
        tripped: {
          tripped_by: "auto",
          tripped_at: nowIso,
          previous_level: currentLevel as SecurityLevel,
          set_level: decision.target_level as SecurityLevel,
          trigger_hours: decision.trigger_hours ?? [],
          trigger_values: decision.trigger_values ?? [],
        },
        last_revert_at: state.last_revert_at,
        transitions: log(decision.reason),
      };

    case "revert":
      return {
        breaches: [],
        tripped: null,
        last_revert_at: nowIso,
        transitions: log(decision.reason),
      };

    case "refuse_revert_manual_change":
      // Release the claim: we no longer own the level, so we must never try to
      // move it again. last_revert_at is NOT set — no revert happened, and
      // debouncing a trip on it would be wrong.
      return {
        breaches: [],
        tripped: null,
        last_revert_at: state.last_revert_at,
        transitions: log(decision.reason),
      };

    case "error":
    case "skip_already_escalated":
    case "skip_disabled":
    case "skip_no_scope":
    case "skip_debounced":
      // Keep the evidence: the condition may clear (scope added, switch turned
      // back on) and the breach hours are still valid until they age out.
      return { ...state, breaches, transitions: log(decision.reason) };

    default:
      return { ...state, breaches };
  }
}

// ── DB + Cloudflare wiring ────────────────────────────────────────────────────

const STATE_KEY = "cf_mitigation_loop";

export type MitigationRunResult = {
  decision: MitigationDecision;
  state: MitigationLoopState;
  /** The zone level the loop observed this tick, for the card and the email. */
  observed_level: SecurityLevel | null;
  /** True when a Cloudflare WRITE actually landed this tick. */
  acted: boolean;
  /** Set when the write itself failed after the decision said to act. */
  write_error: string | null;
  /** Latest complete hour, echoed so the email can quote the evidence. */
  latest_hour: CloudflareHourBucket | null;
  /** FIX-1047: current write-scope verdict (cached; may be from an earlier tick). */
  scope_probe: MitigationScopeProbe | null;
  /** The threshold actually in force this tick, after any env override. */
  threshold: number;
};

export type MitigationDeps = {
  getLevel: () => Promise<{ level: SecurityLevel } | { error: string }>;
  setLevel: (
    level: SecurityLevel,
  ) => Promise<{ level: SecurityLevel } | { error: string }>;
  /** FIX-1047. Idempotent no-op write used to confirm Zone Settings:Edit. */
  probeScope?: (
    currentLevel: SecurityLevel,
  ) => Promise<{ writable: true } | { writable: false; scope_missing: boolean; detail: string }>;
  now?: () => number;
};

export async function readMitigationState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
): Promise<MitigationLoopState> {
  try {
    const { data } = await db
      .from("pipeline_state")
      .select("value")
      .eq("key", STATE_KEY)
      .maybeSingle();
    const v = data?.value as Partial<MitigationLoopState> | null;
    if (!v) return emptyMitigationState();
    return {
      breaches: Array.isArray(v.breaches) ? v.breaches : [],
      tripped: v.tripped ?? null,
      last_revert_at: v.last_revert_at ?? null,
      transitions: Array.isArray(v.transitions) ? v.transitions : [],
      scope_probe: v.scope_probe ?? null,
    };
  } catch {
    return emptyMitigationState();
  }
}

async function writeMitigationState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  state: MitigationLoopState,
  nowIso: string,
): Promise<void> {
  try {
    await db
      .from("pipeline_state")
      .upsert({ key: STATE_KEY, value: state, updated_at: nowIso }, { onConflict: "key" });
  } catch {
    // Best-effort, like every other durable-signal write on this path. Losing
    // one state write costs a duplicate decision next tick, not a wrong one.
  }
}

/**
 * Run one tick of the loop.
 *
 * Ordering is deliberate and is the whole of rail 1: read the live level, decide
 * against THAT, write, and only then record. The state row is updated whether or
 * not the write succeeded, so the durable record always reflects reality — a
 * failed escalation must not leave a `tripped` record behind, or the loop would
 * later "revert" a level it never set.
 *
 * Never throws.
 */
export async function runCloudflareMitigationLoop(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  hours: CloudflareHourBucket[],
  opts: { writesEnabled: boolean; deps: MitigationDeps; threshold?: number },
): Promise<MitigationRunResult> {
  const now = opts.deps.now ?? Date.now;
  const nowMs = now();
  const nowIso = new Date(nowMs).toISOString();

  const prior = await readMitigationState(db);
  const threshold = opts.threshold ?? resolveTripThreshold();
  const breaches = foldBreaches(prior.breaches, hours, nowMs, threshold);

  const levelRes = await opts.deps.getLevel();
  const currentLevel = "error" in levelRes ? null : levelRes.level;
  const levelError = "error" in levelRes ? levelRes.error : null;

  // A read failure is indistinguishable from a scope failure here; treat the
  // scope as present and let the decision's fail-safe branch handle the null.
  let hasWriteScope = true;
  if (levelError && isScopeError(levelError)) hasWriteScope = false;

  // FIX-1047 — confirm the write scope BEFORE it is needed, not during a burn.
  //
  // Only when armed (a disarmed loop must not write at all, not even a no-op),
  // only when we have a level just read from this zone (the probe writes THAT
  // value back, so anything else would be a real mutation), and only when the
  // cached verdict has aged out. Cache hits keep the previous answer.
  let scopeProbe: MitigationScopeProbe | null = prior.scope_probe ?? null;
  if (
    opts.deps.probeScope &&
    opts.writesEnabled &&
    currentLevel !== null &&
    scopeProbeIsDue(scopeProbe, nowMs)
  ) {
    try {
      const p = await opts.deps.probeScope(currentLevel);
      scopeProbe = {
        writable: p.writable,
        scope_missing: p.writable ? false : p.scope_missing,
        detail: p.writable ? null : p.detail,
        checked_at: nowIso,
      };
    } catch (err) {
      // A thrown probe tells us nothing about the scope — keep the prior
      // verdict rather than inventing a pessimistic one that would suppress a
      // real mitigation.
      scopeProbe = prior.scope_probe ?? null;
      void err;
    }
  }
  // The probe is authoritative when it has an answer; a missing probe leaves the
  // getLevel-derived default in place, which is the pre-FIX-1047 behaviour.
  if (scopeProbe) hasWriteScope = scopeProbe.writable;

  let decision = decideMitigationAction({
    state: prior,
    breaches,
    currentLevel,
    nowMs,
    writesEnabled: opts.writesEnabled,
    hasWriteScope,
  });

  let acted = false;
  let writeError: string | null = null;

  if (decision.action === "trip" || decision.action === "revert") {
    const res = await opts.deps.setLevel(decision.target_level as SecurityLevel);
    if ("error" in res) {
      writeError = res.error;
      // Rail 5: an error means NO state change beyond the breach bookkeeping.
      // Re-classify so applyMitigationDecision cannot record a phantom trip.
      decision = {
        action: isScopeError(res.error) ? "skip_no_scope" : "error",
        reason: isScopeError(res.error)
          ? `Cloudflare refused the write — the token lacks Zone Settings:Edit ` +
            `(${res.error}). Alert only; nothing changed at the edge.`
          : `Cloudflare write failed (${res.error}) — no action taken, and no trip ` +
            `recorded. The loop stays alert-only until the API answers again.`,
        ...(decision.trigger_hours ? { trigger_hours: decision.trigger_hours } : {}),
        ...(decision.trigger_values ? { trigger_values: decision.trigger_values } : {}),
      };
    } else {
      acted = true;
    }
  }

  const applied = applyMitigationDecision(prior, breaches, decision, currentLevel, nowIso);
  // The probe verdict is orthogonal to the decision — it survives every
  // transition and is refreshed on its own schedule.
  const next: MitigationLoopState = { ...applied, scope_probe: scopeProbe };

  // Only write when something actually changed — a quiet tick is the common case
  // and must not cost a row update. Breach-set changes DO count as a change, and
  // so does a refreshed scope verdict (else a 12-hourly probe would be forgotten
  // and re-run every tick).
  const changed =
    JSON.stringify(next.breaches) !== JSON.stringify(prior.breaches) ||
    JSON.stringify(next.tripped) !== JSON.stringify(prior.tripped) ||
    next.last_revert_at !== prior.last_revert_at ||
    JSON.stringify(next.scope_probe ?? null) !== JSON.stringify(prior.scope_probe ?? null) ||
    decision.action !== "none";
  if (changed) await writeMitigationState(db, next, nowIso);

  return {
    decision,
    state: next,
    observed_level: currentLevel,
    acted,
    write_error: writeError,
    latest_hour: hours[0] ?? null,
    scope_probe: scopeProbe,
    threshold,
  };
}

/** Transitions the route should email on. Everything else is quiet bookkeeping. */
export function isEmailableMitigationAction(action: MitigationAction): boolean {
  return (
    action === "trip" ||
    action === "revert" ||
    action === "refuse_revert_manual_change" ||
    action === "skip_no_scope" ||
    action === "skip_disabled"
  );
}
