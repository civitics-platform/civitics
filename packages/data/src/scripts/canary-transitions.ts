/**
 * FIX-1036 — the canary pages on CHANGE, not on state.
 *
 * THE DEFECT. canary-check.ts built one flat `; `-joined subject out of whatever
 * detectors had fired, and sent it every time any of them fired. A condition
 * that stays true — a rollup four weeks stale, an autovacuum flag stranded off,
 * a pg_cron job that has stopped starting — produced a byte-identical email
 * every night forever. Nothing in the email said whether the situation was new,
 * getting worse, or exactly what it was yesterday, and nothing said when
 * something had CLEARED. An alert with no derivative is an alert that gets
 * filtered to a folder, which is how a detector quietly stops covering what it
 * enumerates (playbook E5, the same failure FIX-977 and FIX-977b fixed on the
 * registry side).
 *
 * THE SHAPE. Every detector finding becomes a `Condition` with a STABLE key.
 * The keys of one run are compared against the keys the previous run stored in
 * its own `canary_check` meta row, which makes each condition `new`,
 * `worsening`, `unchanged` or `recovered`. Email is sent on a transition; an
 * unchanged escalating condition rides along as one digest line rather than
 * generating its own nightly page.
 *
 * WHY `worsening` IS RELATIVE, NOT ABSOLUTE. Severity for a stale rollup is
 * hours-since-complete, which climbs ~24 every night on its own. A strict
 * `severity > previous` test would therefore call every stale rollup "worsening"
 * every single night and reproduce the nightly page it is meant to end. So
 * worsening means a MEANINGFUL move — the tier hardened from report to
 * escalate, or severity grew by at least WORSEN_FACTOR. 880h -> 904h is not
 * news; 30h -> 500h is.
 *
 * THE HARD FLOOR. Silence has its own failure mode: a condition that never
 * changes eventually stops being mentioned at all, and "no email" starts to
 * mean both "healthy" and "still broken, we gave up telling you". So an
 * escalating condition unchanged for STILL_RED_AFTER_RUNS consecutive runs
 * sends a reminder on its own. The GitHub red X (canary-check.ts's exit code)
 * is the second, always-on channel and is unaffected by any of this.
 *
 * Pure functions over plain data — no DB, no clock, no I/O — so the whole
 * decision table is unit-testable. See __tests__/canary-transitions.test.ts.
 */

/** `escalate` fails the workflow run; `report` is greppable only. */
export type ConditionTier = "escalate" | "report";

export interface Condition {
  /** Stable across runs. Identity of the finding, not its wording. */
  key: string;
  tier: ConditionTier;
  /** Human sentence for the email/console. May change without meaning change. */
  detail: string;
  /** Monotone: higher is worse. Compared only against the SAME key. */
  severity: number;
  /** Consecutive runs this condition has been present and unchanged. */
  unchangedRuns?: number;
}

export type TransitionKind = "new" | "worsening" | "unchanged" | "recovered";

export interface Transition {
  key: string;
  kind: TransitionKind;
  tier: ConditionTier;
  detail: string;
  severity: number;
  previousSeverity: number | null;
  unchangedRuns: number;
}

/**
 * An escalating condition unchanged for this many consecutive runs gets a
 * reminder anyway. 7 = a week of daily runs: long enough that a genuinely
 * known-and-accepted state is not nagging, short enough that nothing rots for
 * a month behind a silent detector.
 */
export const STILL_RED_AFTER_RUNS = 7;

/**
 * Severity must grow by at least this factor to count as `worsening`. See the
 * header: an absolute comparison makes every stale rollup "worse" every night.
 */
export const WORSEN_FACTOR = 1.5;

export type AlertTier = "ESCALATE" | "STILL RED" | "RECOVERED" | "REPORT";

export interface AlertDecision {
  send: boolean;
  tier: AlertTier | null;
  /** No previous meta row was found: every condition reads as `new` once. */
  firstRun: boolean;
}

/**
 * Compare this run's conditions against the previous run's.
 *
 * `previous === null` means no prior verdict exists (the first run after this
 * ships, or a gap long enough that the previous row is unreadable). Everything
 * then reads as `new` exactly once, which the email says out loud rather than
 * implying a platform-wide overnight collapse.
 */
export function classifyTransitions(
  current: Condition[],
  previous: Condition[] | null,
): Transition[] {
  const prevByKey = new Map<string, Condition>();
  for (const c of previous ?? []) prevByKey.set(c.key, c);

  const out: Transition[] = [];

  for (const cur of current) {
    const prev = prevByKey.get(cur.key);
    if (!prev) {
      out.push({
        key: cur.key, kind: "new", tier: cur.tier, detail: cur.detail,
        severity: cur.severity, previousSeverity: null, unchangedRuns: 0,
      });
      continue;
    }
    // A finding that hardened from report-only to escalating is worsening
    // regardless of its number: the tier IS the judgement.
    const tierHardened = prev.tier === "report" && cur.tier === "escalate";
    const grew =
      prev.severity > 0
        ? cur.severity >= prev.severity * WORSEN_FACTOR
        : cur.severity > prev.severity;
    if (tierHardened || grew) {
      out.push({
        key: cur.key, kind: "worsening", tier: cur.tier, detail: cur.detail,
        severity: cur.severity, previousSeverity: prev.severity, unchangedRuns: 0,
      });
      continue;
    }
    out.push({
      key: cur.key, kind: "unchanged", tier: cur.tier, detail: cur.detail,
      severity: cur.severity, previousSeverity: prev.severity,
      unchangedRuns: (prev.unchangedRuns ?? 0) + 1,
    });
  }

  const curKeys = new Set(current.map((c) => c.key));
  for (const prev of prevByKey.values()) {
    if (curKeys.has(prev.key)) continue;
    out.push({
      key: prev.key, kind: "recovered", tier: prev.tier,
      // The recovered line describes what STOPPED, so it keeps the old wording.
      detail: prev.detail, severity: 0, previousSeverity: prev.severity,
      unchangedRuns: 0,
    });
  }

  return out;
}

/** Carry `unchangedRuns` forward onto the conditions that get persisted. */
export function withUnchangedRuns(
  current: Condition[],
  transitions: Transition[],
): Condition[] {
  const runs = new Map(transitions.map((t) => [t.key, t.unchangedRuns]));
  return current.map((c) => ({ ...c, unchangedRuns: runs.get(c.key) ?? 0 }));
}

/**
 * Decide whether to send, and under which subject tier.
 *
 * Precedence, most severe first:
 *   ESCALATE   an escalating condition is new or got meaningfully worse
 *   STILL RED  nothing new escalated, but something escalating has been
 *              unchanged for a week — or something cleared while escalating
 *              conditions remain (still red, and here is what cleared)
 *   RECOVERED  something cleared and nothing escalates any more
 *   REPORT     report-only conditions moved; nothing escalates
 */
export function decideAlert(
  current: Condition[],
  transitions: Transition[],
  firstRun: boolean,
): AlertDecision {
  const moved = (t: Transition) => t.kind === "new" || t.kind === "worsening";

  const escalateMoved = transitions.some((t) => t.tier === "escalate" && moved(t));
  const reportMoved   = transitions.some((t) => t.tier === "report"   && moved(t));
  const recovered     = transitions.some((t) => t.kind === "recovered");
  const stillRed      = transitions.some(
    (t) => t.tier === "escalate" && t.kind === "unchanged" && t.unchangedRuns >= STILL_RED_AFTER_RUNS,
  );
  const anyEscalating = current.some((c) => c.tier === "escalate");

  let tier: AlertTier | null = null;
  if (escalateMoved) tier = "ESCALATE";
  else if (stillRed) tier = "STILL RED";
  else if (recovered) tier = anyEscalating ? "STILL RED" : "RECOVERED";
  else if (reportMoved) tier = "REPORT";

  return { send: tier !== null, tier, firstRun };
}

/** One line per transition, most severe first, for the top of the email. */
export function describeTransitions(transitions: Transition[]): string[] {
  const rank: Record<TransitionKind, number> = {
    worsening: 0, new: 1, recovered: 2, unchanged: 3,
  };
  const tierRank = (t: ConditionTier) => (t === "escalate" ? 0 : 1);
  return [...transitions]
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier) || rank[a.kind] - rank[b.kind] || a.key.localeCompare(b.key))
    .map((t) => {
      const mark =
        t.kind === "new"       ? "NEW"
        : t.kind === "worsening" ? "WORSE"
        : t.kind === "recovered" ? "CLEARED"
        : `SAME x${t.unchangedRuns}`;
      const tierMark = t.tier === "escalate" ? "escalating" : "report-only";
      const delta =
        t.kind === "worsening" && t.previousSeverity !== null
          ? ` (was ${t.previousSeverity})`
          : "";
      return `  [${mark}] (${tierMark}) ${t.detail}${delta}`;
    });
}
