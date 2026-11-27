/**
 * FIX-1218 — the dispatcher's two canary conditions.
 *
 * The cases up to FIX-1424's call classifyGhaDispatch(rows, now) with no
 * registry, so they run on the FIX-1460 fallback list: the hand list as it
 * stood, which must still judge exactly as it did. FIX-1460's cases pass the
 * registry rows. One clone case (CIVITICS_CLONE_TESTS=1) reads the registry as
 * the canary's service_role does, inside BEGIN … ROLLBACK.
 *
 * Runs via:  tsx --test src/scripts/canary-gha-dispatch.test.ts
 *            CIVITICS_CLONE_TESTS=1 tsx --test src/scripts/canary-gha-dispatch.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import {
  DISPATCH_FIRST_SLOT,
  FALLBACK_DETAIL_PREFIX,
  FALLBACK_DISPATCH_STALE_HOURS as DISPATCH_STALE_HOURS,
  GHA_DISPATCH_UNIT_PREFIX,
  KEY_DISPATCH_REFUSED,
  KEY_DISPATCH_STALE,
  classifyGhaDispatch,
  judgeRule,
  planGhaDispatchReads,
  slotLimitHours,
  type DispatchRegistryRow,
} from "./canary-gha-dispatch";

const NOW = new Date("2026-09-25T06:00:00Z");

const healthy = {
  gha_dispatch_nightly: { at: "2026-09-24T21:00:01Z", status: "dispatched", http_status: 200, last_dispatched_at: "2026-09-24T21:00:01Z" },
  "gha_dispatch_sync-canary-check": { at: "2026-09-25T05:00:01Z", status: "dispatched", http_status: 200 },
  "gha_dispatch_platform-snapshot": { at: "2026-09-25T05:50:02Z", status: "dispatched", http_status: 204 },
};

test("keys are the spellings the registry holds", () => {
  assert.equal(KEY_DISPATCH_REFUSED, "gha_dispatch_refused");
  assert.equal(KEY_DISPATCH_STALE, "gha_dispatch_stale");
});

test("a healthy dispatcher raises nothing", () => {
  const c = classifyGhaDispatch(healthy, NOW);
  assert.equal(c.refused.tier, null);
  assert.equal(c.stale.tier, null);
  assert.equal(c.stamps.length, 6, "the three FIX-1424 stems, absent before their first slots, read not stale");
});

test("an expired PAT (401) is refused — report-only — and names the last good dispatch", () => {
  const c = classifyGhaDispatch(
    {
      ...healthy,
      gha_dispatch_nightly: {
        at: "2026-09-24T21:00:01Z",
        status: "refused",
        http_status: 401,
        detail: "Bad credentials",
        last_dispatched_at: "2026-09-23T21:00:02Z",
      },
    },
    NOW,
  );
  assert.equal(c.refused.tier, "report");
  assert.equal(c.refused.severity, 1);
  assert.match(c.refused.detail, /nightly refused http=401 "Bad credentials"/);
  assert.match(c.refused.detail, /last good dispatch 2026-09-23T21:00:02Z/);
  // Refused is not stale: the route IS being called.
  assert.equal(c.stale.tier, null);
});

test("stale per cadence: nightly past 25 h, platform-snapshot past 30 min", () => {
  const c = classifyGhaDispatch(
    {
      ...healthy,
      gha_dispatch_nightly: { at: "2026-09-24T04:59:00Z", status: "dispatched" }, // 25.02 h
      "gha_dispatch_platform-snapshot": { at: "2026-09-25T05:29:00Z", status: "dispatched" }, // 31 min
    },
    NOW,
  );
  assert.equal(c.stale.tier, "report");
  assert.equal(c.stale.severity, 2);
  assert.match(c.stale.detail, /nightly last stamped .* limit 25 h/);
  assert.match(c.stale.detail, /platform-snapshot last stamped .* limit 0.5 h/);
  // Inside the limits: 24 h for nightly, 20 min for platform-snapshot.
  const ok = classifyGhaDispatch(
    {
      ...healthy,
      gha_dispatch_nightly: { at: "2026-09-24T06:00:00Z", status: "dispatched" },
      "gha_dispatch_platform-snapshot": { at: "2026-09-25T05:40:00Z", status: "dispatched" },
    },
    NOW,
  );
  assert.equal(ok.stale.tier, null);
});

test("a stem with no row at all is stale ('never stamped'), not silently fine", () => {
  const c = classifyGhaDispatch({}, NOW);
  assert.equal(c.stale.tier, "report");
  assert.equal(c.stale.severity, 3);
  assert.match(c.stale.detail, /nightly never stamped/);
  // …and not refused: there is no status to disagree with.
  assert.equal(c.refused.tier, null);
});

test("FIX-1424 (cc-292): the three weekly stems — 169 h, and absent reads not-stale only until the first slot + 1 h", () => {
  for (const s of ["irs990", "audit", "crs-summaries"]) assert.equal(DISPATCH_STALE_HOURS[s], 169, s);
  assert.deepEqual(DISPATCH_FIRST_SLOT, {
    "crs-summaries": "2026-11-21T10:00:00Z",
    irs990: "2026-11-24T15:00:00Z",
    audit: "2026-11-24T17:00:00Z",
  });
  const daily = { ...healthy };
  const at = (iso: string, rows: Record<string, unknown>) => classifyGhaDispatch(
    { ...rows, gha_dispatch_nightly: { at: new Date(Date.parse(iso) - 3_600_000).toISOString(), status: "dispatched" },
      "gha_dispatch_sync-canary-check": { at: new Date(Date.parse(iso) - 3_600_000).toISOString(), status: "dispatched" },
      "gha_dispatch_platform-snapshot": { at: new Date(Date.parse(iso) - 60_000).toISOString(), status: "dispatched" } },
    new Date(iso));
  // The deploy (Wed 11-18) to crs-summaries' first slot: none stamped, none stale.
  assert.equal(at("2026-11-18T05:00:00Z", daily).stale.tier, null);
  assert.equal(at("2026-11-21T10:59:00Z", daily).stale.tier, null, "inside the hour's grace");
  // Sun 11-22 05:00Z (the canary's next run): crs-summaries never stamped → stale; the Tuesday two not yet due.
  const sun = at("2026-11-22T05:00:00Z", daily);
  assert.equal(sun.stale.severity, 1);
  assert.match(sun.stale.detail, /crs-summaries never stamped/);
  // Stamped on time: fresh for 169 h, stale after.
  const stamped = { "gha_dispatch_crs-summaries": { at: "2026-11-21T10:00:05Z", status: "dispatched", http_status: 204 } };
  assert.equal(at("2026-11-22T05:00:00Z", stamped).stale.tier, null);
  assert.equal(at("2026-11-28T11:00:00Z", stamped).stamps.find((x) => x.stem === "crs-summaries")?.stale, false, "168.99 h");
  assert.match(at("2026-11-28T11:01:00Z", stamped).stale.detail, /crs-summaries last stamped .* limit 169 h/);
  // Wed 11-25 05:00Z: irs990 and audit past their first slots with no stamp → stale.
  const wed = at("2026-11-25T05:00:00Z", stamped);
  assert.equal(wed.stale.severity, 2);
  assert.match(wed.stale.detail, /irs990 never stamped/);
  assert.match(wed.stale.detail, /audit never stamped/);
});

// ── FIX-1460 (cc-324) — the stems and their limits from job_registry ────────

/** The seven gha-dispatch rows as the clone holds them (cc-324 read 2). */
const REGISTRY: DispatchRegistryRow[] = [
  { job: "audit", unit_call: "gha-dispatch:audit", deadline_rule: "at 0 17 * * 2", updated_at: "2026-11-18T04:05:40Z" },
  { job: "bill-details", unit_call: "gha-dispatch:bill-details", deadline_rule: "stale_after 2 hours", updated_at: "2026-11-26T22:19:28Z" },
  { job: "crs-summaries", unit_call: "gha-dispatch:crs-summaries", deadline_rule: "stale_after 2 hours", updated_at: "2026-11-26T07:37:25Z" },
  { job: "irs990", unit_call: "gha-dispatch:irs990", deadline_rule: "at 0 15 * * 2", updated_at: "2026-11-18T04:05:40Z" },
  { job: "nightly", unit_call: "gha-dispatch:nightly", deadline_rule: "by 0 21 * * *", updated_at: "2026-10-23T01:00:52Z" },
  { job: "platform-snapshot", unit_call: "gha-dispatch:platform-snapshot", deadline_rule: "at */10 * * * *", updated_at: "2026-10-13T01:07:49Z" },
  { job: "sync-canary-check", unit_call: "gha-dispatch:sync-canary-check", deadline_rule: "at 0 5 * * *", updated_at: "2026-10-13T01:07:49Z" },
];
const WITHOUT_BILL_DETAILS = REGISTRY.filter((r) => r.job !== "bill-details");

/** Fri 11-27 05:00Z, the canary's slot: every slot stem stamped on time. */
const T = new Date("2026-11-27T05:00:00Z");
const ago = (h: number) => new Date(T.getTime() - h * 3_600_000).toISOString();
const slotsHealthy = {
  gha_dispatch_nightly: { at: ago(7.9), status: "dispatched", http_status: 204 },
  "gha_dispatch_sync-canary-check": { at: ago(24), status: "dispatched", http_status: 204 },
  "gha_dispatch_platform-snapshot": { at: ago(0.1), status: "dispatched", http_status: 204 },
  gha_dispatch_irs990: { at: ago(62), status: "dispatched", http_status: 204 },
  gha_dispatch_audit: { at: ago(60), status: "dispatched", http_status: 204 },
};
const crsAt = (stampH: number, req: Record<string, unknown> | undefined) => ({
  ...slotsHealthy,
  "gha_dispatch_crs-summaries": { at: ago(stampH), status: "dispatched", http_status: 204 },
  ...(req ? { "gha_dispatch_request_crs-summaries": req } : {}),
});
const stem = (c: ReturnType<typeof classifyGhaDispatch>, s: string) => c.stamps.find((x) => x.stem === s);

test("FIX-1460 D2: a slot's limit is its cron's period plus slack — the five slot stems reproduce the hand list exactly", () => {
  assert.equal(slotLimitHours("0 15 * * 2"), 169);
  assert.equal(slotLimitHours("0 10 * * 7"), 169, "Sunday as 7 is one day");
  assert.equal(slotLimitHours("0 5 * * *"), 25);
  assert.equal(slotLimitHours("*/10 * * * *"), 0.5);
  assert.equal(slotLimitHours("*/5 * * * *"), 0.25);
  for (const unsized of ["0 11 3 * *", "0 */6 * * *", "5,35 * * * *", "0 9 * * 1-5", "*/7 * * * *", "not a cron"]) {
    assert.equal(slotLimitHours(unsized), null, unsized);
  }
  for (const r of REGISTRY) {
    const j = judgeRule(r.deadline_rule);
    if (r.deadline_rule!.startsWith("stale_after")) assert.deepEqual(j, { kind: "request" }, r.job);
    else assert.deepEqual(j, { kind: "slot", limit_hours: DISPATCH_STALE_HOURS[r.job] }, r.job);
  }
  assert.deepEqual(judgeRule("stale_before 3 days"), { kind: "unjudged" });
  assert.deepEqual(judgeRule(null), { kind: "unjudged" });
});

test("FIX-1460: the six stems with today's rows read exactly as today — same limits, same two texts", () => {
  const c = classifyGhaDispatch(crsAt(6 * 24, { requested_at: ago(6 * 24), consumed_at: ago(6 * 24 - 0.05), outcome: "dispatched" }), T, WITHOUT_BILL_DETAILS, []);
  assert.equal(c.source, "registry");
  assert.deepEqual(
    c.stamps.map((s) => [s.stem, s.judged, s.limit_hours]),
    [
      ["audit", "slot", 169],
      ["crs-summaries", "request", null],
      ["irs990", "slot", 169],
      ["nightly", "slot", 25],
      ["platform-snapshot", "slot", 0.5],
      ["sync-canary-check", "slot", 25],
    ],
  );
  assert.equal(c.refused.tier, null);
  assert.equal(c.stale.tier, null);
  assert.equal(c.refused.detail, "every dispatcher stamp reads dispatched");
  assert.equal(c.stale.detail, "every dispatcher stamp is inside its cadence");
  // A slot past its limit reads as it always did, and names its own Vercel path.
  const late = classifyGhaDispatch({ ...slotsHealthy, gha_dispatch_nightly: { at: ago(25.5), status: "dispatched" } }, T, WITHOUT_BILL_DETAILS, []);
  assert.match(late.stale.detail, /^GHA dispatcher not calling: nightly last stamped .* \(25\.5 h ago, limit 25 h\) — check the Vercel crons for \/api\/cron\/gha-dispatch\/nightly-request$/);
});

test("FIX-1460 D2: crs-summaries resting — a consumed request and a stamp six days old are not stale", () => {
  const c = classifyGhaDispatch(crsAt(144, { requested_at: ago(144), consumed_at: ago(143.95), outcome: "dispatched", reaped_at: ago(143.7), reap: "reaped: succeeded: GHA" }), T, REGISTRY, []);
  const s = stem(c, "crs-summaries")!;
  assert.equal(s.stale, false);
  assert.equal(s.age_hours, 144, "the age is carried, not judged");
  assert.equal(s.request?.outcome, "dispatched");
  assert.equal(c.stale.tier, null);
  // The old 169 h would have read this stale a day later; the registry path does not.
  assert.equal(stem(classifyGhaDispatch(crsAt(200, { requested_at: ago(200), consumed_at: ago(199.9) }), T, REGISTRY, []), "crs-summaries")?.stale, false);
});

test("FIX-1460 D2: crs-summaries — a request 30 minutes old and unconsumed is stale; 20 minutes is not", () => {
  const c = classifyGhaDispatch(crsAt(144, { job: "crs-summaries", requested_at: ago(0.5), consumed_at: null, outcome: null, reaped_at: null }), T, REGISTRY, []);
  assert.equal(c.stale.tier, "report");
  assert.equal(c.stale.severity, 1);
  assert.equal(
    c.stale.detail,
    `GHA dispatcher not calling: crs-summaries request ${ago(0.5)} unconsumed for 30 min — check the Vercel crons for /api/cron/gha-dispatch/crs-summaries-request`,
  );
  const fresh = classifyGhaDispatch(crsAt(144, { requested_at: ago(20 / 60), consumed_at: null, reaped_at: null }), T, REGISTRY, []);
  assert.equal(stem(fresh, "crs-summaries")?.stale, false);
});

test("FIX-1460 D2: crs-summaries — its last reap `missed` is stale", () => {
  const req = {
    requested_at: ago(1), consumed_at: null, outcome: null, reaped_at: ago(0.6),
    reap: "missed: no dispatch by 2026-11-27 04:20:00+00 — the request route did not fire (N2); idempotent_refire t; the row stays due inside its window",
  };
  const c = classifyGhaDispatch(crsAt(144, req), T, REGISTRY, []);
  assert.equal(c.stale.severity, 1);
  assert.ok(c.stale.detail.includes(`crs-summaries request ${ago(1)} reaped missed at ${ago(0.6)}`), c.stale.detail);
  // A request reaped any other way is not a route that did not answer.
  const failed = classifyGhaDispatch(crsAt(144, { ...req, reap: "reaped: failed: GHA no congress_crs_summaries row within 2700 s" }), T, REGISTRY, []);
  assert.equal(stem(failed, "crs-summaries")?.stale, false);
});

test("FIX-1460 (read 4): the miss the key cannot show — dispatch_log `missed` since the last stamp is stale; one answered since is not", () => {
  // 3b reaped the miss and the ARM re-armed in the same tick: the key reads a fresh request.
  const rows = crsAt(30, { requested_at: ago(0.1), consumed_at: null, reaped_at: null });
  const missed = [
    { armed_jobname: "gha_dispatch_request_crs-summaries", ticked_at: ago(2.4), armed_for: ago(2.75) },
    { armed_jobname: "gha_dispatch_request_crs-summaries", ticked_at: ago(0.1), armed_for: ago(0.45) },
  ];
  const c = classifyGhaDispatch(rows, T, REGISTRY, missed);
  assert.equal(c.stale.severity, 1);
  assert.ok(
    c.stale.detail.includes(
      `crs-summaries request ${ago(0.45)} reaped missed at ${ago(0.1)} (2 missed in 24 h, dispatch_log; no route answer since, last stamp ${ago(30)})`,
    ),
    c.stale.detail,
  );
  // The route answered after the misses: recovered.
  assert.equal(stem(classifyGhaDispatch(crsAt(0.05, { requested_at: ago(0.1), consumed_at: ago(0.05) }), T, REGISTRY, missed), "crs-summaries")?.stale, false);
  // Older than the lookback, or another stem's: not this stem's miss.
  assert.equal(stem(classifyGhaDispatch(rows, T, REGISTRY, [{ ...missed[0]!, ticked_at: ago(25) }]), "crs-summaries")?.stale, false);
  assert.equal(stem(classifyGhaDispatch(rows, T, REGISTRY, [{ ...missed[0]!, armed_jobname: "gha_dispatch_request_bill-details" }]), "crs-summaries")?.stale, false);
  // The dispatch_log read failed (null): the keys judge alone.
  assert.equal(stem(classifyGhaDispatch(rows, T, REGISTRY, null), "crs-summaries")?.stale, false);
});

test("FIX-1460 D2: bill-details — a registry row and no key of either kind is never armed, not stale; absent from the registry it is not listed", () => {
  const c = classifyGhaDispatch(crsAt(144, { requested_at: ago(144), consumed_at: ago(143.9) }), T, REGISTRY, []);
  const b = stem(c, "bill-details")!;
  assert.equal(b.judged, "request");
  assert.equal(b.at, null);
  assert.equal(b.request, null);
  assert.equal(b.stale, false);
  assert.equal(b.refused, false);
  assert.equal(c.stale.tier, null);
  // Prod before cc-330 pushes its row.
  assert.equal(stem(classifyGhaDispatch(slotsHealthy, T, WITHOUT_BILL_DETAILS, []), "bill-details"), undefined);
});

test("FIX-1460 D3: a slot row with no stamp is stale only once the row is older than its limit", () => {
  const row = (updatedH: number): DispatchRegistryRow[] => [
    { job: "new-daily", unit_call: "gha-dispatch:new-daily", deadline_rule: "at 0 4 * * *", updated_at: ago(updatedH) },
  ];
  assert.equal(stem(classifyGhaDispatch({}, T, row(24), []), "new-daily")?.stale, false, "yesterday: not yet due");
  const two = classifyGhaDispatch({}, T, row(48), []);
  assert.equal(two.stale.severity, 1);
  assert.match(two.stale.detail, /new-daily never stamped — check the Vercel crons for \/api\/cron\/gha-dispatch\/new-daily$/);
  // DISPATCH_FIRST_SLOT still speaks for the stems it names: irs990 before its first slot.
  const irs = [{ ...REGISTRY.find((r) => r.job === "irs990")!, updated_at: "2026-11-01T00:00:00Z" }];
  assert.equal(stem(classifyGhaDispatch({}, new Date("2026-11-24T15:30:00Z"), irs, []), "irs990")?.stale, false);
  assert.equal(stem(classifyGhaDispatch({}, new Date("2026-11-24T16:01:00Z"), irs, []), "irs990")?.stale, true);
});

test("FIX-1460 D2: a rule in neither class, or a cron this cannot size, is `unjudged` — in the detail, in neither condition", () => {
  const reg: DispatchRegistryRow[] = [
    ...WITHOUT_BILL_DETAILS,
    { job: "monthly", unit_call: "gha-dispatch:monthly", deadline_rule: "at 0 11 3 * *", updated_at: ago(1000) },
    { job: "odd", unit_call: "gha-dispatch:odd", deadline_rule: "every tuesday", updated_at: ago(1000) },
  ];
  const c = classifyGhaDispatch(
    { ...crsAt(1, { requested_at: ago(1), consumed_at: ago(1) }), gha_dispatch_odd: { at: ago(900), status: "refused", http_status: 401 } },
    T, reg, [],
  );
  assert.equal(stem(c, "monthly")?.judged, "unjudged");
  assert.equal(stem(c, "odd")?.stale, false);
  assert.equal(stem(c, "odd")?.refused, false, "counted in neither condition");
  assert.equal(c.stale.tier, null);
  assert.equal(c.refused.tier, null);
  assert.equal(c.stale.detail, "every dispatcher stamp is inside its cadence; unjudged: monthly (at 0 11 3 * *), odd (every tuesday)");
});

test("FIX-1460 D5: the registry unread (or empty) — today's hand list, and the detail says so first", () => {
  for (const reg of [null, undefined, []]) {
    const c = classifyGhaDispatch(slotsHealthy, T, reg as DispatchRegistryRow[] | null | undefined, null);
    assert.equal(c.source, "fallback");
    assert.deepEqual(c.stamps.map((s) => s.stem), Object.keys(DISPATCH_STALE_HOURS));
    assert.ok(c.stamps.every((s) => s.rule === null && s.judged === "slot"));
    assert.ok(c.stale.detail.startsWith(`${FALLBACK_DETAIL_PREFIX}; `), c.stale.detail);
  }
  // On the fallback crs-summaries is its old 169 h slot again — the list as it stood.
  const fb = classifyGhaDispatch({ ...slotsHealthy, "gha_dispatch_crs-summaries": { at: ago(170), status: "dispatched" } }, T, null);
  assert.equal(
    fb.stale.detail,
    `${FALLBACK_DETAIL_PREFIX}; GHA dispatcher not calling: crs-summaries last stamped ${ago(170)} (170 h ago, limit 169 h) — check the Vercel crons for /api/cron/gha-dispatch/<stem>`,
  );
  // The reads it plans: stamps and request keys of the six, no dispatch_log read.
  const plan = planGhaDispatchReads(null);
  assert.equal(plan.keys.length, 12);
  assert.deepEqual(plan.missedJobnames, []);
  assert.deepEqual(planGhaDispatchReads(REGISTRY).missedJobnames, ["gha_dispatch_request_bill-details", "gha_dispatch_request_crs-summaries"]);
});

test("FIX-1460 D4 (read 5): a walker's refusal is on its stamp — refused, and its consumed request is not stale", () => {
  const c = classifyGhaDispatch(
    {
      ...slotsHealthy,
      "gha_dispatch_bill-details": { at: ago(0.2), status: "refused", http_status: 401, detail: "Bad credentials", last_dispatched_at: ago(30) },
      "gha_dispatch_request_bill-details": { requested_at: ago(0.25), consumed_at: ago(0.2), outcome: "refused", http_status: 401, reaped_at: ago(0.15), reap: "reaped: failed: dispatch refused 401" },
    },
    T, REGISTRY, [],
  );
  assert.equal(c.refused.severity, 1);
  assert.match(c.refused.detail, /bill-details refused http=401 "Bad credentials"/);
  assert.equal(stem(c, "bill-details")?.stale, false);
  assert.equal(c.stale.tier, null);
});

test("FIX-1460 clone: the canary's registry read, as service_role, returns the seven gha-dispatch stems and every rule sizes", async (t) => {
  if (process.env["CIVITICS_CLONE_TESTS"] !== "1") {
    t.skip("set CIVITICS_CLONE_TESTS=1 to run against the migrated clone");
    return;
  }
  const c = new Client({ connectionString: "postgresql://postgres:postgres@127.0.0.1:54322/postgres", connectionTimeoutMillis: 2500 });
  await c.connect();
  try {
    await c.query("BEGIN");
    await c.query("SET LOCAL ROLE service_role");
    // canary-check's PostgREST read, as SQL: .select(job, unit_call, deadline_rule, updated_at).like(unit_call, prefix%).order(job)
    const res = await c.query<DispatchRegistryRow>(
      "SELECT job, unit_call, deadline_rule, updated_at::text AS updated_at FROM public.job_registry WHERE unit_call LIKE $1 ORDER BY job",
      [`${GHA_DISPATCH_UNIT_PREFIX}%`],
    );
    const cls = classifyGhaDispatch({}, new Date(), res.rows, []);
    assert.equal(cls.source, "registry");
    assert.deepEqual(
      cls.stamps.map((s) => [s.stem, s.rule, s.judged, s.limit_hours]),
      [
        ["audit", "at 0 17 * * 2", "slot", 169],
        ["bill-details", "stale_after 2 hours", "request", null],
        ["crs-summaries", "stale_after 2 hours", "request", null],
        ["irs990", "at 0 15 * * 2", "slot", 169],
        ["nightly", "by 0 21 * * *", "slot", 25],
        ["platform-snapshot", "at */10 * * * *", "slot", 0.5],
        ["sync-canary-check", "at 0 5 * * *", "slot", 25],
      ],
    );
  } finally {
    await c.query("ROLLBACK").catch(() => undefined);
    await c.end();
  }
});
