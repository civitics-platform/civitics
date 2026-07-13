/**
 * Phase 4 anchor verification — READ-ONLY.
 *
 * Runs after the forced-Sunday cron wrapper completes. Pulls every anchor
 * case in docs/audits/cron_run_2026-05-12.md Phase 4 list and prints results
 * in a single block for paste into the audit doc.
 */

import { createAdminClient } from "@civitics/db";
import { selectDirect } from "../lib/heavy-rebuild";

// FIX-511 count-site triage (per-site rationale in the FIX-511 commit body):
//   - numbers compared against a magnitude anchor ("~1889", "rows present")
//     → count: 'estimated' (exact ≤ max_rows, planner estimate above — no scan)
//   - genuine per-group breakdowns (FR by source / by relationship_type)
//     → one direct-pg GROUPING SETS scan (selectDirect) instead of N counts
//   - selective indexed lookups (America-PAC chain) → exact counts stay
//   - count options never read by the code → dropped

function fmt$(cents: number | string | null | undefined): string {
  const c = typeof cents === "string" ? Number(cents) : (cents ?? 0);
  if (!Number.isFinite(c)) return "n/a";
  return "$" + Math.round(c / 100).toLocaleString();
}

// Local mirror of apps/civitics/src/lib/paginate.ts fetchAllRows (packages/data
// can't import from apps). Pages a row-capped PostgREST query past the
// max_rows=1000 ceiling so the full set is summed rather than silently
// truncated. `build` must apply .range(from,to) on a FRESH query carrying a
// stable total .order() each call. FIX-476 follow-up — the Wave-1 sweep didn't
// reach this read-only anchor-verify script (the prior .limit(5000)/.limit(2000)
// were capped to 1000 by PostgREST, undercounting high-volume anchors).
const PAGE_SIZE = 1000;
async function fetchAllRows<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await build(from, from + PAGE_SIZE - 1);
    if (error) { console.warn("    fetchAllRows page error:", error.message); break; }
    const batch = data ?? [];
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
  }
  return rows;
}

async function section(title: string, fn: () => Promise<void>): Promise<void> {
  console.log("\n" + "─".repeat(72));
  console.log(title);
  console.log("─".repeat(72));
  try { await fn(); } catch (e) { console.error("  ERROR:", e instanceof Error ? e.message : String(e)); }
}

async function main(): Promise<void> {
  const db = createAdminClient();

  await section("DONOR — Elon Musk", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: ents } = await (db as any).from("financial_entities")
      .select("id, display_name, canonical_name, entity_type, total_donated_cents, metadata")
      .ilike("display_name", "%MUSK%ELON%")
      .or("display_name.ilike.%ELON%MUSK%")
      .limit(10);
    console.log("  matching financial_entities (LIKE %MUSK%ELON% or %ELON%MUSK%):");
    for (const e of (ents ?? [])) console.log(`    [${e.id}] display_name="${e.display_name}" canonical="${e.canonical_name}" type=${e.entity_type} total=${fmt$(e.total_donated_cents)}`);

    if (!ents || ents.length === 0) return;
    const muskIds = ents.map((e: { id: string }) => e.id);

    // Donations FROM musk to anything
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: outs, error: outErr } = await (db as any).from("financial_relationships")
      .select("relationship_type, to_type, to_id, amount_cents, cycle_year, source:metadata->>source")
      .in("from_id", muskIds)
      .order("amount_cents", { ascending: false })
      .limit(20);
    if (outErr) { console.log("  outflow query failed:", outErr.message); return; }
    console.log(`  outflow relationships (top 20 by amount):`);
    let total = 0;
    for (const r of (outs ?? [])) {
      total += Number(r.amount_cents ?? 0);
      console.log(`    type=${r.relationship_type} to_type=${r.to_type} to_id=${r.to_id} cycle=${r.cycle_year} src=${r.source} ${fmt$(r.amount_cents)}`);
    }
    console.log(`  sum-of-top-20: ${fmt$(total)}`);

    // Aggregate outflow by relationship_type.
    // PostgREST can't group; pull ALL rows for the entity and sum client-side,
    // paged past max_rows=1000 (FIX-476) so the aggregate isn't truncated.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allOut = await fetchAllRows<any>((from, to) => (db as any).from("financial_relationships")
      .select("relationship_type, source:metadata->>source, amount_cents")
      .in("from_id", muskIds)
      .order("id", { ascending: true })
      .range(from, to));
    const byType: Record<string, { count: number; sum: number }> = {};
    for (const r of allOut) {
      const k = `${r.relationship_type}:${r.source ?? "-"}`;
      if (!byType[k]) byType[k] = { count: 0, sum: 0 };
      byType[k].count++;
      byType[k].sum += Number(r.amount_cents ?? 0);
    }
    console.log(`  total outflow rows (full, paged): ${allOut.length}`);
    for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].sum - a[1].sum)) {
      console.log(`    ${k.padEnd(50)} count=${v.count.toString().padStart(5)} sum=${fmt$(v.sum)}`);
    }
  });

  await section("DONOR — Elizabeth Simons → DCCC (FIX-236 anchor, expect ~$522K)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: ents } = await (db as any).from("financial_entities")
      .select("id, display_name, total_donated_cents")
      .or("display_name.ilike.%SIMONS%ELIZABETH%,display_name.ilike.%ELIZABETH%SIMONS%")
      .limit(10);
    console.log(`  matching donor entities: ${(ents ?? []).length}`);
    for (const e of (ents ?? [])) console.log(`    [${e.id}] display_name="${e.display_name}" total=${fmt$(e.total_donated_cents)}`);

    if (!ents || ents.length === 0) return;
    const ids = ents.map((e: { id: string }) => e.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: dccc } = await (db as any).from("financial_entities")
      .select("id, display_name")
      .or("display_name.ilike.%DCCC%,display_name.ilike.%DEMOCRATIC CONGRESSIONAL CAMPAIGN%")
      .limit(10);
    console.log(`  DCCC candidate entities: ${(dccc ?? []).length}`);
    for (const e of (dccc ?? [])) console.log(`    [${e.id}] display_name="${e.display_name}"`);

    const dcccIds = (dccc ?? []).map((e: { id: string }) => e.id);
    if (dcccIds.length === 0) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: rels } = await (db as any).from("financial_relationships")
      .select("relationship_type, source:metadata->>source, amount_cents, cycle_year, to_id")
      .in("from_id", ids)
      .in("to_id", dcccIds);
    let sum = 0;
    for (const r of (rels ?? [])) sum += Number(r.amount_cents ?? 0);
    console.log(`  Simons → DCCC: ${(rels ?? []).length} relationships, total=${fmt$(sum)}`);
    for (const r of (rels ?? [])) console.log(`    type=${r.relationship_type} src=${r.source} cycle=${r.cycle_year} ${fmt$(r.amount_cents)}`);
  });

  await section("DONOR — Jon Stryker → DCCC (FIX-236 anchor, expect ~$310K)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: ents } = await (db as any).from("financial_entities")
      .select("id, display_name, total_donated_cents")
      .or("display_name.ilike.%STRYKER%JON%,display_name.ilike.%JON%STRYKER%")
      .limit(10);
    console.log(`  matching donor entities: ${(ents ?? []).length}`);
    for (const e of (ents ?? [])) console.log(`    [${e.id}] display_name="${e.display_name}" total=${fmt$(e.total_donated_cents)}`);
    if (!ents || ents.length === 0) return;
    const ids = ents.map((e: { id: string }) => e.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: dccc } = await (db as any).from("financial_entities")
      .select("id, display_name")
      .or("display_name.ilike.%DCCC%,display_name.ilike.%DEMOCRATIC CONGRESSIONAL CAMPAIGN%")
      .limit(10);
    const dcccIds = (dccc ?? []).map((e: { id: string }) => e.id);
    if (dcccIds.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: rels } = await (db as any).from("financial_relationships")
      .select("relationship_type, source:metadata->>source, amount_cents, cycle_year")
      .in("from_id", ids)
      .in("to_id", dcccIds);
    let sum = 0;
    for (const r of (rels ?? [])) sum += Number(r.amount_cents ?? 0);
    console.log(`  Stryker → DCCC: ${(rels ?? []).length} relationships, total=${fmt$(sum)}`);
  });

  await section("DONOR — Stephen Schwarzman (FIX-239 dedup — expect ONE row)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: ents } = await (db as any).from("financial_entities")
      .select("id, display_name, canonical_name, donor_fingerprint, total_donated_cents")
      .ilike("display_name", "%SCHWARZMAN%")
      .limit(20);
    console.log(`  Schwarzman entities: ${(ents ?? []).length}`);
    for (const e of (ents ?? [])) console.log(`    [${e.id}] display_name="${e.display_name}" canonical="${e.canonical_name}" fp="${e.donor_fingerprint}" total=${fmt$(e.total_donated_cents)}`);
  });

  await section("DONOR — high-volume small-donor THOMPSON (FIX-236 anchor — 1,889 matches)", async () => {
    // FIX-511: magnitude anchor — estimated count. The ilike on individual
    // donors can't use the partial trgm index (entity_type <> 'individual'),
    // so an exact count was a full seq scan of financial_entities.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count, error } = await (db as any).from("financial_entities")
      .select("id", { count: "estimated", head: true })
      .ilike("display_name", "THOMPSON,%");
    console.log(`  entities with display_name starting THOMPSON, (estimated): ${count} (expected ~1889)`);
    if (error) console.log("  error:", error.message);

    // pick one and confirm it resolves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: sample } = await (db as any).from("financial_entities")
      .select("id, display_name, canonical_name, total_donated_cents")
      .ilike("display_name", "THOMPSON,%")
      .gt("total_donated_cents", 50000)
      .order("total_donated_cents", { ascending: false })
      .limit(5);
    console.log("  top THOMPSON donors by total_donated_cents:");
    for (const e of (sample ?? [])) console.log(`    [${e.id}] display_name="${e.display_name}" total=${fmt$(e.total_donated_cents)}`);
  });

  await section("DONOR — apostrophe surnames (FIX-244 + FIX-245)", async () => {
    for (const surname of ["O'BRIEN", "O'CONNOR", "D'ANGELO", "D'AMICO"]) {
      // FIX-511: boolean-presence anchor ("apostrophe surnames exist and are
      // unmangled") — the LIMIT 3 sample IS the existence probe; the prior
      // exact count was a full ilike scan whose number nobody compared.
      // (count:'estimated' is not an option here: the hosted PostgREST 500s on
      // EXPLAIN-based counts when the filter value contains an apostrophe.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
      const { data: sample } = await (db as any).from("financial_entities")
        .select("id, display_name, canonical_name")
        .ilike("display_name", `${surname},%`)
        .limit(3);
      console.log(`  ${surname},*  present: ${(sample ?? []).length > 0 ? "yes" : "NO — anchor missing"}`);
      for (const e of (sample ?? [])) console.log(`    sample: display_name="${e.display_name}" canonical="${e.canonical_name}"`);
    }
  });

  await section("RECIPIENT — Donald Trump (tier='candidate' or 'elected'; FIX-240 IE inflow)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: off } = await (db as any).from("officials")
      .select("id, full_name, tier, party, role_title, source_ids")
      .or("full_name.ilike.%DONALD%TRUMP%,full_name.ilike.%TRUMP%DONALD%")
      .limit(10);
    console.log(`  matching officials: ${(off ?? []).length}`);
    for (const o of (off ?? [])) console.log(`    [${o.id}] name="${o.full_name}" tier=${o.tier} party=${o.party} role="${o.role_title}" fec=${o.source_ids?.fec_candidate_id ?? "-"}`);

    if (!off || off.length === 0) return;
    const ids = off.map((o: { id: string }) => o.id);

    // Paged past max_rows=1000 (FIX-476) so the inflow aggregate is complete.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ins = await fetchAllRows<any>((from, to) => (db as any).from("financial_relationships")
      .select("relationship_type, source:metadata->>source, amount_cents, cycle_year")
      .in("to_id", ids)
      .eq("to_type", "official")
      .order("id", { ascending: true })
      .range(from, to));
    const byType: Record<string, { count: number; sum: number }> = {};
    for (const r of ins) {
      const k = `${r.relationship_type}:${r.source ?? "-"}`;
      if (!byType[k]) byType[k] = { count: 0, sum: 0 };
      byType[k].count++;
      byType[k].sum += Number(r.amount_cents ?? 0);
    }
    console.log(`  inflow rows: ${ins.length}`);
    for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].sum - a[1].sum)) {
      console.log(`    ${k.padEnd(50)} count=${v.count.toString().padStart(5)} sum=${fmt$(v.sum)}`);
    }
  });

  await section("RECIPIENT — JD Vance (FIX-247 'J D' parsing — should NOT duplicate)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: off } = await (db as any).from("officials")
      .select("id, full_name, tier, party, role_title, source_ids")
      .or("full_name.ilike.%VANCE%J%,full_name.ilike.%VANCE,%J%")
      .limit(10);
    console.log(`  Vance officials: ${(off ?? []).length}`);
    for (const o of (off ?? [])) console.log(`    [${o.id}] name="${o.full_name}" tier=${o.tier} party=${o.party} fec=${o.source_ids?.fec_candidate_id ?? "-"}`);
  });

  await section("RECIPIENT — Senate Majority PAC inflow (FIX-240 IE)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: ents } = await (db as any).from("financial_entities")
      .select("id, display_name, fec_committee_id")
      .ilike("display_name", "%SENATE MAJORITY PAC%")
      .limit(5);
    console.log(`  SMP entities: ${(ents ?? []).length}`);
    for (const e of (ents ?? [])) console.log(`    [${e.id}] display_name="${e.display_name}" fec_cmte=${e.fec_committee_id ?? "-"}`);

    // ie_support / ie_oppose total rows in prod
    // FIX-511: magnitude display — estimated; the exact per-type numbers come
    // from the GROUPING SETS breakdown section below in the same run.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count: ieS } = await (db as any).from("financial_relationships").select("id", { count: "estimated", head: true }).eq("relationship_type", "ie_support");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count: ieO } = await (db as any).from("financial_relationships").select("id", { count: "estimated", head: true }).eq("relationship_type", "ie_oppose");
    console.log(`  global ie_support rows (estimated): ${ieS}`);
    console.log(`  global ie_oppose rows (estimated):  ${ieO}`);
  });

  await section("CONNECTION GRAPH — entity_connections totals + Musk/America-PAC chain", async () => {
    // FIX-511: magnitude display — estimated instead of an exact full count.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count: total } = await (db as any).from("entity_connections").select("id", { count: "estimated", head: true });
    console.log(`  entity_connections total rows (estimated): ${total}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // reads-ok: anchor-verify report read — an empty result renders visibly as a missing anchor in the cron output
    const { data: ap } = await (db as any).from("financial_entities")
      .select("id, display_name")
      .ilike("display_name", "%AMERICA PAC%")
      .limit(5);
    for (const e of (ap ?? [])) console.log(`    America PAC: [${e.id}] display_name="${e.display_name}"`);

    const apIds = (ap ?? []).map((e: { id: string }) => e.id);
    if (apIds.length > 0) {
      // FIX-511 triage: exact counts STAY here — both are selective indexed
      // lookups on specific to_id/from_id values (cheap), and the precise
      // numbers are the Musk→America-PAC chain anchor.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count: muskIn } = await (db as any).from("entity_connections")
        .select("id", { count: "exact", head: true })
        .in("to_id", apIds)
        .eq("connection_type", "donation");
      console.log(`  donations INTO America PAC (entity_connections): ${muskIn}`);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count: apOut } = await (db as any).from("entity_connections")
        .select("id", { count: "exact", head: true })
        .in("from_id", apIds)
        .eq("connection_type", "donation");
      console.log(`  donations OUT of America PAC (entity_connections, includes ie_support fold-in): ${apOut}`);
    }
  });

  await section("FR source breakdown (FIX-236 indiv-to-committee, FIX-240 ie_*)", async () => {
    // FIX-511: genuine per-group breakdown — one GROUPING SETS scan via direct
    // pg replaces 12 sequential PostgREST exact head-counts over the
    // multi-million-row table (common relationship_type values plan seq scans
    // — FIX-345). NOTE: `source` is a metadata JSONB key, NOT a column — the
    // prior `.eq("source", …)` loop silently printed a 42703 error per source,
    // so this also restores the source axis. grouping() flags disambiguate
    // "grouped by source, type collapsed" from a genuine NULL source value.
    const rows = await selectDirect<{
      source: string | null;
      relationship_type: string | null;
      n: string;
      g_source: number;
      g_type: number;
    }>(`
      SELECT metadata->>'source' AS source, relationship_type, count(*) AS n,
             grouping(metadata->>'source') AS g_source,
             grouping(relationship_type)   AS g_type
        FROM financial_relationships
       GROUP BY GROUPING SETS ((metadata->>'source'), (relationship_type))
       ORDER BY 1 NULLS LAST, 2 NULLS LAST`);
    for (const r of rows.filter((r) => r.g_source === 0)) {
      console.log(`  source=${(r.source ?? "(null)").padEnd(35)} count=${r.n}`);
    }
    for (const r of rows.filter((r) => r.g_type === 0)) {
      console.log(`  type=${(r.relationship_type ?? "(null)").padEnd(15)}  count=${r.n}`);
    }
  });

  await section("SEARCH — pg_trgm canonical_name (FIX-238 known-issue checkpoint)", async () => {
    for (const q of ["elon musk", "elon", "musk", "JD Vance", "Schwarzman", "STRYKER"]) {
      // FIX-511: magnitude display — estimated; the exact match total of an
      // unanchored ilike over financial_entities was a full scan per query.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error, count } = await (db as any).from("financial_entities")
        .select("id, display_name, canonical_name", { count: "estimated" })
        .ilike("canonical_name", `%${q.toLowerCase()}%`)
        .limit(3);
      if (error) console.log(`  q="${q.padEnd(15)}"  error: ${error.message}`);
      else {
        console.log(`  q="${q.padEnd(15)}" matches≈${count} examples:`);
        for (const r of (data ?? [])) console.log(`    [${r.id}] display_name="${r.display_name}" canonical="${r.canonical_name}"`);
      }
    }
  });

  setTimeout(() => process.exit(0), 250);
}

main().catch((e) => {
  console.error("anchor verify failed:", e instanceof Error ? e.stack : String(e));
  setTimeout(() => process.exit(1), 250);
});
