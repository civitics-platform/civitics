/**
 * FIX-1194 P2-A — the cron-watchdog route's decision logic.
 *
 * WHY THIS MODULE IS PURE, AND WHY IT IS HERE RATHER THAN IN THE ROUTE. The
 * same reason as `front-door-verdict.ts` (FIX-1130): the route does the one I/O
 * call, this module does every decision, and the decisions become replayable
 * fixtures instead of prose. There is a second reason specific to this one —
 * the shapes it parses come back from a Postgres function whose own sub-results
 * are jsonb built by three DIFFERENT migrations (FIX-1063's budget loop,
 * FIX-1101's ec_window arm, FIX-1030/1035's unit watchdog). Nothing type-checks
 * that boundary, so it is parsed defensively here, once, and the unhappy shapes
 * are the tests.
 *
 * ── WHAT `run_cron_watchdogs()` RETURNS ─────────────────────────────────────
 *
 *   {
 *     via:      "vercel",
 *     budget:   { checked, canceled, actions: [...], ec_window: {...} }
 *                 | { error, sqlstate }          <- inner call threw
 *     unit:     { action: "none" | "canceled" | "closed_dead_backend", ... }
 *                 | { action: "error", reason, sqlstate }
 *     labelled: <rows re-stamped acted_via='vercel' by THIS call>,
 *     at:       <timestamptz>
 *   }
 *
 * The wrapper runs each inner watchdog inside its own handler, so ONE of the
 * two failing still returns a well-formed payload with the other's real result
 * in it. That is the property this module must not throw away: a verdict that
 * collapsed "budget threw" and "both threw" into one `ok: false` would make the
 * route's log line useless in exactly the incident it exists for.
 *
 * ── WHY `ok` IS ABOUT THE CALL, NOT ABOUT WHETHER ANYTHING WAS CANCELLED ────
 *
 * `canceled: 0` is the overwhelmingly common — and CORRECT — answer: 720 calls
 * a day, almost all of them finding nothing over budget. It is a healthy
 * no-op, not a failure, and it is not logged as one. `ok` is false only when an
 * inner watchdog actually threw, or the payload did not parse. Getting this
 * backwards would turn the route into a 720/day alarm siren whose signal
 * nobody reads.
 */

/** The three ways the unit watchdog can answer, plus the wrapper's error case. */
export type UnitAction = "none" | "canceled" | "closed_dead_backend" | "error" | "unknown";

export type CronWatchdogVerdict = {
  /** False only if an inner watchdog threw, or the payload did not parse. */
  ok: boolean;
  /** Budgeted jobs the budget watchdog looked at; null if it threw. */
  checked: number | null;
  /** Backends it cancelled this call. */
  canceled: number;
  /** The unit watchdog's verdict word. */
  unitAction: UnitAction;
  /** Ledger rows this call re-stamped acted_via='vercel'. */
  labelled: number;
  /** Job names cancelled this call, for the log line. */
  cancelledJobs: string[];
  /** One entry per inner failure, already prefixed with which arm failed. */
  errors: string[];
  /** The single line the route logs. */
  line: string;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function asText(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

const UNIT_ACTIONS: readonly string[] = ["none", "canceled", "closed_dead_backend", "error"];

/**
 * Parse the RPC's jsonb into the verdict the route logs and returns.
 *
 * Never throws. A payload that is null, a scalar, or missing both arms yields
 * `ok: false` with the reason in `errors` — because a route that threw while
 * parsing its watchdog's answer would be the FIX-1130 failure in a new costume.
 */
export function decideCronWatchdogVerdict(raw: unknown): CronWatchdogVerdict {
  const errors: string[] = [];
  const root = asRecord(raw);

  if (root === null) {
    return {
      ok: false,
      checked: null,
      canceled: 0,
      unitAction: "unknown",
      labelled: 0,
      cancelledJobs: [],
      errors: ["payload: not an object (" + (raw === null ? "null" : typeof raw) + ")"],
      line: "[cron/cron-watchdog] UNPARSEABLE payload",
    };
  }

  // ── the budget arm ────────────────────────────────────────────────────────
  const budget = asRecord(root["budget"]);
  let checked: number | null = null;
  let canceled = 0;
  const cancelledJobs: string[] = [];

  if (budget === null) {
    errors.push("budget: arm missing from payload");
  } else if (asText(budget["error"]) !== null) {
    errors.push(
      "budget: " + asText(budget["error"]) + " [" + (asText(budget["sqlstate"]) ?? "no sqlstate") + "]",
    );
  } else {
    checked = asInt(budget["checked"]);
    canceled = asInt(budget["canceled"]) ?? 0;
    const actions = budget["actions"];
    if (Array.isArray(actions)) {
      for (const a of actions) {
        const rec = asRecord(a);
        const name = rec === null ? null : asText(rec["jobname"]);
        if (name !== null) cancelledJobs.push(name);
      }
    }
    // FIX-1101's ec_window arm rides inside the budget payload and reports its
    // own failures as action:'error' rather than throwing. Surface it too —
    // rule 22: a failed unit surfaces, it does not hide its sibling.
    const ecWindow = asRecord(budget["ec_window"]);
    if (ecWindow !== null && asText(ecWindow["action"]) === "error") {
      errors.push("ec_window: " + (asText(ecWindow["reason"]) ?? "(no reason given)"));
    }
  }

  // ── the unit arm ──────────────────────────────────────────────────────────
  const unit = asRecord(root["unit"]);
  let unitAction: UnitAction = "unknown";

  if (unit === null) {
    errors.push("unit: arm missing from payload");
  } else {
    const action = asText(unit["action"]);
    unitAction = action !== null && UNIT_ACTIONS.includes(action) ? (action as UnitAction) : "unknown";
    if (unitAction === "error") {
      errors.push(
        "unit: " + (asText(unit["reason"]) ?? "(no reason given)") +
          " [" + (asText(unit["sqlstate"]) ?? "no sqlstate") + "]",
      );
    } else if (unitAction === "unknown") {
      errors.push("unit: unrecognised action " + JSON.stringify(unit["action"]));
    }
  }

  const labelled = asInt(root["labelled"]) ?? 0;
  const ok = errors.length === 0;

  const parts = [
    "[cron/cron-watchdog]",
    "budget checked=" + (checked === null ? "?" : checked),
    "canceled=" + canceled,
    "unit=" + unitAction,
    "via=" + (asText(root["via"]) ?? "?"),
    // FIX-1208 — the DB's own clock, in the Vercel log line. The payload has
    // carried `at` since FIX-1194; printing it is what lets the two
    // instruments be compared without a query, and it is the value Craig reads
    // off the Vercel log if the pipeline_state stamp is ever missing.
    "at=" + (asText(root["at"]) ?? "?"),
  ];
  if (cancelledJobs.length > 0) parts.push("jobs=" + cancelledJobs.join(","));
  if (labelled > 0) parts.push("labelled=" + labelled);
  if (!ok) parts.push("ERRORS: " + errors.join("; "));

  return { ok, checked, canceled, unitAction, labelled, cancelledJobs, errors, line: parts.join(" ") };
}
