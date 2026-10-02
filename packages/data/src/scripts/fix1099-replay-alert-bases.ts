/**
 * FIX-1099 — the committed alert-basis replay (cc-175 D6).
 *
 * The question: once FIX-1099's options 1 + 2 are in (FIXED_PER_CYCLE_SERVICES
 * projected once; the projection divisor floored at MIN_PROJECTION_DAYS), can
 * the three Vercel alert rows move from the calendar month to the vendor's
 * billing cycle without an alert silently flipping state or going permanently
 * green? cc-168 answered "no" for the old arithmetic with ad-hoc SQL and a hand
 * reconstruction (docs/audits/2026-09-28-fix1099-alert-replay.md). This is the
 * same replay as a committed script that runs the SAME code the snapshot runs:
 * computeVercelBilling, vercelBillingCycle, computeMetricPercents and
 * computeMetricStatus are imported from @civitics/db, not re-implemented
 * (rule 105).
 *
 * ── INPUTS, AND WHERE EACH ONE COMES FROM (the `provenance` column) ──────────
 *
 *   stored         prod platform_usage_snapshot, the last tick of each charge
 *                  day: one row per (UTC month, window_days), which is the
 *                  audit's grouping. Vercel's charges step once a day, so every
 *                  tick within a group is the same data.
 *   shadow         payload.vercel_billing_shadow, the vendor-basis billing the
 *                  snapshot has computed live since 2026-09-28 01:30Z.
 *   reconstructed  the vendor cycle-to-date before the shadow existed:
 *                  differences of the cumulative calendar usage, as cc-168 §1
 *                  did it. Cross-checked against the shadow where both exist.
 *   audit          rows older than the 30-day retention, taken from cc-168's
 *                  table: the four August days and the Aug 14 day-1 supplement,
 *                  plus the A14 anchor (usage through Aug 13 PDT) that every
 *                  Aug-cycle reconstruction rests on. Their calendar usage is
 *                  back-computed from a cent-rounded projection, so it is ±$0.005.
 *
 * The fixed per-cycle charge per row: from vercel_breakdown's
 * `Speed Insights Plus Events` line on the calendar basis (un-projected with
 * the row's own divisor), from the shadow's fixed_per_cycle_usd once the shadow
 * carries it, else as cumulative differences like the usage.
 *
 * ── FOUR COLUMNS PER ALERT ROW ───────────────────────────────────────────────
 *
 *   calendar OLD   the pre-FIX-1099 arithmetic on the calendar inputs
 *                  (fixed 0, floor 1). It must equal what prod stored, and the
 *                  script counts the rows where it does.
 *   calendar NEW   options 1 + 2 on the same inputs
 *   vendor OLD     the pre-FIX-1099 arithmetic on the vendor inputs
 *   vendor NEW     options 1 + 2 on the vendor inputs
 *
 * ── ACCEPTANCE, COMPUTED (cc-175 D6) ─────────────────────────────────────────
 *
 *   (i)   vendor-NEW included_usage_usd is critical on NO day of a cycle whose
 *         cycle-end usage is at or below the credit. Completed cycles decide;
 *         an in-progress cycle is reported as provisional.
 *   (ii)  no single-day healthy → critical jump on vendor-NEW (adjacent
 *         charge days only).
 *   (iii) billable_overage_usd and overage_present are identical OLD vs NEW on
 *         every day, on both bases.
 *   (iv)  vendor-NEW is never healthy on a day where calendar-OLD read critical
 *         AND the cycle ended over the credit. "Vacuous" if no such cycle exists.
 *   (v)   the wrong-but-green check: the OLD arithmetic on the Aug 14 cycle's
 *         day-14 row reads critical, and the NEW one does not.
 *
 * READ ONLY: one connection, one `BEGIN READ ONLY` transaction, two SELECTs
 * (the snapshots and the three bands), then ROLLBACK. Nothing is written to
 * any database.
 *
 * Run (from the primary checkout; a worktree's .env.local.prod is a stub):
 *   pnpm --filter @civitics/data data:replay:fix1099 -- \
 *     --from 2026-08-14 --md ../../docs/audits/2026-10-01-fix1099-replay-2.md \
 *     --json ../../docs/audits/2026-10-01-fix1099-replay-2.json
 * Flags: --from YYYY-MM-DD, --to <ISO> (default now), --md <path>, --json <path>.
 */

import { writeFileSync } from "node:fs";
import { Client } from "pg";
import {
  computeMetricPercents,
  computeMetricStatus,
  computeVercelBilling,
  MIN_PROJECTION_DAYS,
  vercelBillingCycle,
  VERCEL_PRO_INCLUDED_USD,
} from "@civitics/db";
import { buildDbUrl } from "../lib/heavy-rebuild";

// ── Flags ─────────────────────────────────────────────────────────────────────

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith("--") ? v : undefined;
}
const FROM = argValue("--from") ?? "2026-08-14";
const TO = argValue("--to") ?? new Date().toISOString();
const MD_PATH = argValue("--md");
const JSON_PATH = argValue("--json");

// ── The audit's out-of-retention inputs (cc-168, 2026-09-28) ─────────────────

/** Usage through Aug 13 PDT (August window_days 14). cc-168 §1: (15.19 − 1.8589) − 14 × 20/31. */
const A14 = 4.2988;
/** Speed Insights Plus Events on Aug 14 PDT, day 1 of the Aug 14 cycle (cc-168 §1). */
const AUG_FIXED = 0.65;
const AUG_CYCLE = { start: "2026-08-14T07:00:00.000Z", end: "2026-09-14T07:00:00.000Z" };
/** cc-168 §2's August rows: the stored calendar projection, cent-rounded, at window_days k of 31. */
const AUDIT_AUGUST: Array<{ tick: string; k: number; calProjected: number; note?: string }> = [
  // §2 "Supplementary, outside retention": Aug 14 PDT itself, $5.5125 MTD over 15 days.
  { tick: "2026-08-15T23:30:00Z", k: 15, calProjected: (5.5125 * 31) / 15, note: "cc-168 §2 supplement (the crawl's day 1)" },
  { tick: "2026-08-29T03:21:00Z", k: 28, calProjected: 16.78 },
  { tick: "2026-08-30T06:30:00Z", k: 29, calProjected: 16.34 },
  { tick: "2026-08-31T06:03:00Z", k: 30, calProjected: 16.04 },
  { tick: "2026-08-31T23:30:00Z", k: 31, calProjected: 15.6 },
];

// ── Small date helpers (charge days are Pacific days, as YYYY-MM-DD) ─────────

const DAY_MS = 86_400_000;
const pacificDay = (ms: number): string =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
const dayMs = (d: string): number => Date.parse(`${d}T00:00:00Z`);
const addDays = (d: string, n: number): string => new Date(dayMs(d) + n * DAY_MS).toISOString().slice(0, 10);
const dayDiff = (a: string, b: string): number => Math.round((dayMs(a) - dayMs(b)) / DAY_MS);
const daysInMonth = (monthKey: string): number => {
  const [y, m] = monthKey.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const nextMonth = (monthKey: string): string => {
  const [y, m] = monthKey.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
};
/** The calendar window for month M covers Pacific days [first(M) − 1, …]; window day k ends on first(M) + k − 2. */
const windowDay = (monthKey: string, k: number): string => addDays(`${monthKey}-01`, k - 2);
/** The window, and its day index, that contains Pacific day d. */
const windowOf = (d: string): { monthKey: string; k: number } => {
  const monthKey = addDays(d, 1).slice(0, 7);
  return { monthKey, k: dayDiff(d, `${monthKey}-01`) + 2 };
};
const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10000) / 10000;

// ── Types ─────────────────────────────────────────────────────────────────────

type Status = "healthy" | "warning" | "critical";
type MetricKey = "included_usage_usd" | "billable_overage_usd" | "overage_present";
type Band = { included_limit: number; warning_pct: number; critical_pct: number };

type Inputs = {
  usage: number;
  base: number;
  fixed: number;
  windowDays: number;
  daysInCycle: number;
};

type Computed = {
  projected_usage_usd: number;
  projected_billable_overage_usd: number;
  billable_overage_mtd_usd: number;
  projection_divisor_days: number;
  status: Record<MetricKey, Status>;
};

type ReplayRow = {
  tick: string;
  /** An audit row with no tick of its own says so here, and renders "—". */
  note?: string;
  through: string;
  provenance: { calendar: "stored" | "audit"; vendor: "shadow" | "reconstructed" | "audit" | "unavailable" };
  calendar: { inputs: Inputs; stored_projected: number | null; old: Computed; new: Computed };
  vendor: {
    cycle_start: string;
    cycle_end: string;
    day: number;
    inputs: Inputs;
    old: Computed;
    new: Computed;
    reconstruction_vs_shadow: number | null;
  } | null;
  /** json-only: vendor-NEW and calendar-NEW projections under other floors. */
  floors: Record<string, { calendar: number; vendor: number | null; vendor_status: Status | null }>;
};

// ── The arithmetic, through @civitics/db ─────────────────────────────────────

let BANDS: Record<MetricKey, Band>;
let CREDIT = VERCEL_PRO_INCLUDED_USD;

function statusOf(metric: MetricKey, value: number): Status {
  const band = BANDS[metric];
  return computeMetricStatus(computeMetricPercents(value, band).pct, band) as Status;
}

function compute(inp: Inputs, arithmetic: "old" | "new", floor = MIN_PROJECTION_DAYS): Computed {
  const b = computeVercelBilling({
    effectiveMtdUsd: inp.usage + inp.base,
    planBaseMtdUsd: inp.base,
    windowDays: inp.windowDays,
    daysInCycle: inp.daysInCycle,
    includedCreditUsd: CREDIT,
    fixedPerCycleUsd: arithmetic === "old" ? 0 : inp.fixed,
    minProjectionDays: arithmetic === "old" ? 1 : floor,
  });
  return {
    projected_usage_usd: b.projected_usage_usd,
    projected_billable_overage_usd: b.projected_billable_overage_usd,
    billable_overage_mtd_usd: b.billable_overage_mtd_usd,
    projection_divisor_days: b.projection_divisor_days,
    // The three rows exactly as platform-snapshot.ts feeds them.
    status: {
      included_usage_usd: statusOf("included_usage_usd", b.projected_usage_usd),
      billable_overage_usd: statusOf("billable_overage_usd", b.projected_billable_overage_usd),
      overage_present: statusOf("overage_present", b.billable_overage_mtd_usd > 0 ? 1 : 0),
    },
  };
}

// ── Read ──────────────────────────────────────────────────────────────────────

type SnapRow = {
  fetched_at: Date;
  vb: Record<string, unknown> | null;
  shadow: Record<string, unknown> | null;
  breakdown: { window_days?: number; services?: Array<{ service: string; usd: number }> } | null;
  vcycle: { start?: string; end?: string } | null;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

async function main(): Promise<void> {
  const client = new Client({ connectionString: buildDbUrl() });
  await client.connect();
  let readAt = "";
  let snaps: SnapRow[] = [];
  try {
    await client.query("BEGIN READ ONLY");
    const t = await client.query<{ now: Date }>("SELECT now() AS now");
    readAt = t.rows[0]!.now.toISOString();
    const s = await client.query<SnapRow>(
      `SELECT fetched_at,
              payload->'vercel_billing'        AS vb,
              payload->'vercel_billing_shadow' AS shadow,
              payload->'vercel_breakdown'      AS breakdown,
              payload->'cycles'->'vercel'      AS vcycle
         FROM public.platform_usage_snapshot
        WHERE payload ? 'vercel_billing'
          AND fetched_at >= $1::date AND fetched_at <= $2::timestamptz
        ORDER BY fetched_at`,
      [FROM, TO],
    );
    snaps = s.rows;
    const l = await client.query<{ metric: MetricKey } & Band>(
      `SELECT metric, included_limit::float8 AS included_limit,
              warning_pct::float8 AS warning_pct, critical_pct::float8 AS critical_pct
         FROM public.platform_limits
        WHERE service = 'vercel' AND plan = 'pro'
          AND metric IN ('included_usage_usd', 'billable_overage_usd', 'overage_present')`,
    );
    const bands = Object.fromEntries(l.rows.map((r) => [r.metric, r])) as Partial<Record<MetricKey, Band>>;
    for (const m of ["included_usage_usd", "billable_overage_usd", "overage_present"] as MetricKey[]) {
      if (!bands[m]) throw new Error(`platform_limits has no pro row for vercel.${m}`);
    }
    BANDS = bands as Record<MetricKey, Band>;
    CREDIT = BANDS.included_usage_usd.included_limit;
    await client.query("ROLLBACK");
  } finally {
    await client.end();
  }

  // ── One row per charge day: the last tick of each (UTC month, window_days) ──
  type Day = {
    monthKey: string;
    k: number;
    tick: string;
    usage: number;
    base: number;
    fixed: number;
    dic: number;
    storedProjected: number | null;
    /** null on payloads written before FIX-1099's 3a deploy. */
    storedDivisor: number | null;
    shadow: SnapRow["shadow"];
    provenance: "stored" | "audit";
    /** Set on an audit row that has no real tick of its own. */
    note?: string;
  };
  const days = new Map<string, Day>();
  const cycles = new Map<string, { start: string; end: string }>();
  cycles.set(AUG_CYCLE.start, AUG_CYCLE);
  for (const s of snaps) {
    const vb = s.vb ?? {};
    const k = num(vb["window_days"]) ?? num(s.breakdown?.window_days);
    const usage = num(vb["usage_mtd_usd"]);
    const base = num(vb["plan_base_mtd_usd"]);
    if (!k || usage === null || base === null) continue;
    if (s.vcycle?.start && s.vcycle?.end) cycles.set(s.vcycle.start, { start: s.vcycle.start, end: s.vcycle.end });
    const monthKey = s.fetched_at.toISOString().slice(0, 7);
    const dic = num(vb["days_in_cycle"]) ?? daysInMonth(monthKey);
    const storedDivisor = num(vb["projection_divisor_days"]);
    // The breakdown's usd is PROJECTED with the row's own divisor; un-project it.
    const fixedProjected = (s.breakdown?.services ?? [])
      .filter((x) => x.service.trim().toLowerCase() === "speed insights plus events")
      .reduce((a, x) => a + (num(x.usd) ?? 0), 0);
    const fixed = (fixedProjected * (storedDivisor ?? k)) / dic;
    days.set(`${monthKey}|${k}`, {
      monthKey,
      k,
      tick: s.fetched_at.toISOString(),
      usage,
      base,
      fixed: r4(fixed),
      dic,
      storedProjected: num(vb["projected_usage_usd"]),
      storedDivisor,
      shadow: s.shadow,
      provenance: "stored",
    });
  }
  for (const a of AUDIT_AUGUST) {
    if (Date.parse(a.tick) < Date.parse(FROM)) continue;
    const key = `2026-08|${a.k}`;
    if (days.has(key)) continue; // a retained row always beats the audit's copy
    days.set(key, {
      monthKey: "2026-08",
      k: a.k,
      tick: a.tick,
      usage: (a.calProjected * a.k) / 31,
      base: (a.k * 20) / 31,
      fixed: a.k >= 15 ? AUG_FIXED : 0,
      dic: 31,
      storedProjected: a.calProjected,
      storedDivisor: null,
      shadow: null,
      provenance: "audit",
      ...(a.note ? { note: a.note } : {}),
    });
  }

  // ── Cumulative usage and fixed charges since the end of Aug 13 PDT ─────────
  const usageAt = (monthKey: string, k: number): number | null => {
    if (monthKey === "2026-08" && k === 14) return A14;
    return days.get(`${monthKey}|${k}`)?.usage ?? null;
  };
  const fixedAt = (monthKey: string, k: number): number | null => {
    if (monthKey === "2026-08" && k === 14) return 0;
    return days.get(`${monthKey}|${k}`)?.fixed ?? null;
  };
  /** Offset of each window against the Aug 13 origin: −A14 for August, then + each prior window's final value. */
  const offsets = (at: (m: string, k: number) => number | null, originAug: number) => {
    const out = new Map<string, number | null>([["2026-08", -originAug]]);
    let m = "2026-08";
    for (let i = 0; i < 6; i++) {
      const prev = out.get(m);
      const fin = at(m, daysInMonth(m));
      const n = nextMonth(m);
      out.set(n, prev === null || prev === undefined || fin === null ? null : prev + fin);
      m = n;
    }
    return out;
  };
  const usageOffsets = offsets(usageAt, A14);
  const fixedOffsets = offsets(fixedAt, 0);
  const cum = (d: string, at: (m: string, k: number) => number | null, offs: Map<string, number | null>) => {
    const { monthKey, k } = windowOf(d);
    const off = offs.get(monthKey);
    const v = at(monthKey, k);
    return off === null || off === undefined || v === null ? null : off + v;
  };

  const cycleList = [...cycles.values()].map((c) => ({ ...c, s: Date.parse(c.start), e: Date.parse(c.end) }));
  const cycleOf = (d: string) => {
    // The cycle containing day d's Pacific midnight (+1 h clears either offset).
    const probe = dayMs(d) + 8 * 3_600_000;
    const c = cycleList.find((x) => probe >= x.s && probe < x.e);
    if (!c) return null;
    return { c, cyc: vercelBillingCycle(c.s, c.e, new Date(probe)) };
  };

  // ── Build the replay rows ───────────────────────────────────────────────────
  const ordered = [...days.values()].sort((a, b) => Date.parse(a.tick) - Date.parse(b.tick));
  const rows: ReplayRow[] = [];
  let storedMatches = 0;
  let storedChecked = 0;
  const FLOORS = [5, 7, 10];
  for (const d of ordered) {
    const through = windowDay(d.monthKey, d.k);
    const calIn: Inputs = { usage: d.usage, base: d.base, fixed: Math.min(d.fixed, d.usage), windowDays: d.k, daysInCycle: d.dic };
    const calOld = compute(calIn, "old");
    const calNew = compute(calIn, "new");
    if (d.provenance === "stored" && d.storedDivisor === null && d.storedProjected !== null) {
      storedChecked++;
      if (Math.abs(calOld.projected_usage_usd - d.storedProjected) <= 0.005) storedMatches++;
    }

    let vendor: ReplayRow["vendor"] = null;
    let vprov: ReplayRow["provenance"]["vendor"] = "unavailable";
    const cy = cycleOf(through);
    if (cy) {
      const startDay = pacificDay(cy.c.s);
      const dayN = dayDiff(through, startDay) + 1;
      const cNow = cum(through, usageAt, usageOffsets);
      const cBefore = cum(addDays(startDay, -1), usageAt, usageOffsets);
      const fNow = cum(through, fixedAt, fixedOffsets);
      const fBefore = cum(addDays(startDay, -1), fixedAt, fixedOffsets);
      const recon = cNow !== null && cBefore !== null ? cNow - cBefore : null;
      const reconFixed = fNow !== null && fBefore !== null ? fNow - fBefore : null;
      const sh = d.shadow && !("error" in d.shadow) ? d.shadow : null;
      const shUsage = sh ? num(sh["usage_mtd_usd"]) : null;
      const shWd = sh ? num(sh["window_days"]) : null;
      const shFixed = sh ? num(sh["fixed_per_cycle_usd"]) : null;
      let usage: number | null = null;
      let wd = dayN;
      if (sh && shUsage !== null && shWd !== null) {
        usage = shUsage;
        wd = shWd;
        vprov = "shadow";
      } else if (recon !== null) {
        usage = recon;
        // Every Aug-cycle cycle-to-date rests on the audit's A14 (and, from
        // September, on its final August value); later cycles on retained rows.
        vprov = cy.c.start === AUG_CYCLE.start ? "audit" : "reconstructed";
      }
      if (usage !== null) {
        const fixed = Math.min(shFixed ?? reconFixed ?? 0, usage);
        const dic = cy.cyc.days_in_cycle;
        const venIn: Inputs = { usage, base: (wd * 20) / dic, fixed, windowDays: wd, daysInCycle: dic };
        vendor = {
          cycle_start: cy.c.start,
          cycle_end: cy.c.end,
          day: wd,
          inputs: { ...venIn, usage: r4(usage), base: r4(venIn.base), fixed: r4(fixed) },
          old: compute(venIn, "old"),
          new: compute(venIn, "new"),
          reconstruction_vs_shadow: vprov === "shadow" && recon !== null ? r4(recon - usage) : null,
        };
      }
    }

    const floors: ReplayRow["floors"] = {};
    for (const f of FLOORS) {
      const v = vendor ? compute(vendor.inputs, "new", f) : null;
      floors[String(f)] = {
        calendar: compute(calIn, "new", f).projected_usage_usd,
        vendor: v ? v.projected_usage_usd : null,
        vendor_status: v ? v.status.included_usage_usd : null,
      };
    }

    rows.push({
      tick: d.tick,
      ...(d.note ? { note: d.note } : {}),
      through,
      provenance: { calendar: d.provenance, vendor: vprov },
      calendar: { inputs: { ...calIn, usage: r4(calIn.usage), base: r4(calIn.base) }, stored_projected: d.storedProjected, old: calOld, new: calNew },
      vendor,
      floors,
    });
  }

  // ── Cycle ends: completed cycles decide criterion (i) and (iv) ──────────────
  const lastThrough = rows.length ? rows[rows.length - 1]!.through : FROM;
  const cycleEnds = cycleList.map((c) => {
    const endDay = addDays(pacificDay(c.e), -1);
    const completed = dayDiff(lastThrough, endDay) >= 0;
    const endRow = rows.find((r) => r.vendor?.cycle_start === c.start && r.through === endDay);
    const latest = [...rows].reverse().find((r) => r.vendor?.cycle_start === c.start);
    return {
      start: c.start,
      end: c.end,
      completed,
      end_usage: completed && endRow?.vendor ? endRow.vendor.inputs.usage : null,
      usage_so_far: latest?.vendor?.inputs.usage ?? null,
    };
  });
  const cycleEndOf = (start: string) => cycleEnds.find((c) => c.start === start)!;

  // ── The criteria, for any floor ─────────────────────────────────────────────
  const evaluate = (floor: number) => {
    const ven = rows.map((r) => (r.vendor ? compute(r.vendor.inputs, "new", floor) : null));
    const cal = rows.map((r) => compute(r.calendar.inputs, "new", floor));
    const i: string[] = [];
    const iProvisional: string[] = [];
    rows.forEach((r, ix) => {
      const v = ven[ix];
      if (!r.vendor || !v || v.status.included_usage_usd !== "critical") return;
      const ce = cycleEndOf(r.vendor.cycle_start);
      if (ce.completed && ce.end_usage !== null && ce.end_usage <= CREDIT) i.push(`${r.through} ($${r2(v.projected_usage_usd)}, d${r.vendor.day})`);
      if (!ce.completed && (ce.usage_so_far ?? 0) <= CREDIT) iProvisional.push(`${r.through} ($${r2(v.projected_usage_usd)}, d${r.vendor.day})`);
    });
    const ii: string[] = [];
    for (let ix = 1; ix < rows.length; ix++) {
      const a = ven[ix - 1];
      const b = ven[ix];
      if (!a || !b || dayDiff(rows[ix]!.through, rows[ix - 1]!.through) !== 1) continue;
      if (a.status.included_usage_usd === "healthy" && b.status.included_usage_usd === "critical") ii.push(rows[ix]!.through);
    }
    const iii: string[] = [];
    rows.forEach((r, ix) => {
      for (const m of ["billable_overage_usd", "overage_present"] as MetricKey[]) {
        if (r.calendar.old.status[m] !== cal[ix]!.status[m]) iii.push(`${r.through} calendar ${m}`);
        if (r.vendor && r.vendor.old.status[m] !== ven[ix]!.status[m]) iii.push(`${r.through} vendor ${m}`);
      }
    });
    const ivCandidates = rows.filter((r) => {
      if (!r.vendor || r.calendar.old.status.included_usage_usd !== "critical") return false;
      const ce = cycleEndOf(r.vendor.cycle_start);
      return ce.completed && ce.end_usage !== null && ce.end_usage > CREDIT;
    });
    const iv = ivCandidates
      .filter((r) => ven[rows.indexOf(r)]?.status.included_usage_usd === "healthy")
      .map((r) => r.through);
    const d14Ix = rows.findIndex((r) => r.vendor?.cycle_start === AUG_CYCLE.start && r.vendor.day === 14);
    const d14 = d14Ix >= 0 ? rows[d14Ix]!.vendor! : null;
    const vOld = d14 ? d14.old.status.included_usage_usd : null;
    const vNew = d14Ix >= 0 ? ven[d14Ix]!.status.included_usage_usd : null;
    return {
      floor,
      i: { pass: i.length === 0, days: i, provisional: iProvisional },
      ii: { pass: ii.length === 0, days: ii },
      iii: { pass: iii.length === 0, days: iii },
      iv: { pass: iv.length === 0, vacuous: ivCandidates.length === 0, days: iv },
      v: {
        pass: vOld === "critical" && vNew !== "critical",
        old: d14 ? { usd: d14.old.projected_usage_usd, status: vOld } : null,
        new: d14Ix >= 0 ? { usd: ven[d14Ix]!.projected_usage_usd, status: vNew } : null,
      },
    };
  };
  const result = evaluate(MIN_PROJECTION_DAYS);
  const sweep = Array.from({ length: 21 }, (_, ix) => ix + 1).map((f) => {
    const e = evaluate(f);
    return { floor: f, all_pass: e.i.pass && e.ii.pass && e.iii.pass && e.iv.pass && e.v.pass, i: e.i.pass, ii: e.ii.pass, iii: e.iii.pass, iv: e.iv.pass, v: e.v.pass };
  });

  // ── Flip counts ─────────────────────────────────────────────────────────────
  const metrics: MetricKey[] = ["included_usage_usd", "billable_overage_usd", "overage_present"];
  const RANK: Record<Status, number> = { healthy: 0, warning: 1, critical: 2 };
  const flips = Object.fromEntries(
    metrics.map((m) => [
      m,
      {
        calendar_old_vs_new: rows.filter((r) => r.calendar.old.status[m] !== r.calendar.new.status[m]).length,
        vendor_old_vs_new: rows.filter((r) => r.vendor && r.vendor.old.status[m] !== r.vendor.new.status[m]).length,
        old_vendor_vs_calendar: rows.filter((r) => r.vendor && r.vendor.old.status[m] !== r.calendar.old.status[m]).length,
        new_vendor_vs_calendar: rows.filter((r) => r.vendor && r.vendor.new.status[m] !== r.calendar.new.status[m]).length,
        new_vendor_more_severe: rows.filter((r) => r.vendor && RANK[r.vendor.new.status[m]] > RANK[r.calendar.new.status[m]]).length,
        new_vendor_less_severe: rows.filter((r) => r.vendor && RANK[r.vendor.new.status[m]] < RANK[r.calendar.new.status[m]]).length,
      },
    ]),
  );

  // ── Print ───────────────────────────────────────────────────────────────────
  const line = (name: string, c: { pass: boolean }, detail: string) =>
    console.info(`  ${c.pass ? "PASS" : "FAIL"}  (${name}) ${detail}`);
  console.info(`[fix1099-replay] prod read at ${readAt} (READ ONLY; ${snaps.length} snapshots → ${rows.length} charge days, ${FROM} … ${TO})`);
  console.info(`[fix1099-replay] calendar OLD reproduces prod's stored projection on ${storedMatches}/${storedChecked} pre-deploy rows`);
  console.info(`[fix1099-replay] floor ${MIN_PROJECTION_DAYS}:`);
  line("i", result.i, result.i.pass ? "no critical on a completed under-credit cycle" : `critical on ${result.i.days.join(", ")}`);
  if (result.i.provisional.length) console.info(`        provisional (cycle in progress): ${result.i.provisional.join(", ")}`);
  line("ii", result.ii, result.ii.pass ? "no healthy → critical jump" : `jumps on ${result.ii.days.join(", ")}`);
  line("iii", result.iii, result.iii.pass ? "billable_overage_usd and overage_present unchanged OLD vs NEW, both bases" : result.iii.days.join("; "));
  line("iv", result.iv, result.iv.vacuous ? "VACUOUS: no cycle in the window ended over the credit" : result.iv.days.join(", "));
  line(
    "v",
    result.v,
    `Aug 14 cycle d14: OLD $${r2(result.v.old?.usd ?? NaN)} ${result.v.old?.status} → NEW $${r2(result.v.new?.usd ?? NaN)} ${result.v.new?.status}`,
  );
  const passing = sweep.filter((s) => s.all_pass).map((s) => s.floor);
  console.info(`[fix1099-replay] floors 1-21 passing every criterion: ${passing.length ? passing.join(", ") : "none"}`);

  // ── Write ───────────────────────────────────────────────────────────────────
  const json = {
    generated_at: new Date().toISOString(),
    read_at: readAt,
    window: { from: FROM, to: TO },
    source: "prod public.platform_usage_snapshot + public.platform_limits (pro), one READ ONLY transaction",
    bands: BANDS,
    credit_usd: CREDIT,
    min_projection_days: MIN_PROJECTION_DAYS,
    audit_inputs: { A14, AUG_FIXED, AUG_CYCLE, AUDIT_AUGUST },
    stored_reproduction: { matches: storedMatches, checked: storedChecked },
    cycle_ends: cycleEnds,
    criteria: result,
    floor_sweep: sweep,
    flips,
    rows,
  };
  if (JSON_PATH) writeFileSync(JSON_PATH, JSON.stringify(json, null, 2) + "\n");
  if (MD_PATH) writeFileSync(MD_PATH, renderMd(json));
  if (JSON_PATH || MD_PATH) console.info(`[fix1099-replay] wrote ${[MD_PATH, JSON_PATH].filter(Boolean).join(" and ")}`);
}

// ── Markdown ──────────────────────────────────────────────────────────────────

type Json = {
  read_at: string;
  window: { from: string; to: string };
  bands: Record<MetricKey, Band>;
  credit_usd: number;
  min_projection_days: number;
  stored_reproduction: { matches: number; checked: number };
  cycle_ends: Array<{ start: string; end: string; completed: boolean; end_usage: number | null; usage_so_far: number | null }>;
  criteria: {
    i: { pass: boolean; days: string[]; provisional: string[] };
    ii: { pass: boolean; days: string[] };
    iii: { pass: boolean; days: string[] };
    iv: { pass: boolean; vacuous: boolean; days: string[] };
    v: { pass: boolean; old: { usd: number; status: Status | null } | null; new: { usd: number; status: Status | null } | null };
  };
  floor_sweep: Array<{ floor: number; all_pass: boolean; i: boolean; ii: boolean; iii: boolean; iv: boolean; v: boolean }>;
  flips: Record<string, Record<string, number>>;
  rows: ReplayRow[];
};

function renderMd(j: Json): string {
  const S: Record<Status, string> = { healthy: "H", warning: "**W**", critical: "**C**" };
  const cell = (c: Computed | undefined) => (c ? `$${r2(c.projected_usage_usd).toFixed(2)} ${S[c.status.included_usage_usd]}` : "—");
  const st = (c: Computed | undefined, m: MetricKey) => (c ? S[c.status[m]] : "—");
  const pf = (p: boolean) => (p ? "PASS" : "**FAIL**");
  const c = j.criteria;
  const out: string[] = [];
  out.push(`# FIX-1099 — alert-basis replay 2: options 1 + 2 on prod's own series (cc-175)`);
  out.push("");
  out.push(
    `Generated by \`packages/data/src/scripts/fix1099-replay-alert-bases.ts\` (cc-175 D6). Prod \`platform_usage_snapshot\` and \`platform_limits\` (pro) read at **${j.read_at}** in one READ ONLY transaction. Window ${j.window.from} → ${j.window.to}. The arithmetic is \`computeVercelBilling\`, \`vercelBillingCycle\`, \`computeMetricPercents\` and \`computeMetricStatus\` from \`@civitics/db\`, the code the snapshot runs. Calendar OLD reproduces prod's stored projection on **${j.stored_reproduction.matches}/${j.stored_reproduction.checked}** pre-deploy rows. The machine-readable copy, with the floor-5 and floor-10 columns, is the \`.json\` beside this file.`,
  );
  out.push("");
  out.push(
    `**Inputs.** The fixed per-cycle term (option 1) comes from \`vercel_breakdown\`'s \`Speed Insights Plus Events\` line on the calendar basis. That line is separable on every retained row (un-projected with the row's own divisor), so option 1 needed no reconstruction on the live path. August's rows, the A14 anchor and Aug 14's $0.65 are cc-168's (docs/audits/2026-09-28-fix1099-alert-replay.md), because they are older than the 30-day retention. A vendor cycle-to-date is \`shadow\` where the snapshot computed it live (from 2026-09-28 01:30Z). Before that it is differences of the cumulative calendar usage, and the script cross-checks that reconstruction against the shadow wherever both exist (\`reconstruction_vs_shadow\` in the json).`,
  );
  out.push("");
  out.push(`## Result at floor ${j.min_projection_days} (MIN_PROJECTION_DAYS)`);
  out.push("");
  out.push(`| criterion | verdict | detail |`);
  out.push(`|---|---|---|`);
  out.push(`| (i) no vendor-NEW critical on a completed cycle that ended at or under the credit | ${pf(c.i.pass)} | ${c.i.days.join(", ") || "none"}${c.i.provisional.length ? `; provisional, cycle in progress: ${c.i.provisional.join(", ")}` : ""} |`);
  out.push(`| (ii) no single-day healthy → critical on vendor-NEW | ${pf(c.ii.pass)} | ${c.ii.days.join(", ") || "none"} |`);
  out.push(`| (iii) billable_overage_usd and overage_present identical OLD vs NEW, both bases | ${pf(c.iii.pass)} | ${c.iii.days.join("; ") || "identical on every day"} |`);
  out.push(`| (iv) vendor-NEW never healthy where calendar-OLD was critical on a cycle that ended over the credit | ${c.iv.vacuous ? "vacuous" : pf(c.iv.pass)} | ${c.iv.vacuous ? "no cycle in the window ended over the credit" : c.iv.days.join(", ") || "none"} |`);
  out.push(`| (v) Aug 14 cycle day 14: OLD critical, NEW not | ${pf(c.v.pass)} | OLD $${r2(c.v.old?.usd ?? NaN)} ${c.v.old?.status} → NEW $${r2(c.v.new?.usd ?? NaN)} ${c.v.new?.status} |`);
  out.push("");
  const passing = j.floor_sweep.filter((s) => s.all_pass).map((s) => s.floor);
  out.push(
    `**Floor sweep, 1–21:** the floors that pass every criterion are ${passing.length ? passing.join(", ") : "**none**"}. Per floor and criterion:`,
  );
  out.push("");
  out.push(`| floor | (i) | (ii) | (iii) | (iv) | (v) |`);
  out.push(`|---:|---|---|---|---|---|`);
  for (const s of j.floor_sweep.filter((x) => [1, 3, 5, 7, 10, 14, 15, 17, 18, 21].includes(x.floor))) {
    out.push(`| ${s.floor} | ${s.i ? "pass" : "FAIL"} | ${s.ii ? "pass" : "FAIL"} | ${s.iii ? "pass" : "FAIL"} | ${s.iv ? "pass" : "FAIL"} | ${s.v ? "pass" : "FAIL"} |`);
  }
  out.push("");
  out.push(`## Bands (prod \`platform_limits\`, plan pro)`);
  out.push("");
  out.push(`| row | included_limit | warning_pct | critical_pct | fed by |`);
  out.push(`|---|---:|---:|---:|---|`);
  out.push(`| \`vercel.included_usage_usd\` | ${j.bands.included_usage_usd.included_limit} | ${j.bands.included_usage_usd.warning_pct} | ${j.bands.included_usage_usd.critical_pct} | \`projected_usage_usd\` |`);
  out.push(`| \`vercel.billable_overage_usd\` | ${j.bands.billable_overage_usd.included_limit} | ${j.bands.billable_overage_usd.warning_pct} | ${j.bands.billable_overage_usd.critical_pct} | \`projected_billable_overage_usd\` |`);
  out.push(`| \`vercel.overage_present\` | ${j.bands.overage_present.included_limit} | ${j.bands.overage_present.warning_pct} | ${j.bands.overage_present.critical_pct} | \`billable_overage_mtd_usd > 0\` (actual) |`);
  out.push("");
  out.push(`## Vendor cycles in the window`);
  out.push("");
  out.push(`| cycle | completed | usage at cycle end | usage so far |`);
  out.push(`|---|---|---:|---:|`);
  for (const ce of j.cycle_ends) {
    out.push(`| ${ce.start.slice(0, 10)} → ${ce.end.slice(0, 10)} | ${ce.completed ? "yes" : "no"} | ${ce.end_usage === null ? "—" : `$${r2(ce.end_usage).toFixed(2)}`} | ${ce.usage_so_far === null ? "—" : `$${r2(ce.usage_so_far).toFixed(2)}`} |`);
  }
  out.push("");
  out.push(`## Flips (days whose state differs)`);
  out.push("");
  out.push(`| row | calendar OLD→NEW | vendor OLD→NEW | OLD vendor vs calendar | NEW vendor vs calendar | NEW vendor more severe | NEW vendor less severe |`);
  out.push(`|---|---:|---:|---:|---:|---:|---:|`);
  for (const [m, f] of Object.entries(j.flips)) {
    out.push(`| \`${m}\` | ${f["calendar_old_vs_new"]} | ${f["vendor_old_vs_new"]} | ${f["old_vendor_vs_calendar"]} | ${f["new_vendor_vs_calendar"]} | ${f["new_vendor_more_severe"]} | ${f["new_vendor_less_severe"]} |`);
  }
  out.push("");
  out.push(`## The table`);
  out.push("");
  out.push(
    "`included_usage_usd` projection and band (H healthy, **W** warning, **C** critical) under each arithmetic. `billable_overage_usd` and `overage_present` are given as four states each, in the order cal OLD/NEW, ven OLD/NEW. Provenance is calendar/vendor: `stored`, `audit`, `shadow` or `reconstructed` (see the script header).",
  );
  out.push("");
  out.push(`| last tick (UTC) | through (PDT) | provenance | cal day | ven day | cal OLD | cal NEW | ven OLD | ven NEW | billable_overage | overage_present |`);
  out.push(`|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of j.rows) {
    const v = r.vendor;
    out.push(
      `| ${r.note ? `— (${r.note})` : r.tick.slice(5, 16).replace("T", " ")} | ${r.through.slice(5)} | ${r.provenance.calendar}/${r.provenance.vendor} | ${r.calendar.inputs.windowDays}/${r.calendar.inputs.daysInCycle} | ${v ? `${v.cycle_start.slice(5, 10)} d${v.day}/${v.inputs.daysInCycle}` : "—"} | ${cell(r.calendar.old)} | ${cell(r.calendar.new)} | ${cell(v?.old)} | ${cell(v?.new)} | ${st(r.calendar.old, "billable_overage_usd")}${st(r.calendar.new, "billable_overage_usd")}${st(v?.old, "billable_overage_usd")}${st(v?.new, "billable_overage_usd")} | ${st(r.calendar.old, "overage_present")}${st(r.calendar.new, "overage_present")}${st(v?.old, "overage_present")}${st(v?.new, "overage_present")} |`,
    );
  }
  out.push("");
  return out.join("\n");
}

main().catch((err: unknown) => {
  console.error(`[fix1099-replay] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(2);
});
