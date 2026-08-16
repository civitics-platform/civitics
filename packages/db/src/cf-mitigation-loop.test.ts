/**
 * FIX-1045 — the mitigation loop's state machine.
 *
 * This is the most heavily tested thing in the package on purpose: it WRITES
 * PRODUCTION EDGE CONFIGURATION. A bug here does not produce a wrong number on a
 * dashboard, it either takes the site's security posture down without anyone
 * asking or fights a human's manual setting in a loop. Every safety rail in
 * cf-mitigation-loop.ts's header has at least one test below that fails if the
 * rail is removed.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  decideMitigationAction,
  applyMitigationDecision,
  foldBreaches,
  emptyMitigationState,
  runCloudflareMitigationLoop,
  TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR,
  REQUIRED_BREACH_HOURS,
  REVERT_AFTER_HOURS,
  MIN_HOURS_BETWEEN_TRIPS,
  BREACH_WINDOW_HOURS,
  PROBE_SCOPE_INTERVAL_HOURS,
  resolveTripThreshold,
  scopeProbeIsDue,
  TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR as TRIP_DEFAULT,
  type MitigationLoopState,
  type MitigationBreach,
} from "./cf-mitigation-loop";
import type { CloudflareHourBucket, SecurityLevel } from "./cloudflare-analytics";

const HOUR = 3_600_000;
const T0 = Date.parse("2026-08-16T12:00:00Z");

function hour(offsetHours: number, origin: number): CloudflareHourBucket {
  const edge = Math.max(origin, 100);
  return {
    hour: new Date(T0 + offsetHours * HOUR).toISOString(),
    edge_requests: edge,
    origin_requests: origin,
    absorbed_requests: edge - origin,
    mitigated_pct: ((edge - origin) / edge) * 100,
  };
}

function breach(offsetHours: number, origin = 7200): MitigationBreach {
  return { hour: new Date(T0 + offsetHours * HOUR).toISOString(), origin_requests: origin };
}

function stateWith(over: Partial<MitigationLoopState>): MitigationLoopState {
  return { ...emptyMitigationState(), ...over };
}

const BASE = {
  currentLevel: "medium" as SecurityLevel,
  nowMs: T0,
  writesEnabled: true,
  hasWriteScope: true,
};

// ── foldBreaches ──────────────────────────────────────────────────────────────

describe("foldBreaches", () => {
  test("records only hours at or above the threshold", () => {
    const out = foldBreaches(
      [],
      [hour(-1, TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR), hour(-2, TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR - 1)],
      T0,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0]!.origin_requests, TRIP_THRESHOLD_ORIGIN_REQ_PER_HOUR);
  });

  test("dedupes by hour — re-reading the same bucket cannot manufacture evidence", () => {
    // THE load-bearing case. The cron re-reads a 3-hour window every tick at a
    // measured p50 46-minute cadence, so it sees the same bucket repeatedly. If
    // this deduped by anything other than the bucket timestamp, a single bad
    // hour would satisfy the 2-hour requirement on its own.
    let breaches = foldBreaches([], [hour(-1, 7200)], T0);
    breaches = foldBreaches(breaches, [hour(-1, 7200)], T0);
    breaches = foldBreaches(breaches, [hour(-1, 7200)], T0);
    assert.equal(breaches.length, 1);
  });

  test("two distinct hours accumulate", () => {
    let breaches = foldBreaches([], [hour(-1, 7200)], T0);
    breaches = foldBreaches(breaches, [hour(-2, 7100)], T0);
    assert.equal(breaches.length, 2);
  });

  test("drops evidence older than the breach window", () => {
    const stale = breach(-(BREACH_WINDOW_HOURS + 1));
    const fresh = breach(-1);
    const out = foldBreaches([stale, fresh], [], T0);
    assert.deepEqual(
      out.map((b) => b.hour),
      [fresh.hour],
    );
  });

  test("discards an unparseable hour rather than keeping it forever", () => {
    const out = foldBreaches([{ hour: "not-a-date", origin_requests: 9999 }], [], T0);
    assert.equal(out.length, 0);
  });

  test("re-validates PRIOR evidence against the CURRENT threshold", () => {
    // Found by the FIX-1047 prod verify run. Lowering the threshold to 10
    // recorded three ordinary hours (41/43/69 req) as breaches; raising it back
    // to 3,000 left them in the state row for the full 6h window, still counting
    // toward a trip. Stale sub-threshold evidence must not be able to drive a
    // real escalation once the bar is back where it belongs.
    const stale = [breach(-1, 41), breach(-2, 43), breach(-3, 69)];
    assert.equal(foldBreaches(stale, [], T0, 10).length, 3, "valid at the low bar");
    assert.equal(foldBreaches(stale, [], T0, 3000).length, 0, "dropped at the real bar");
  });

  test("prior evidence that still clears the current threshold survives", () => {
    const real = [breach(-1, 7200), breach(-2, 7100)];
    assert.equal(foldBreaches(real, [], T0, 3000).length, 2);
  });
});

// ── FIX-1047 helpers ──────────────────────────────────────────────────────────

describe("resolveTripThreshold", () => {
  const KEY = "CF_TRIP_ORIGIN_REQ_THRESHOLD";
  const restore = (v: string | undefined): void => {
    if (v === undefined) delete process.env[KEY];
    else process.env[KEY] = v;
  };

  test("defaults to the derived constant", () => {
    const prev = process.env[KEY];
    delete process.env[KEY];
    assert.equal(resolveTripThreshold(), TRIP_DEFAULT);
    restore(prev);
  });

  test("honours a valid override for a verify run", () => {
    const prev = process.env[KEY];
    process.env[KEY] = "50";
    assert.equal(resolveTripThreshold(), 50);
    restore(prev);
  });

  test("IGNORES a typo'd or non-positive override rather than obeying it", () => {
    // A threshold of 0 would trip the loop on every quiet hour — an env typo
    // must not be able to point production edge config at itself.
    const prev = process.env[KEY];
    for (const bad of ["0", "-1", "abc", ""]) {
      process.env[KEY] = bad;
      assert.equal(resolveTripThreshold(), TRIP_DEFAULT, `input ${JSON.stringify(bad)}`);
    }
    restore(prev);
  });
});

describe("scopeProbeIsDue", () => {
  test("due when never probed", () => {
    assert.equal(scopeProbeIsDue(null, T0), true);
    assert.equal(scopeProbeIsDue(undefined, T0), true);
  });

  test("not due inside the interval", () => {
    const p = {
      writable: true,
      scope_missing: false,
      detail: null,
      checked_at: new Date(T0 - 1 * HOUR).toISOString(),
    };
    assert.equal(scopeProbeIsDue(p, T0), false);
  });

  test("due once the interval elapses", () => {
    const p = {
      writable: true,
      scope_missing: false,
      detail: null,
      checked_at: new Date(T0 - PROBE_SCOPE_INTERVAL_HOURS * HOUR).toISOString(),
    };
    assert.equal(scopeProbeIsDue(p, T0), true);
  });

  test("due when the stored timestamp is unparseable", () => {
    const p = { writable: true, scope_missing: false, detail: null, checked_at: "garbage" };
    assert.equal(scopeProbeIsDue(p, T0), true);
  });
});

// ── Trip conditions ───────────────────────────────────────────────────────────

describe("trip", () => {
  test("trips on a sustained breach across the required distinct hours", () => {
    const d = decideMitigationAction({
      ...BASE,
      state: emptyMitigationState(),
      breaches: [breach(-1), breach(-2)],
    });
    assert.equal(d.action, "trip");
    assert.equal(d.target_level, "under_attack");
    assert.equal(d.trigger_hours?.length, REQUIRED_BREACH_HOURS);
  });

  test("does NOT trip on a single breached hour", () => {
    const d = decideMitigationAction({
      ...BASE,
      state: emptyMitigationState(),
      breaches: [breach(-1)],
    });
    assert.equal(d.action, "none");
    assert.match(d.reason, /1 of 2 required breach hours/);
  });

  test("does not trip with no breaches at all", () => {
    const d = decideMitigationAction({ ...BASE, state: emptyMitigationState(), breaches: [] });
    assert.equal(d.action, "none");
  });

  test("ESCALATE-ONLY: refuses to claim a level it did not set", () => {
    // The zone is already at under_attack because a human put it there. Tripping
    // would record `previous_level` and later auto-revert somebody else's
    // decision. It must record nothing.
    const d = decideMitigationAction({
      ...BASE,
      currentLevel: "under_attack",
      state: emptyMitigationState(),
      breaches: [breach(-1), breach(-2)],
    });
    assert.equal(d.action, "skip_already_escalated");
    assert.equal(d.target_level, undefined);

    const next = applyMitigationDecision(
      emptyMitigationState(),
      [breach(-1), breach(-2)],
      d,
      "under_attack",
      new Date(T0).toISOString(),
    );
    assert.equal(next.tripped, null, "must not record a trip it did not perform");
  });

  test("kill switch off ⇒ detect and alert, never write", () => {
    const d = decideMitigationAction({
      ...BASE,
      writesEnabled: false,
      state: emptyMitigationState(),
      breaches: [breach(-1), breach(-2)],
    });
    assert.equal(d.action, "skip_disabled");
    assert.equal(d.trigger_hours?.length, REQUIRED_BREACH_HOURS, "evidence still reported");
  });

  test("missing Zone Settings:Edit ⇒ alert-only degradation", () => {
    const d = decideMitigationAction({
      ...BASE,
      hasWriteScope: false,
      state: emptyMitigationState(),
      breaches: [breach(-1), breach(-2)],
    });
    assert.equal(d.action, "skip_no_scope");
    assert.match(d.reason, /Zone Settings:Edit/);
  });

  test("a skip keeps the breach evidence so it can act when re-armed", () => {
    const breaches = [breach(-1), breach(-2)];
    const d = decideMitigationAction({
      ...BASE,
      writesEnabled: false,
      state: emptyMitigationState(),
      breaches,
    });
    const next = applyMitigationDecision(
      emptyMitigationState(),
      breaches,
      d,
      "medium",
      new Date(T0).toISOString(),
    );
    assert.equal(next.breaches.length, 2);
  });
});

// ── Revert conditions ─────────────────────────────────────────────────────────

const trippedState = (over: Partial<MitigationLoopState> = {}): MitigationLoopState =>
  stateWith({
    tripped: {
      tripped_by: "auto",
      tripped_at: new Date(T0 - REVERT_AFTER_HOURS * HOUR).toISOString(),
      previous_level: "medium",
      set_level: "under_attack",
      trigger_hours: [breach(-8).hour, breach(-9).hour],
      trigger_values: [7200, 7100],
    },
    ...over,
  });

describe("revert", () => {
  test("reverts to the recorded previous level once the window elapses", () => {
    const d = decideMitigationAction({
      ...BASE,
      currentLevel: "under_attack",
      state: trippedState(),
      breaches: [],
    });
    assert.equal(d.action, "revert");
    assert.equal(d.target_level, "medium");
  });

  test("holds while the window has not elapsed", () => {
    const d = decideMitigationAction({
      ...BASE,
      currentLevel: "under_attack",
      state: stateWith({
        tripped: {
          tripped_by: "auto",
          tripped_at: new Date(T0 - 1 * HOUR).toISOString(),
          previous_level: "medium",
          set_level: "under_attack",
          trigger_hours: [],
          trigger_values: [],
        },
      }),
      breaches: [],
    });
    assert.equal(d.action, "none");
    assert.match(d.reason, /auto-revert due at/);
  });

  test("REFUSES to revert when the level is no longer the one it set", () => {
    // Craig changed it by hand. The loop must not fight a manual setting.
    const d = decideMitigationAction({
      ...BASE,
      currentLevel: "high",
      state: trippedState(),
      breaches: [],
    });
    assert.equal(d.action, "refuse_revert_manual_change");
    assert.equal(d.target_level, undefined, "must not propose any write");
    assert.match(d.reason, /changed it manually/);
  });

  test("refusing releases the claim so it never tries again", () => {
    const d = decideMitigationAction({
      ...BASE,
      currentLevel: "high",
      state: trippedState(),
      breaches: [],
    });
    const next = applyMitigationDecision(
      trippedState(),
      [],
      d,
      "high",
      new Date(T0).toISOString(),
    );
    assert.equal(next.tripped, null);
    assert.equal(next.last_revert_at, null, "no revert happened, so nothing to debounce on");
  });

  test("revert is evaluated before trip — an expiring escalation always gets to come down", () => {
    const d = decideMitigationAction({
      ...BASE,
      currentLevel: "under_attack",
      state: trippedState(),
      breaches: [breach(-1), breach(-2)], // burn still running
    });
    assert.equal(d.action, "revert");
  });
});

// ── Debounce ──────────────────────────────────────────────────────────────────

describe("debounce", () => {
  test("cannot re-trip inside the anti-flap window", () => {
    const d = decideMitigationAction({
      ...BASE,
      state: stateWith({
        last_revert_at: new Date(T0 - (MIN_HOURS_BETWEEN_TRIPS - 1) * HOUR).toISOString(),
      }),
      breaches: [breach(-1), breach(-2)],
    });
    assert.equal(d.action, "skip_debounced");
  });

  test("re-trips once the anti-flap window has passed", () => {
    const d = decideMitigationAction({
      ...BASE,
      state: stateWith({
        last_revert_at: new Date(T0 - (MIN_HOURS_BETWEEN_TRIPS + 1) * HOUR).toISOString(),
      }),
      breaches: [breach(-1), breach(-2)],
    });
    assert.equal(d.action, "trip");
  });

  test("a trip consumes its evidence so one bad hour cannot serve two decisions", () => {
    const breaches = [breach(-1), breach(-2)];
    const d = decideMitigationAction({ ...BASE, state: emptyMitigationState(), breaches });
    const next = applyMitigationDecision(
      emptyMitigationState(),
      breaches,
      d,
      "medium",
      new Date(T0).toISOString(),
    );
    assert.deepEqual(next.breaches, []);
  });
});

// ── Fail-safe ─────────────────────────────────────────────────────────────────

describe("fail-safe", () => {
  test("an unreadable security level produces no action", () => {
    const d = decideMitigationAction({
      ...BASE,
      currentLevel: null,
      state: emptyMitigationState(),
      breaches: [breach(-1), breach(-2)],
    });
    assert.equal(d.action, "error");
    assert.equal(d.target_level, undefined);
  });

  test("a corrupt tripped_at does not strand the loop in a write", () => {
    const d = decideMitigationAction({
      ...BASE,
      currentLevel: "under_attack",
      state: stateWith({
        tripped: {
          tripped_by: "auto",
          tripped_at: "garbage",
          previous_level: "medium",
          set_level: "under_attack",
          trigger_hours: [],
          trigger_values: [],
        },
      }),
      breaches: [],
    });
    assert.equal(d.action, "error");
  });
});

// ── End-to-end through runCloudflareMitigationLoop ────────────────────────────

/** Minimal in-memory stand-in for the pipeline_state row. */
function fakeDb(initial: MitigationLoopState | null = null) {
  const store: { value: MitigationLoopState | null } = { value: initial };
  const db = {
    from() {
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: store.value ? { value: store.value } : null }),
              };
            },
          };
        },
        upsert: async (row: { value: MitigationLoopState }) => {
          store.value = row.value;
          return { error: null };
        },
      };
    },
  };
  return { db, store };
}

describe("runCloudflareMitigationLoop", () => {
  test("a Cloudflare write failure records NO trip — the loop degrades to alert-only", async () => {
    // The critical invariant: if the PATCH fails we must not persist a trip
    // record, or the next run would "revert" a level that was never set —
    // LOWERING the zone's security on the strength of a failed write.
    const { db, store } = fakeDb();
    const res = await runCloudflareMitigationLoop(
      db,
      [hour(-1, 7200), hour(-2, 7100)],
      {
        writesEnabled: true,
        deps: {
          getLevel: async () => ({ level: "medium" as SecurityLevel }),
          setLevel: async () => ({ error: "HTTP 500: upstream exploded" }),
          now: () => T0,
        },
      },
    );
    assert.equal(res.acted, false);
    assert.equal(res.decision.action, "error");
    assert.match(res.write_error ?? "", /upstream exploded/);
    assert.equal(res.state.tripped, null);
    assert.equal(store.value?.tripped, null);
  });

  test("a 9109 scope refusal is classified as scope_missing, not a transient error", async () => {
    const { db } = fakeDb();
    const res = await runCloudflareMitigationLoop(db, [hour(-1, 7200), hour(-2, 7100)], {
      writesEnabled: true,
      deps: {
        getLevel: async () => ({ level: "medium" as SecurityLevel }),
        setLevel: async () => ({
          error: "HTTP 403: 9109 Unauthorized to access requested resource",
        }),
        now: () => T0,
      },
    });
    assert.equal(res.decision.action, "skip_no_scope");
    assert.equal(res.state.tripped, null);
    assert.match(res.decision.reason, /Zone Settings:Edit/);
  });

  test("a successful trip persists the previous level for the eventual revert", async () => {
    const { db, store } = fakeDb();
    let written: SecurityLevel | null = null;
    const res = await runCloudflareMitigationLoop(db, [hour(-1, 7200), hour(-2, 7100)], {
      writesEnabled: true,
      deps: {
        getLevel: async () => ({ level: "medium" as SecurityLevel }),
        setLevel: async (l) => {
          written = l;
          return { level: l };
        },
        now: () => T0,
      },
    });
    assert.equal(res.acted, true);
    assert.equal(written, "under_attack");
    assert.equal(store.value?.tripped?.previous_level, "medium");
    assert.equal(store.value?.tripped?.set_level, "under_attack");
  });

  test("a quiet tick writes nothing at all", async () => {
    const { db, store } = fakeDb();
    let upserts = 0;
    const spyDb = {
      from() {
        return {
          select() {
            return {
              eq() {
                return { maybeSingle: async () => ({ data: null }) };
              },
            };
          },
          upsert: async () => {
            upserts += 1;
            return { error: null };
          },
        };
      },
    };
    void db;
    void store;
    const res = await runCloudflareMitigationLoop(spyDb, [hour(-1, 50)], {
      writesEnabled: true,
      deps: {
        getLevel: async () => ({ level: "medium" as SecurityLevel }),
        setLevel: async () => ({ error: "should never be called" }),
        now: () => T0,
      },
    });
    assert.equal(res.decision.action, "none");
    assert.equal(upserts, 0, "an idle tick must not cost a row update");
  });

  test("never throws when the DB read blows up", async () => {
    const explodingDb = {
      from() {
        throw new Error("connection reset");
      },
    };
    const res = await runCloudflareMitigationLoop(explodingDb, [hour(-1, 7200)], {
      writesEnabled: true,
      deps: {
        getLevel: async () => ({ level: "medium" as SecurityLevel }),
        setLevel: async () => ({ error: "unreachable" }),
        now: () => T0,
      },
    });
    assert.equal(res.acted, false);
  });

  test("full lifecycle: trip → hold → revert → debounced → re-trip", async () => {
    const { db, store } = fakeDb();
    const level = { current: "medium" as SecurityLevel };
    const deps = (nowMs: number) => ({
      getLevel: async () => ({ level: level.current }),
      setLevel: async (l: SecurityLevel) => {
        level.current = l;
        return { level: l };
      },
      now: () => nowMs,
    });
    const busy = (t: number) => [hour(t - 1, 7200), hour(t - 2, 7100)];

    // 1. Trip.
    let r = await runCloudflareMitigationLoop(db, busy(0), {
      writesEnabled: true,
      deps: deps(T0),
    });
    assert.equal(r.decision.action, "trip");
    assert.equal(level.current, "under_attack");

    // 2. Hold — an hour later, still inside the window.
    r = await runCloudflareMitigationLoop(db, busy(1), {
      writesEnabled: true,
      deps: deps(T0 + 1 * HOUR),
    });
    assert.equal(r.decision.action, "none");
    assert.equal(level.current, "under_attack");

    // 3. Revert at the window boundary.
    r = await runCloudflareMitigationLoop(db, [], {
      writesEnabled: true,
      deps: deps(T0 + REVERT_AFTER_HOURS * HOUR),
    });
    assert.equal(r.decision.action, "revert");
    assert.equal(level.current, "medium");

    // 4. Immediately busy again — debounced, not flapped.
    r = await runCloudflareMitigationLoop(db, busy(REVERT_AFTER_HOURS + 1), {
      writesEnabled: true,
      deps: deps(T0 + (REVERT_AFTER_HOURS + 0.5) * HOUR),
    });
    assert.equal(r.decision.action, "skip_debounced");
    assert.equal(level.current, "medium");

    // 5. Past the anti-flap window with fresh evidence — re-trips.
    const t5 = REVERT_AFTER_HOURS + MIN_HOURS_BETWEEN_TRIPS + 1;
    r = await runCloudflareMitigationLoop(db, busy(t5), {
      writesEnabled: true,
      deps: deps(T0 + t5 * HOUR),
    });
    assert.equal(r.decision.action, "trip");
    assert.equal(level.current, "under_attack");
    assert.equal(store.value?.tripped?.previous_level, "medium");
  });

  test("FIX-1047: probes the write scope BEFORE an incident and records the verdict", async () => {
    const { db, store } = fakeDb();
    let probedWith: SecurityLevel | null = null;
    const res = await runCloudflareMitigationLoop(db, [hour(-1, 50)], {
      writesEnabled: true,
      deps: {
        getLevel: async () => ({ level: "medium" as SecurityLevel }),
        setLevel: async () => ({ error: "should not be called on a quiet tick" }),
        probeScope: async (lvl) => {
          probedWith = lvl;
          return { writable: true };
        },
        now: () => T0,
      },
    });
    assert.equal(res.decision.action, "none", "no breach — the probe is not a trip");
    assert.equal(probedWith, "medium", "must probe with the level just READ from the zone");
    assert.equal(res.scope_probe?.writable, true);
    assert.equal(store.value?.scope_probe?.writable, true, "verdict persisted");
  });

  test("FIX-1047: a read-only token is caught before it is needed", async () => {
    const { db } = fakeDb();
    const res = await runCloudflareMitigationLoop(db, [hour(-1, 50)], {
      writesEnabled: true,
      deps: {
        getLevel: async () => ({ level: "medium" as SecurityLevel }),
        setLevel: async () => ({ error: "unused" }),
        probeScope: async () => ({
          writable: false,
          scope_missing: true,
          detail: "HTTP 403: 9109 Unauthorized to access requested resource",
        }),
        now: () => T0,
      },
    });
    assert.equal(res.scope_probe?.writable, false);
    assert.equal(res.scope_probe?.scope_missing, true);
  });

  test("FIX-1047: a failed probe demotes a would-be trip to skip_no_scope", async () => {
    const { db, store } = fakeDb();
    let wrote = false;
    const res = await runCloudflareMitigationLoop(db, [hour(-1, 7200), hour(-2, 7100)], {
      writesEnabled: true,
      deps: {
        getLevel: async () => ({ level: "medium" as SecurityLevel }),
        setLevel: async () => {
          wrote = true;
          return { level: "under_attack" as SecurityLevel };
        },
        probeScope: async () => ({ writable: false, scope_missing: true, detail: "9109" }),
        now: () => T0,
      },
    });
    assert.equal(res.decision.action, "skip_no_scope");
    assert.equal(wrote, false, "must not attempt the real write once scope is known bad");
    assert.equal(store.value?.tripped, null);
  });

  test("FIX-1047: the probe is NOT re-run inside the cache interval", async () => {
    // An idempotent PATCH still writes a Cloudflare audit-log entry, and the
    // audit log is how a human tells an automatic change from a manual one.
    // Probing every tick would bury real changes in ~40 no-op entries a day.
    let probes = 0;
    const fresh = {
      writable: true,
      scope_missing: false,
      detail: null,
      checked_at: new Date(T0 - 1 * HOUR).toISOString(),
    };
    const { db } = fakeDb(stateWith({ scope_probe: fresh }));
    await runCloudflareMitigationLoop(db, [hour(-1, 50)], {
      writesEnabled: true,
      deps: {
        getLevel: async () => ({ level: "medium" as SecurityLevel }),
        setLevel: async () => ({ error: "unused" }),
        probeScope: async () => {
          probes += 1;
          return { writable: true };
        },
        now: () => T0,
      },
    });
    assert.equal(probes, 0, "cached verdict is still fresh");
  });

  test("FIX-1047: the probe IS re-run once the cache ages out", async () => {
    let probes = 0;
    const stale = {
      writable: true,
      scope_missing: false,
      detail: null,
      checked_at: new Date(T0 - (PROBE_SCOPE_INTERVAL_HOURS + 1) * HOUR).toISOString(),
    };
    const { db } = fakeDb(stateWith({ scope_probe: stale }));
    await runCloudflareMitigationLoop(db, [hour(-1, 50)], {
      writesEnabled: true,
      deps: {
        getLevel: async () => ({ level: "medium" as SecurityLevel }),
        setLevel: async () => ({ error: "unused" }),
        probeScope: async () => {
          probes += 1;
          return { writable: true };
        },
        now: () => T0,
      },
    });
    assert.equal(probes, 1);
  });

  test("FIX-1047: a DISARMED loop never probes — it must not write at all", async () => {
    let probes = 0;
    const { db } = fakeDb();
    await runCloudflareMitigationLoop(db, [hour(-1, 50)], {
      writesEnabled: false,
      deps: {
        getLevel: async () => ({ level: "medium" as SecurityLevel }),
        setLevel: async () => ({ error: "unused" }),
        probeScope: async () => {
          probes += 1;
          return { writable: true };
        },
        now: () => T0,
      },
    });
    assert.equal(probes, 0, "a no-op write is still a write");
  });

  test("FIX-1047: a thrown probe keeps the prior verdict rather than inventing one", async () => {
    // Pessimism here would SUPPRESS a real mitigation on a transient blip.
    const prior = {
      writable: true,
      scope_missing: false,
      detail: null,
      checked_at: new Date(T0 - (PROBE_SCOPE_INTERVAL_HOURS + 1) * HOUR).toISOString(),
    };
    const { db } = fakeDb(stateWith({ scope_probe: prior }));
    const res = await runCloudflareMitigationLoop(db, [hour(-1, 50)], {
      writesEnabled: true,
      deps: {
        getLevel: async () => ({ level: "medium" as SecurityLevel }),
        setLevel: async () => ({ error: "unused" }),
        probeScope: async () => {
          throw new Error("network reset");
        },
        now: () => T0,
      },
    });
    assert.equal(res.scope_probe?.writable, true, "kept the last known-good verdict");
  });

  test("FIX-1047: an explicit threshold lowers the bar for a verify run", async () => {
    const { db } = fakeDb();
    const level = { current: "medium" as SecurityLevel };
    const res = await runCloudflareMitigationLoop(db, [hour(-1, 120), hour(-2, 110)], {
      writesEnabled: true,
      threshold: 100,
      deps: {
        getLevel: async () => ({ level: level.current }),
        setLevel: async (l) => {
          level.current = l;
          return { level: l };
        },
        probeScope: async () => ({ writable: true }),
        now: () => T0,
      },
    });
    assert.equal(res.decision.action, "trip");
    assert.equal(res.threshold, 100);
    assert.equal(level.current, "under_attack");
  });

  test("a manual change during the trip window is respected end-to-end", async () => {
    const { db } = fakeDb();
    const level = { current: "medium" as SecurityLevel };
    const deps = (nowMs: number) => ({
      getLevel: async () => ({ level: level.current }),
      setLevel: async (l: SecurityLevel) => {
        level.current = l;
        return { level: l };
      },
      now: () => nowMs,
    });

    await runCloudflareMitigationLoop(db, [hour(-1, 7200), hour(-2, 7100)], {
      writesEnabled: true,
      deps: deps(T0),
    });
    assert.equal(level.current, "under_attack");

    // Craig dials it down to "high" by hand mid-window.
    level.current = "high";

    const r = await runCloudflareMitigationLoop(db, [], {
      writesEnabled: true,
      deps: deps(T0 + REVERT_AFTER_HOURS * HOUR),
    });
    assert.equal(r.decision.action, "refuse_revert_manual_change");
    assert.equal(level.current, "high", "the manual setting must survive untouched");
  });
});
