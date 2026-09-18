/**
 * FIX-1074 / FIX-1165 — anchors for the shared FR-rewrite drain.
 *
 * Runs via:  tsx --test src/lib/fr-rewrite-drain.test.ts
 *
 * The FIX-1165 structural test guards the three remediation scripts against
 * executing a tail step they never declared. This extends the same guard to the
 * helper those scripts now delegate to, because the failure mode moved with the
 * code: a step added here is a step added to four callers at once.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";

import { declareDrainTail, drainFrRewrite, isCancellation } from "./fr-rewrite-drain";

const SRC = fs.readFileSync(path.join(__dirname, "fr-rewrite-drain.ts"), "utf8");

// ---------------------------------------------------------------------------
// The tail table
// ---------------------------------------------------------------------------

test("every declared step carries a cost class and, unless orphaned, an owner", () => {
  const steps = declareDrainTail(true);
  assert.ok(steps.length >= 17, `expected the full 17-step tail, got ${steps.length}`);
  for (const s of steps) {
    assert.ok(s.label.length > 0, "a step with no label cannot be reported");
    assert.ok(["manifest", "platform-owned", "platform-orphan"].includes(s.cls), `${s.label}: bad class`);
    if (s.cls === "platform-orphan") assert.equal(s.owner, null);
    else assert.ok(s.owner && s.owner.length > 0, `${s.label}: ${s.cls} must name an owner`);
  }
});

test("--defer-tails defers every platform-scoped step and no manifest-scoped one", () => {
  const steps = declareDrainTail(true);
  const platform = steps.filter((s) => s.cls !== "manifest");
  const manifest = steps.filter((s) => s.cls === "manifest");

  assert.ok(platform.length > 0 && manifest.length > 0, "the table must contain both classes");
  assert.ok(platform.every((s) => s.deferred), "a platform-scoped step must defer under --defer-tails");
  assert.ok(manifest.every((s) => !s.deferred), "a manifest-scoped step is the work; it never defers");
});

test("there is no scheduled owner missing from the tail's own claims", () => {
  // Every owner names a real prod job or pipeline. FIX-1165 found
  // refresh_group_donor_rollup() with none at all, which is why the field
  // exists; group-donor-rollup-refresh ran for the first time 2026-09-09 03:10.
  //
  // The names are now BARE job names: FIX-1193 reads the schedule out of
  // cron.job at print time instead of carrying it as a parenthetical, so an
  // exact-match assertion here is also the guard against the parenthetical
  // coming back.
  const owners = declareDrainTail(false)
    .filter((s) => s.cls === "platform-owned")
    .map((s) => s.owner!);
  assert.ok(owners.includes("group-donor-rollup-refresh"));
  assert.ok(owners.includes("fr-vacuum-analyze"));
});

// ---------------------------------------------------------------------------
// The boundary: the drain runs manifest-scoped work and nothing else
// ---------------------------------------------------------------------------

test("the drain never executes a platform-scoped step, flag or no flag", () => {
  // Source-read rather than mocked: the guarded property is that nobody adds a
  // `SELECT rebuild_something()` to this file, and a mock of drainFrRewrite
  // would not notice that.
  // Derivation functions only — a bare SELECT count(*) is a read, not a step.
  const executed = [...SRC.matchAll(/`SELECT ((?:rebuild|refresh|donor|financial|entity)\w*)\(/g)].map(
    (m) => m[1]!,
  );
  const allowed = new Set([
    "donor_rollup_rebuild_recipients",
    "financial_entity_donation_totals_rebuild",
    "donor_party_rollup_rebuild_donors",
  ]);
  for (const fn of executed) {
    assert.ok(
      allowed.has(fn),
      `fr-rewrite-drain.ts executes ${fn}(), which is not manifest-scoped. Every step ` +
        `here must scale with the manifest; a platform rebuild belongs to its scheduled ` +
        `owner (FIX-1165).`,
    );
  }
  assert.ok(executed.length >= 3, "the scan found fewer steps than exist — it has drifted");

  // The specific incident shapes, by name.
  for (const banned of [
    "rebuild_financial_entity_ie_totals",
    "refresh_group_donor_rollup",
    "rebuild_entity_search_index",
    "refresh_treemap_individuals_global",
  ]) {
    assert.doesNotMatch(
      SRC,
      new RegExp("`(?:SELECT|CALL) " + banned),
      `${banned} must not be executed by the shared drain`,
    );
  }
});

test("no VACUUM is issued from the drain (rule 41 / FIX-943's owners collect it)", () => {
  assert.doesNotMatch(SRC, /`VACUUM/);
});

test("the treemap's FIX-965 hazard cannot be reintroduced by a generic step loop", () => {
  // refresh_treemap_individuals_global() must never run under an armed
  // statement_timeout — the 2026-08-05 server-side cancellation of exactly that
  // step wedged prod for ~7 hours. The drain not running it at all is what makes
  // that impossible here, so this asserts the absence rather than the handling.
  assert.doesNotMatch(SRC, /treemap_global_budget_seconds/);
  assert.doesNotMatch(SRC, /refresh_treemap_individuals_global\(\)`/);
});

test("a cancellation is distinguished from an ordinary step failure", () => {
  assert.equal(isCancellation({ code: "57014" }), true);
  assert.equal(isCancellation({ code: "57P01" }), true);
  assert.equal(isCancellation({ code: "42883" }), false);
  assert.equal(isCancellation(new Error("boom")), false);
  assert.equal(isCancellation(null), false);
});

// ---------------------------------------------------------------------------
// Execution, against a fake client
// ---------------------------------------------------------------------------

function fakeClient(counts: { officials: number; donors: number }) {
  const sql: string[] = [];
  return {
    sql,
    query: async (text: string, _params?: unknown[]) => {
      sql.push(text);
      if (/count\(\*\)::text AS n FROM _affected/.test(text)) return { rows: [{ n: String(counts.officials) }] };
      if (/count\(\*\)::text AS n FROM _donor/.test(text)) return { rows: [{ n: String(counts.donors) }] };
      return { rows: [] };
    },
  };
}

test("a run with work does the three manifest-scoped steps and stops there", async () => {
  const c = fakeClient({ officials: 2, donors: 28 });
  const { ran, deferred } = await drainFrRewrite(
    c as never,
    { affectedTable: "_affected", affectedIdColumn: "official_id", donorTable: "_donor" },
    { prod: false, defer: true, printTable: false },
  );

  assert.deepEqual(ran, [
    "donor_rollup_rebuild_recipients(affected)",
    "financial_entity_donation_totals_rebuild",
    "donor_party_rollup_rebuild_donors",
  ]);
  assert.ok(deferred.length >= 14, `expected the platform tail deferred, got ${deferred.length}`);
  // The id column is a parameter because the three callers disagree on it.
  assert.ok(c.sql.some((s) => s.includes("SELECT official_id FROM _affected")));
});

test("FIX-964: an empty affected set skips the recipients call instead of no-op-ing it", async () => {
  const c = fakeClient({ officials: 0, donors: 0 });
  const { ran } = await drainFrRewrite(
    c as never,
    { affectedTable: "_affected", affectedIdColumn: "id", donorTable: "_donor" },
    { prod: false, defer: true, printTable: false },
  );
  // Post-commit the affected set can be unrecoverable. Calling the RPC with an
  // empty array and reading the no-op as success is the failure this prevents.
  assert.deepEqual(ran, []);
  assert.ok(!c.sql.some((s) => s.includes("donor_rollup_rebuild_recipients")));
});

test("the EC money-edge delete runs only when the landing deleted rows, and is keyed", async () => {
  const c = fakeClient({ officials: 1, donors: 1 });
  await drainFrRewrite(
    c as never,
    {
      affectedTable: "_affected",
      affectedIdColumn: "id",
      donorTable: "_donor",
      deletedFrRowIds: ["11111111-1111-1111-1111-111111111111"],
    },
    { prod: false, defer: true, printTable: false },
  );
  const del = c.sql.find((s) => s.includes("DELETE FROM public.entity_connections"));
  assert.ok(del, "the EC delete must run when rows were deleted");
  // Keyed on the deleted row ids, never on a global predicate — the 954:693 shape.
  assert.match(del!, /evidence_id = d\.fr_id/);
  assert.match(del!, /evidence_source = 'financial_relationships'/);
});

// ---------------------------------------------------------------------------
// The four callers
// ---------------------------------------------------------------------------

test("all four landing scripts delegate to the one drain", () => {
  const dir = path.join(__dirname, "..", "scripts");
  for (const f of [
    "remediate-role-ineligible-holders.ts",
    "remediate-cross-person-misattribution.ts",
    "merge-same-person-official-dupes.ts",
    "remediate-fec-emit-residue.ts",
  ]) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.ok(src.includes("drainFrRewrite("), `${f} must delegate to the shared drain`);
    // ...and must no longer carry its own copy of the manifest-scoped steps.
    assert.doesNotMatch(
      src,
      /`SELECT donor_rollup_rebuild_recipients\(/,
      `${f} still inlines donor_rollup_rebuild_recipients — the point of the helper is one copy`,
    );
  }
});
