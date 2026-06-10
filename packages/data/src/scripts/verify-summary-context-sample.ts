/**
 * FIX-434 verification (throwaway, untracked): pull one congress bill and one
 * openstates bill that carry metadata.latest_action, run them through
 * buildProposalSummaryContext, and confirm latest_action lands in the context
 * blob the worker reads. Read-only.
 *
 *   pnpm --filter @civitics/data tsx --env-file=../../.env.local src/scripts/verify-summary-context-sample.ts
 */
import { createAdminClientWith } from "@civitics/db";
import { buildProposalSummaryContext } from "../pipelines/enrichment/queue";

async function main() {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"]!;
  const key = process.env["SUPABASE_SECRET_KEY"]!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClientWith(url, key) as any;

  for (const src of ["congress_gov", "openstates"]) {
    // reads-ok: ad-hoc verification sample — empty output is visibly wrong to the operator
    const { data: refs } = await db
      .from("external_source_refs")
      .select("entity_id")
      .eq("entity_type", "proposal")
      .eq("source", src)
      .limit(200);
    const ids = (refs ?? []).map((r: { entity_id: string }) => r.entity_id);
    // reads-ok: ad-hoc verification sample — empty output is visibly wrong to the operator
    const { data: rows } = await db
      .from("proposals")
      .select("id, title, type, summary_plain, metadata")
      .in("id", ids)
      .not("metadata->>latest_action", "is", null)
      .limit(1);
    const p = rows?.[0];
    console.log(`\n── ${src} ──`);
    if (!p) { console.log("  (no row with metadata.latest_action found)"); continue; }
    const ctx = buildProposalSummaryContext({
      id: p.id,
      title: p.title,
      summary_plain: p.summary_plain,
      type: p.type,
      agency_name: null,
      agency_acronym: (p.metadata?.agency_id as string | undefined) ?? null,
      latest_action: (p.metadata?.latest_action as string | undefined) ?? null,
    });
    console.log(JSON.stringify(ctx, null, 2));
    console.log(`  latest_action present in context? ${ctx.latest_action != null ? "YES ✓" : "NO ✗"}`);
  }
}

main().then(() => setTimeout(() => process.exit(0), 200));
