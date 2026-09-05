// FIX-1041 regression tests — the cost record stops truncating itself, and a
// missing quantity says so instead of being inferred from a null.
//
// The two blind spots these pin were found by the 2026-08-15 traffic/cost-spike
// triage, i.e. by trying to USE the forensic instrument:
//
//   (1) vercel_breakdown.services was `.slice(0, 8)`. Measured on prod across
//       the whole 30-day retained window (927 snapshots, 2026-08-07..09-05),
//       jsonb_array_length was 8 on EVERY one — the cap was always binding,
//       never slack — while ten distinct services appeared over the window. A
//       line could vanish from the record purely by rank change, silently.
//   (2) Observability Events — the largest non-subscription line on this
//       account — maps to no Civitics metric, so cost was the only signal and
//       the audit could never state an event count or a unit.
//
// Service names and shapes below are the real ones observed on prod.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractFromCharges, parseChargesBody } from "./vercel-usage";

/** One FOCUS charge line, as billing/charges emits them (per day, per region). */
function line(
  service: string,
  effective: number,
  opts: { quantity?: number | null; unit?: string; day?: string } = {},
) {
  const l: Record<string, unknown> = {
    ServiceName: service,
    EffectiveCost: effective,
    BilledCost: 0,
    ChargePeriodStart: opts.day ?? "2026-09-04",
  };
  if (opts.quantity !== undefined) l["ConsumedQuantity"] = opts.quantity;
  if (opts.unit !== undefined) l["ConsumedUnit"] = opts.unit;
  return l;
}

/** The ten services actually seen on prod over 2026-08-07..09-05. */
const TEN_REAL_SERVICES = [
  line("Pro", 20.0),
  line("Observability Events", 11.0156, { quantity: 4_200_000, unit: "Events" }),
  line("Build CPU Minutes", 5.32, { quantity: 190, unit: "Minutes" }),
  line("ISR Writes", 3.2857, { quantity: 1_100_000, unit: "Writes" }),
  line("Fluid Provisioned Memory", 2.539, { quantity: 21.1, unit: "GB-Hours" }),
  line("Fluid Active CPU", 1.4751, { quantity: 0.41, unit: "Hours" }),
  line("Speed Insights Data Points", 1.3433, { quantity: 90_000, unit: "Data Points" }),
  line("Speed Insights Plus Events", 0.775, { quantity: 5_000, unit: "Events" }),
  line("Fast Origin Transfer", 0.4755, { quantity: 3.17, unit: "GB" }),
  line("Function Invocations", 0.0896, { quantity: 89_600, unit: "Invocations" }),
];

describe("FIX-1041 (1) — every non-zero line is kept", () => {
  it("persists MORE than 8 lines when more than 8 are billed", () => {
    const ex = extractFromCharges(TEN_REAL_SERVICES);
    assert.equal(ex.cost_breakdown.length, 10);
    assert.ok(ex.cost_breakdown.length > 8, "the old .slice(0, 8) would have cut this to 8");
  });

  it("keeps the two lines the old top-8 cap dropped", () => {
    const names = extractFromCharges(TEN_REAL_SERVICES).cost_breakdown.map((b) => b.service);
    // These two ranked 9th and 10th by cost — exactly the pair that used to
    // fall out of the stored payload with no error and no residual.
    assert.ok(names.includes("Fast Origin Transfer"));
    assert.ok(names.includes("Function Invocations"));
  });

  it("is still sorted by cost, descending", () => {
    const usd = extractFromCharges(TEN_REAL_SERVICES).cost_breakdown.map((b) => b.effective_usd);
    assert.deepEqual(usd, [...usd].sort((a, b) => b - a));
  });

  it("still drops genuinely zero-cost lines", () => {
    const ex = extractFromCharges([...TEN_REAL_SERVICES, line("Blob", 0, { quantity: 12 })]);
    assert.equal(ex.cost_breakdown.find((b) => b.service === "Blob"), undefined);
  });

  it("sums a service across its per-region leaves rather than listing it twice", () => {
    const ex = extractFromCharges([
      line("Fluid Provisioned Memory", 1.0, { quantity: 10, unit: "GB-Hours" }),
      line("Fluid Provisioned Memory", 1.5, { quantity: 15, unit: "GB-Hours" }),
    ]);
    assert.equal(ex.cost_breakdown.length, 1);
    assert.equal(ex.cost_breakdown[0]!.effective_usd, 2.5);
    assert.equal(ex.cost_breakdown[0]!.quantity, 25);
  });
});

describe("FIX-1041 (2) — the missing quantity is visible, not inferred", () => {
  it("Observability Events carries its quantity and unit when Vercel sends them", () => {
    const obs = extractFromCharges(TEN_REAL_SERVICES).cost_breakdown.find(
      (b) => b.service === "Observability Events",
    );
    assert.ok(obs);
    assert.equal(obs.quantity, 4_200_000);
    assert.equal(obs.unit, "Events");
    // It is metered, but it is not one of OUR metrics — that distinction is the
    // point, and the snapshot writer turns a null metric into a note on the card.
    assert.equal(obs.metric, null);
  });

  it("records quantity: null ONLY when the charge line has no ConsumedQuantity", () => {
    const ex = extractFromCharges([line("Observability Events", 11.0156)]);
    const obs = ex.cost_breakdown[0]!;
    assert.equal(obs.quantity, null, "absent ConsumedQuantity must stay null, not become 0");
    assert.equal(obs.unit, null);
  });

  it("a present-but-ZERO quantity is a measurement of zero, not 'unmeasured'", () => {
    const ex = extractFromCharges([line("Observability Events", 0.01, { quantity: 0, unit: "Events" })]);
    assert.equal(ex.cost_breakdown[0]!.quantity, 0);
    assert.notEqual(ex.cost_breakdown[0]!.quantity, null);
  });

  it("names the metric on lines we DO track", () => {
    const byName = new Map(
      extractFromCharges(TEN_REAL_SERVICES).cost_breakdown.map((b) => [b.service, b]),
    );
    assert.equal(byName.get("Fluid Provisioned Memory")!.metric, "fluid_memory_gb_hrs");
    assert.equal(byName.get("Fluid Active CPU")!.metric, "fluid_cpu_seconds");
    assert.equal(byName.get("Fast Origin Transfer")!.metric, "origin_transfer_bytes");
    assert.equal(byName.get("Function Invocations")!.metric, "function_invocations");
    assert.equal(byName.get("Build CPU Minutes")!.metric, "build_minutes");
  });

  it("ISR Writes is billed, metered, and NOT one of our metrics", () => {
    // Documenting live behaviour, not endorsing it: mapChargeQuantity checks
    // for "isr read" and prod bills "ISR Writes", so `isr_reads` receives 0
    // from a line costing ~$3.29/mo. Correcting that changes what an existing
    // platform_usage series means, so it is deliberately NOT done here — but it
    // is no longer invisible, because the quantity now rides on the line.
    const isr = extractFromCharges(TEN_REAL_SERVICES).cost_breakdown.find(
      (b) => b.service === "ISR Writes",
    );
    assert.ok(isr);
    assert.equal(isr.metric, null);
    assert.equal(isr.quantity, 1_100_000);
  });
});

describe("FIX-1041 (3) — window_days counts distinct billing days", () => {
  it("counts ChargePeriodStart days, not charge lines", () => {
    const ex = extractFromCharges([
      line("Fluid Active CPU", 1, { day: "2026-09-01" }),
      line("Fluid Active CPU", 1, { day: "2026-09-01" }), // second region, same day
      line("Fluid Active CPU", 1, { day: "2026-09-02" }),
    ]);
    assert.equal(ex.window_days, 2);
    assert.equal(ex.window_start, "2026-09-01");
    assert.equal(ex.window_end, "2026-09-02");
  });

  it("parses the JSONL body billing/charges actually returns", () => {
    const body = TEN_REAL_SERVICES.map((l) => JSON.stringify(l)).join("\n");
    assert.equal(extractFromCharges(parseChargesBody(body)).cost_breakdown.length, 10);
  });
});
