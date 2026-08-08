/**
 * FIX-977 + FIX-978 — coverage and false-positive guards for the two detectors
 * this PR adds.
 *
 * Runs via:  tsx --test src/__tests__/detector-coverage.test.ts
 *
 * WHY THESE ARE DB-BACKED AND SELF-SKIPPING. Every other suite in this package
 * tests pure TypeScript against fake clients, because CI has no Postgres. Both
 * things under test here are SQL functions whose entire value is what they do
 * with real rows, so a TS reimplementation would test a copy rather than the
 * shipped logic — the exact drift shape FIX-407's guard exists to prevent.
 * These connect to the LOCAL Docker DB when it is reachable and skip loudly
 * when it is not, so they are meaningful locally and inert in CI.
 *
 * Every fixture is written inside a transaction that is ALWAYS rolled back, so
 * the suite never leaves rows in data_sync_log.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";

const LOCAL_DSN = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

async function connect(): Promise<Client | null> {
  const c = new Client({ connectionString: LOCAL_DSN, connectionTimeoutMillis: 2500 });
  try {
    await c.connect();
    return c;
  } catch {
    await c.end().catch(() => {});
    return null;
  }
}

/** Run body inside a transaction that is always rolled back. */
async function inRollback(fn: (c: Client) => Promise<void>): Promise<boolean> {
  const c = await connect();
  if (!c) {
    console.log("[detector-coverage] local Docker DB unreachable — SKIPPING (expected in CI)");
    return false;
  }
  try {
    await c.query("BEGIN");
    await fn(c);
    return true;
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    await c.end().catch(() => {});
  }
}

/** Insert a synthetic pg_cron-driven run. */
function insertRun(
  c: Client,
  pipeline: string,
  hoursAgo: number,
  spanSeconds: number,
  work: number,
): Promise<unknown> {
  return c.query(
    `INSERT INTO public.data_sync_log
       (pipeline, started_at, completed_at, rows_inserted, rows_updated, status, metadata)
     VALUES ($1,
             now() - make_interval(hours => $2::int),
             now() - make_interval(hours => $2::int) + make_interval(secs => $3::int),
             $4, 0, 'complete', '{"source":"pg_cron"}'::jsonb)`,
    [pipeline, hoursAgo, spanSeconds, work],
  );
}

async function rateVerdicts(c: Client): Promise<Map<string, { verdict: string; escalates: boolean }>> {
  const res = await c.query<{ result: { pipelines: { pipeline: string; verdict: string; escalates: boolean }[] } }>(
    "SELECT public.check_pipeline_rate_regression() AS result",
  );
  const out = new Map<string, { verdict: string; escalates: boolean }>();
  for (const p of res.rows[0]?.result?.pipelines ?? []) {
    out.set(p.pipeline, { verdict: p.verdict, escalates: p.escalates });
  }
  return out;
}

// ---------------------------------------------------------------------------
// FIX-977 — the registry must be a SUPERSET of the census.
// ---------------------------------------------------------------------------

test("FIX-977 registry covers every pg_cron-driven pipeline (registry ⊇ census)", async () => {
  const ran = await inRollback(async (c) => {
    const census = await c.query<{ pipeline: string }>(
      `SELECT DISTINCT pipeline FROM public.data_sync_log
        WHERE metadata->>'source' = 'pg_cron'
          AND started_at >= now() - interval '90 days'`,
    );
    const reg = await c.query<{ result: { pipelines: { pipeline: string }[] } }>(
      "SELECT public.list_scheduled_rollup_pipelines() AS result",
    );
    const watched = new Set((reg.rows[0]?.result?.pipelines ?? []).map((p) => p.pipeline));
    const unwatched = census.rows.map((r) => r.pipeline).filter((p) => !watched.has(p));

    assert.deepEqual(
      unwatched,
      [],
      `pipelines pg_cron drives but the registry does not watch: ${unwatched.join(", ")}. ` +
        `This is the FIX-977 defect regressing — the watch list must be DERIVED, not narrowed.`,
    );
  });
  if (!ran) return;
});

test("FIX-977 a brand-new scheduled pipeline joins the registry with no code change", async () => {
  const ran = await inRollback(async (c) => {
    const NEW = "zz_synthetic_new_rollup_fix977";
    // A relation that did not exist when the registry was written. Under the
    // old length-1 literal this would have been invisible forever; the whole
    // point of deriving the census is that it is watched on its first run.
    await insertRun(c, NEW, 30, 60, 1000);
    await insertRun(c, NEW, 6, 60, 1000);

    const reg = await c.query<{ result: { pipelines: { pipeline: string; cadence_source: string }[] } }>(
      "SELECT public.list_scheduled_rollup_pipelines() AS result",
    );
    const found = (reg.rows[0]?.result?.pipelines ?? []).find((p) => p.pipeline === NEW);
    assert.ok(found, `a new pg_cron-driven pipeline must appear in the derived registry automatically`);
  });
  if (!ran) return;
});

test("FIX-977 cron_cadence_hours parses the schedule families in use, and refuses the rest", async () => {
  const c = await connect();
  if (!c) {
    console.log("[detector-coverage] local Docker DB unreachable — SKIPPING (expected in CI)");
    return;
  }
  try {
    const cases: [string, number | null][] = [
      ["0 6 * * *", 24],       // daily
      ["0 9,12 * * *", 12],    // twice daily
      ["0 * * * *", 1],        // hourly
      ["0 8 * * 3", 168],      // weekly
      ["0 2 * * 0,3", 84],     // twice weekly
      ["0 12 1 * *", 730],     // monthly
      ["*/5 * * * *", null],   // step syntax — must refuse, not guess
      ["0 1-5 * * *", null],   // range syntax — must refuse, not guess
    ];
    for (const [sched, want] of cases) {
      const res: { rows: { h: string | null }[] } = await c.query("SELECT public.cron_cadence_hours($1) AS h", [sched]);
      const raw: string | null = res.rows[0]?.h ?? null;
      const got: number | null = raw == null ? null : Number(raw);
      assert.equal(got, want, `cron_cadence_hours('${sched}') expected ${want}, got ${got}`);
    }
    // The NULL guard: an uncorrelated pipeline has no schedule, and must NOT
    // fall through to the daily branch. Validated against prod, where the
    // missing guard gave recipient_count_reconcile a fabricated 24h cadence.
    const nul = await c.query<{ h: string | null }>("SELECT public.cron_cadence_hours(NULL) AS h");
    assert.equal(nul.rows[0]?.h, null, "a NULL schedule must yield a NULL cadence, not 24h");
  } finally {
    await c.end().catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// FIX-978 — the two false-positive shapes the rate detector must survive.
// ---------------------------------------------------------------------------

test("FIX-978 legitimate-zero runs never produce a rate finding", async () => {
  const ran = await inRollback(async (c) => {
    const P = "zz_zero_work_sweep_fix978";
    // A source-gated no-op that ran often and did nothing, which is HEALTHY.
    // Measured on prod: donation_edge_orphan_sweep did 0 rows on 2 of 2 runs
    // and donor_rollup_refresh on 8 of 17. A rate is only defined when work
    // existed; dividing by zero work manufactures an infinite regression.
    for (let i = 20; i >= 1; i--) await insertRun(c, P, i * 24, 30 + i, 0);

    const v = await rateVerdicts(c);
    assert.equal(v.has(P), false, "a pipeline whose runs all did zero work must not be rated at all");
  });
  if (!ran) return;
});

test("FIX-978 zero-span writers never produce a rate finding", async () => {
  const ran = await inRollback(async (c) => {
    const P = "zz_zero_span_fix978";
    // completed_at == started_at. recipient_count_reconcile does exactly this
    // on prod; every rate derived from it would be infinite.
    for (let i = 20; i >= 1; i--) await insertRun(c, P, i * 24, 0, 5000);

    const v = await rateVerdicts(c);
    assert.equal(v.has(P), false, "a zero-span pipeline must be excluded, not rated as infinitely slow");
  });
  if (!ran) return;
});

test("FIX-978 a bimodal job does not escalate (one reading is not a trend)", async () => {
  const ran = await inRollback(async (c) => {
    const P = "zz_bimodal_fix978";
    // The audit's class-4 shape: entity-connection-stats-rebuild measured a
    // 184x spread between two modes with NO rising curve. Alternating fast and
    // slow, including within the recent window.
    for (let i = 20; i >= 1; i--) {
      const slow = i % 2 === 0;
      await insertRun(c, P, i * 24, slow ? 4000 : 30, 10000);
    }
    const v = await rateVerdicts(c);
    const got = v.get(P);
    assert.ok(got, "the bimodal pipeline should still be rated");
    assert.equal(got.escalates, false, `a bimodal job must not escalate (verdict was ${got.verdict})`);
    assert.notEqual(got.verdict, "sustained_regression");
  });
  if (!ran) return;
});

test("FIX-978 a single slow run among fast ones does not escalate", async () => {
  const ran = await inRollback(async (c) => {
    const P = "zz_single_dip_fix978";
    for (let i = 20; i >= 4; i--) await insertRun(c, P, i * 24, 100, 10000);
    // Recent window: one bad run, two good ones. Report-only by design.
    await insertRun(c, P, 3 * 24, 5000, 10000);
    await insertRun(c, P, 2 * 24, 100, 10000);
    await insertRun(c, P, 1 * 24, 100, 10000);

    const v = await rateVerdicts(c);
    const got = v.get(P);
    assert.ok(got, "the pipeline should be rated");
    assert.equal(got.escalates, false, `a single dip must not escalate (verdict was ${got.verdict})`);
  });
  if (!ran) return;
});

test("FIX-978 a genuine sustained regression DOES escalate", async () => {
  const ran = await inRollback(async (c) => {
    const P = "zz_real_regression_fix978";
    // Stable baseline, then every run in the recent window an order of
    // magnitude slower per unit of work. This is the FIX-973 shape the platform
    // could not see: ~9x per-row cost regression inside the freshness window.
    for (let i = 20; i >= 4; i--) await insertRun(c, P, i * 24, 100, 10000);
    for (let i = 3; i >= 1; i--) await insertRun(c, P, i * 24, 2000, 10000);

    const v = await rateVerdicts(c);
    const got = v.get(P);
    assert.ok(got, "the pipeline should be rated");
    assert.equal(got.verdict, "sustained_regression");
    assert.equal(got.escalates, true, "a sustained across-the-board regression must escalate");
  });
  if (!ran) return;
});

test("FIX-978 thin history reports insufficient_data rather than escalating", async () => {
  const ran = await inRollback(async (c) => {
    const P = "zz_thin_history_fix978";
    // Baseline of 2 runs is not enough to call anything a trend, even though
    // the recent runs are dramatically slower.
    await insertRun(c, P, 10 * 24, 100, 10000);
    await insertRun(c, P, 9 * 24, 100, 10000);
    for (let i = 3; i >= 1; i--) await insertRun(c, P, i * 24, 9000, 10000);

    const v = await rateVerdicts(c);
    const got = v.get(P);
    assert.ok(got, "the pipeline should be rated");
    assert.equal(got.verdict, "insufficient_data");
    assert.equal(got.escalates, false, "thin history must never escalate");
  });
  if (!ran) return;
});
