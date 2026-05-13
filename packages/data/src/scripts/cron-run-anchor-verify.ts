/**
 * Phase 4 anchor verification — READ-ONLY.
 *
 * Runs after the forced-Sunday cron wrapper completes. Pulls every anchor
 * case in docs/audits/cron_run_2026-05-12.md Phase 4 list and prints results
 * in a single block for paste into the audit doc.
 */

import { createAdminClient } from "@civitics/db";

function fmt$(cents: number | string | null | undefined): string {
  const c = typeof cents === "string" ? Number(cents) : (cents ?? 0);
  if (!Number.isFinite(c)) return "n/a";
  return "$" + Math.round(c / 100).toLocaleString();
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
    const { data: ents } = await (db as any).from("financial_entities")
      .select("id, name, canonical_name, entity_type, total_donated_cents, source_ids, metadata")
      .ilike("name", "%MUSK%ELON%")
      .or("name.ilike.%ELON%MUSK%")
      .limit(10);
    console.log("  matching financial_entities (LIKE %MUSK%ELON% or %ELON%MUSK%):");
    for (const e of (ents ?? [])) console.log(`    [${e.id}] name="${e.name}" canonical="${e.canonical_name}" type=${e.entity_type} total=${fmt$(e.total_donated_cents)}`);

    if (!ents || ents.length === 0) return;
    const muskIds = ents.map((e: { id: string }) => e.id);

    // Donations FROM musk to anything
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: outs, error: outErr } = await (db as any).from("financial_relationships")
      .select("relationship_type, to_type, to_id, amount_cents, cycle_year, source", { count: "exact" })
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

    // Aggregate outflow by relationship_type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: agg } = await (db as any).rpc("noop_skip");
    void agg;
    // PostgREST can't group; pull all rows for the entity and sum client-side. Cap at 5000.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: allOut } = await (db as any).from("financial_relationships")
      .select("relationship_type, source, amount_cents")
      .in("from_id", muskIds)
      .limit(5000);
    const byType: Record<string, { count: number; sum: number }> = {};
    for (const r of (allOut ?? [])) {
      const k = `${r.relationship_type}:${r.source ?? "-"}`;
      if (!byType[k]) byType[k] = { count: 0, sum: 0 };
      byType[k].count++;
      byType[k].sum += Number(r.amount_cents ?? 0);
    }
    console.log(`  total outflow rows (capped 5000): ${(allOut ?? []).length}`);
    for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].sum - a[1].sum)) {
      console.log(`    ${k.padEnd(50)} count=${v.count.toString().padStart(5)} sum=${fmt$(v.sum)}`);
    }
  });

  await section("DONOR — Elizabeth Simons → DCCC (FIX-236 anchor, expect ~$522K)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ents } = await (db as any).from("financial_entities")
      .select("id, name, total_donated_cents")
      .or("name.ilike.%SIMONS%ELIZABETH%,name.ilike.%ELIZABETH%SIMONS%")
      .limit(10);
    console.log(`  matching donor entities: ${(ents ?? []).length}`);
    for (const e of (ents ?? [])) console.log(`    [${e.id}] name="${e.name}" total=${fmt$(e.total_donated_cents)}`);

    if (!ents || ents.length === 0) return;
    const ids = ents.map((e: { id: string }) => e.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dccc } = await (db as any).from("financial_entities")
      .select("id, name")
      .or("name.ilike.%DCCC%,name.ilike.%DEMOCRATIC CONGRESSIONAL CAMPAIGN%")
      .limit(10);
    console.log(`  DCCC candidate entities: ${(dccc ?? []).length}`);
    for (const e of (dccc ?? [])) console.log(`    [${e.id}] name="${e.name}"`);

    const dcccIds = (dccc ?? []).map((e: { id: string }) => e.id);
    if (dcccIds.length === 0) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rels } = await (db as any).from("financial_relationships")
      .select("relationship_type, source, amount_cents, cycle_year, to_id")
      .in("from_id", ids)
      .in("to_id", dcccIds);
    let sum = 0;
    for (const r of (rels ?? [])) sum += Number(r.amount_cents ?? 0);
    console.log(`  Simons → DCCC: ${(rels ?? []).length} relationships, total=${fmt$(sum)}`);
    for (const r of (rels ?? [])) console.log(`    type=${r.relationship_type} src=${r.source} cycle=${r.cycle_year} ${fmt$(r.amount_cents)}`);
  });

  await section("DONOR — Jon Stryker → DCCC (FIX-236 anchor, expect ~$310K)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ents } = await (db as any).from("financial_entities")
      .select("id, name, total_donated_cents")
      .or("name.ilike.%STRYKER%JON%,name.ilike.%JON%STRYKER%")
      .limit(10);
    console.log(`  matching donor entities: ${(ents ?? []).length}`);
    for (const e of (ents ?? [])) console.log(`    [${e.id}] name="${e.name}" total=${fmt$(e.total_donated_cents)}`);
    if (!ents || ents.length === 0) return;
    const ids = ents.map((e: { id: string }) => e.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: dccc } = await (db as any).from("financial_entities")
      .select("id, name")
      .or("name.ilike.%DCCC%,name.ilike.%DEMOCRATIC CONGRESSIONAL CAMPAIGN%")
      .limit(10);
    const dcccIds = (dccc ?? []).map((e: { id: string }) => e.id);
    if (dcccIds.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: rels } = await (db as any).from("financial_relationships")
      .select("relationship_type, source, amount_cents, cycle_year")
      .in("from_id", ids)
      .in("to_id", dcccIds);
    let sum = 0;
    for (const r of (rels ?? [])) sum += Number(r.amount_cents ?? 0);
    console.log(`  Stryker → DCCC: ${(rels ?? []).length} relationships, total=${fmt$(sum)}`);
  });

  await section("DONOR — Stephen Schwarzman (FIX-239 dedup — expect ONE row)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ents } = await (db as any).from("financial_entities")
      .select("id, name, canonical_name, donor_fingerprint, total_donated_cents")
      .ilike("name", "%SCHWARZMAN%")
      .limit(20);
    console.log(`  Schwarzman entities: ${(ents ?? []).length}`);
    for (const e of (ents ?? [])) console.log(`    [${e.id}] name="${e.name}" canonical="${e.canonical_name}" fp="${e.donor_fingerprint}" total=${fmt$(e.total_donated_cents)}`);
  });

  await section("DONOR — high-volume small-donor THOMPSON (FIX-236 anchor — 1,889 matches)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count, error } = await (db as any).from("financial_entities")
      .select("id", { count: "exact", head: true })
      .ilike("name", "THOMPSON,%");
    console.log(`  entities with name starting THOMPSON,: ${count} (expected ~1889)`);
    if (error) console.log("  error:", error.message);

    // pick one and confirm it resolves
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: sample } = await (db as any).from("financial_entities")
      .select("id, name, canonical_name, total_donated_cents")
      .ilike("name", "THOMPSON,%")
      .gt("total_donated_cents", 50000)
      .order("total_donated_cents", { ascending: false })
      .limit(5);
    console.log("  top THOMPSON donors by total_donated_cents:");
    for (const e of (sample ?? [])) console.log(`    [${e.id}] name="${e.name}" total=${fmt$(e.total_donated_cents)}`);
  });

  await section("DONOR — apostrophe surnames (FIX-244 + FIX-245)", async () => {
    for (const surname of ["O'BRIEN", "O'CONNOR", "D'ANGELO", "D'AMICO"]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count } = await (db as any).from("financial_entities")
        .select("id", { count: "exact", head: true })
        .ilike("name", `${surname},%`);
      console.log(`  ${surname},*  entity count: ${count}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data: sample } = await (db as any).from("financial_entities")
        .select("id, name, canonical_name")
        .ilike("name", `${surname},%`)
        .limit(3);
      for (const e of (sample ?? [])) console.log(`    sample: name="${e.name}" canonical="${e.canonical_name}"`);
    }
  });

  await section("RECIPIENT — Donald Trump (tier='candidate' or 'elected'; FIX-240 IE inflow)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: off } = await (db as any).from("officials")
      .select("id, full_name, tier, party, role_title, source_ids")
      .or("full_name.ilike.%DONALD%TRUMP%,full_name.ilike.%TRUMP%DONALD%")
      .limit(10);
    console.log(`  matching officials: ${(off ?? []).length}`);
    for (const o of (off ?? [])) console.log(`    [${o.id}] name="${o.full_name}" tier=${o.tier} party=${o.party} role="${o.role_title}" fec=${o.source_ids?.fec_candidate_id ?? "-"}`);

    if (!off || off.length === 0) return;
    const ids = off.map((o: { id: string }) => o.id);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ins } = await (db as any).from("financial_relationships")
      .select("relationship_type, source, amount_cents, cycle_year")
      .in("to_id", ids)
      .eq("to_type", "official")
      .limit(2000);
    const byType: Record<string, { count: number; sum: number }> = {};
    for (const r of (ins ?? [])) {
      const k = `${r.relationship_type}:${r.source ?? "-"}`;
      if (!byType[k]) byType[k] = { count: 0, sum: 0 };
      byType[k].count++;
      byType[k].sum += Number(r.amount_cents ?? 0);
    }
    console.log(`  inflow rows: ${(ins ?? []).length}`);
    for (const [k, v] of Object.entries(byType).sort((a, b) => b[1].sum - a[1].sum)) {
      console.log(`    ${k.padEnd(50)} count=${v.count.toString().padStart(5)} sum=${fmt$(v.sum)}`);
    }
  });

  await section("RECIPIENT — JD Vance (FIX-247 'J D' parsing — should NOT duplicate)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: off } = await (db as any).from("officials")
      .select("id, full_name, tier, party, role_title, source_ids")
      .or("full_name.ilike.%VANCE%J%,full_name.ilike.%VANCE,%J%")
      .limit(10);
    console.log(`  Vance officials: ${(off ?? []).length}`);
    for (const o of (off ?? [])) console.log(`    [${o.id}] name="${o.full_name}" tier=${o.tier} party=${o.party} fec=${o.source_ids?.fec_candidate_id ?? "-"}`);
  });

  await section("RECIPIENT — Senate Majority PAC inflow (FIX-240 IE)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ents } = await (db as any).from("financial_entities")
      .select("id, name, source_ids")
      .ilike("name", "%SENATE MAJORITY PAC%")
      .limit(5);
    console.log(`  SMP entities: ${(ents ?? []).length}`);
    for (const e of (ents ?? [])) console.log(`    [${e.id}] name="${e.name}" fec_cmte=${e.source_ids?.fec_committee_id ?? "-"}`);

    // ie_support / ie_oppose total rows in prod
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count: ieS } = await (db as any).from("financial_relationships").select("id", { count: "exact", head: true }).eq("relationship_type", "ie_support");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count: ieO } = await (db as any).from("financial_relationships").select("id", { count: "exact", head: true }).eq("relationship_type", "ie_oppose");
    console.log(`  global ie_support rows: ${ieS}`);
    console.log(`  global ie_oppose rows:  ${ieO}`);
  });

  await section("CONNECTION GRAPH — entity_connections totals + Musk/America-PAC chain", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { count: total } = await (db as any).from("entity_connections").select("id", { count: "exact", head: true });
    console.log(`  entity_connections total rows: ${total}`);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: ap } = await (db as any).from("financial_entities")
      .select("id, name")
      .ilike("name", "%AMERICA PAC%")
      .limit(5);
    for (const e of (ap ?? [])) console.log(`    America PAC: [${e.id}] name="${e.name}"`);

    const apIds = (ap ?? []).map((e: { id: string }) => e.id);
    if (apIds.length > 0) {
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
    for (const src of ["fec_bulk", "fec_bulk_indiv", "fec_bulk_indiv_to_committee", "fec_bulk_ie", "usaspending_bulk", "irs990", "irs_990"]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count, error } = await (db as any).from("financial_relationships")
        .select("id", { count: "exact", head: true })
        .eq("source", src);
      console.log(`  source=${src.padEnd(35)} count=${count ?? "err:" + (error?.message ?? "")}`);
    }
    for (const t of ["donation", "ie_support", "ie_oppose", "contract", "grant"]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { count, error } = await (db as any).from("financial_relationships")
        .select("id", { count: "exact", head: true })
        .eq("relationship_type", t);
      console.log(`  type=${t.padEnd(15)}  count=${count ?? "err:" + (error?.message ?? "")}`);
    }
  });

  await section("SEARCH — pg_trgm canonical_name (FIX-238 known-issue checkpoint)", async () => {
    for (const q of ["elon musk", "elon", "musk", "JD Vance", "Schwarzman", "STRYKER"]) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error, count } = await (db as any).from("financial_entities")
        .select("id, name, canonical_name", { count: "exact" })
        .ilike("canonical_name", `%${q.toLowerCase()}%`)
        .limit(3);
      if (error) console.log(`  q="${q.padEnd(15)}"  error: ${error.message}`);
      else {
        console.log(`  q="${q.padEnd(15)}" matches=${count} examples:`);
        for (const r of (data ?? [])) console.log(`    [${r.id}] name="${r.name}" canonical="${r.canonical_name}"`);
      }
    }
  });

  setTimeout(() => process.exit(0), 250);
}

main().catch((e) => {
  console.error("anchor verify failed:", e instanceof Error ? e.stack : String(e));
  setTimeout(() => process.exit(1), 250);
});
