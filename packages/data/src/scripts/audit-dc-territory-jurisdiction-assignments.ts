/**
 * FIX-383 post-fix audit — counts officials currently mis-assigned to the
 * federal jurisdiction whose canonical jurisdiction is DC or a territory.
 *
 * DC + 5-territory specific (hardcoded short_name list). Copy as template
 * for future jurisdiction-attribution audits — swap the abbr list.
 *
 *   pnpm --filter @civitics/data diag:dc-territory-jurisdictions
 *   (override env via `--env-file=../../.env.local.prod` for prod audit)
 */

import { createAdminClient } from "@civitics/db";

const TERRITORY_ABBRS = ["DC", "AS", "GU", "MP", "PR", "VI"] as const;

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  console.log(`target: ${url}`);

  const db = createAdminClient();

  const { data: fed, error: fErr } = await db
    .from("jurisdictions")
    .select("id")
    .eq("fips_code", "00")
    .eq("type", "country")
    .single();
  if (fErr || !fed) {
    console.error("could not resolve federal jurisdiction", fErr);
    process.exit(1);
  }
  const federalId = fed.id;
  console.log(`federalId: ${federalId}\n`);

  // reads-ok: audit report read — zero territories renders visibly in the report output
  const { data: terrs } = await db
    .from("jurisdictions")
    .select("id, short_name, name")
    .in("short_name", [...TERRITORY_ABBRS])
    .eq("parent_id", federalId);
  console.log("canonical state-equivalent rows:");
  for (const t of terrs ?? []) console.log(`  ${t.short_name} ${t.id}  ${t.name}`);
  console.log("");

  // Officials whose metadata.state matches a territory abbr but who are
  // currently parked on the federal jurisdiction (the silent-degradation
  // signature) — this includes both congress/officials (House delegates)
  // and fec-bulk candidates.
  for (const abbr of TERRITORY_ABBRS) {
    const { data: misAssigned, error } = await db
      .from("officials")
      .select("id, full_name, role_title, tier, jurisdiction_id, source_ids, metadata")
      .eq("jurisdiction_id", federalId)
      .or(`metadata->>state.eq.${abbr},district_name.ilike.%${abbr}%`)
      .limit(500);
    if (error) {
      console.error(`${abbr}: query error`, error.message);
      continue;
    }
    const rows = misAssigned ?? [];
    const byTier = rows.reduce<Record<string, number>>((acc, r) => {
      const t = (r.tier as string | null) ?? "(null)";
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {});
    console.log(`${abbr}: ${rows.length} officials on federalId (by tier: ${JSON.stringify(byTier)})`);
    for (const r of rows.slice(0, 5)) {
      console.log(`  - ${r.full_name} | ${r.role_title} | tier=${r.tier} | src=${JSON.stringify(r.source_ids)}`);
    }
    if (rows.length > 5) console.log(`  … +${rows.length - 5} more`);
  }

  // Congress.gov-sourced rows currently on federalId. These are elected
  // members; House delegates from DC + 5 territories are the only legit
  // candidates for this state. Senators are never on these jurisdictions.
  console.log("\n--- congress.gov-sourced officials currently on federalId ---");
  const { data: cgFed, error: cgErr } = await db
    .from("officials")
    .select("id, full_name, role_title, district_name, source_ids")
    .eq("jurisdiction_id", federalId)
    .not("source_ids->>congress_gov", "is", null)
    .limit(50);
  if (cgErr) console.error(cgErr.message);
  else {
    console.log(`count: ${(cgFed ?? []).length}`);
    for (const r of cgFed ?? []) {
      console.log(`  - ${r.full_name} | ${r.role_title} | dist=${r.district_name} | src=${JSON.stringify(r.source_ids)}`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
