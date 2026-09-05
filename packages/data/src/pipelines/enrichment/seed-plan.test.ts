// FIX-1158 regression tests — seed-backlog cannot enqueue individuals unless
// told to, and always counts before it writes.
//
// The bug these pin: the financial-entity arm's DEFAULT population was every
// financial_entity, which on prod is 5,204,854 rows of which 4,975,895 are
// individuals — and since no individual carries an industry tag, every one of
// them qualified for the queue. One mistyped invocation of a manual script
// would have staged ~4.98M rows of downstream model calls.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  financialEntityPopulation,
  parseMaxEnqueue,
  ceilingVerdict,
  formatPlanTable,
  DEFAULT_MAX_ENQUEUE,
} from "./seed-plan";

describe("FIX-1158 — the financial-entity population predicate", () => {
  it("EXCLUDES individuals by default", () => {
    const pop = financialEntityPopulation({ pacsOnly: false, allFinancialEntities: false });
    assert.deepEqual(pop, { kind: "exclude_individuals", excludedEntityType: "individual" });
  });

  it("--pacs-only still narrows to PAC + party_committee", () => {
    const pop = financialEntityPopulation({ pacsOnly: true, allFinancialEntities: false });
    assert.deepEqual(pop, { kind: "pacs_only", entityTypes: ["pac", "party_committee"] });
  });

  it("individuals come back ONLY with the explicit opt-in", () => {
    const pop = financialEntityPopulation({ pacsOnly: false, allFinancialEntities: true });
    assert.deepEqual(pop, { kind: "all" });
  });

  it("--pacs-only wins over --all-financial-entities (the narrower ask)", () => {
    const pop = financialEntityPopulation({ pacsOnly: true, allFinancialEntities: true });
    assert.equal(pop.kind, "pacs_only");
  });
});

describe("FIX-1158 — the --max-enqueue ceiling", () => {
  it("defaults to 50,000", () => {
    assert.equal(parseMaxEnqueue(["node", "seed-backlog.ts"]), DEFAULT_MAX_ENQUEUE);
    assert.equal(DEFAULT_MAX_ENQUEUE, 50_000);
  });

  it("takes an explicit value", () => {
    assert.equal(parseMaxEnqueue(["--max-enqueue", "250000"]), 250_000);
    assert.equal(parseMaxEnqueue(["--dry-run", "--max-enqueue", "0"]), 0);
  });

  it("refuses junk rather than silently falling back to the default", () => {
    assert.throws(() => parseMaxEnqueue(["--max-enqueue", "lots"]), /non-negative number/);
    assert.throws(() => parseMaxEnqueue(["--max-enqueue", "-1"]), /non-negative number/);
    assert.throws(() => parseMaxEnqueue(["--max-enqueue"]), /non-negative number/);
    // The next flag is not a value.
    assert.throws(() => parseMaxEnqueue(["--max-enqueue", "--force"]), /non-negative number/);
  });

  it("refuses a plan over the ceiling, and passes one at or under it", () => {
    assert.equal(ceilingVerdict(50_001, 50_000, false), "refuse");
    assert.equal(ceilingVerdict(50_000, 50_000, false), "ok");
    assert.equal(ceilingVerdict(0, 50_000, false), "ok");
  });

  it("the 4.98M-individual run is exactly what it refuses", () => {
    assert.equal(ceilingVerdict(4_975_895, DEFAULT_MAX_ENQUEUE, false), "refuse");
  });

  it("--force is the override", () => {
    assert.equal(ceilingVerdict(4_975_895, DEFAULT_MAX_ENQUEUE, true), "ok");
  });
});

describe("FIX-1158 — the pre-write plan table", () => {
  it("groups by entity_type + task_type + priority and totals", () => {
    const out = formatPlanTable([
      { entity_type: "financial_entity", task_type: "tag", priority: 100 },
      { entity_type: "financial_entity", task_type: "tag", priority: 100 },
      { entity_type: "financial_entity", task_type: "tag", priority: 40 },
      { entity_type: "proposal", task_type: "tag", priority: 0 },
    ]);
    assert.match(out, /financial_entity\s+tag\s+100\s+2/);
    assert.match(out, /financial_entity\s+tag\s+40\s+1/);
    assert.match(out, /proposal\s+tag\s+0\s+1/);
    assert.match(out, /TOTAL\s+4/);
  });

  it("says so rather than printing an empty table", () => {
    const out = formatPlanTable([]);
    assert.match(out, /\(nothing to enqueue\)/);
    assert.match(out, /TOTAL\s+0/);
  });

  it("thousands-separates so a seven-figure plan is legible at a glance", () => {
    const rows = Array.from({ length: 1500 }, () => ({
      entity_type: "financial_entity",
      task_type: "tag" as const,
      priority: 40,
    }));
    assert.match(formatPlanTable(rows), /1,500/);
  });
});
