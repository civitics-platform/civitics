/**
 * FIX-164 — Re-title presidential-nomination stubs in public.proposals.
 *
 * The Senate votes pipeline's normalizeSenateDocType() falls through to "S"
 * for any unrecognized <document_type>. The Senate XML uses "PN" for
 * Presidential Nomination votes (cabinet/judicial confirmations), so those
 * land in proposals as `S {nominationNumber}` with `title` = the procedural
 * vote question ("On the Motion to Proceed", "On the Cloture Motion") and
 * `type = 'bill'` instead of `appointment`.
 *
 * The Senate XML at votes.source_url already carries the right info in
 * `<document>` → `<document_title>` (e.g. "Russell Vought, of Virginia, to
 * be Director of the Office of Management and Budget"). This script fetches
 * one such XML per stub, extracts the document fields, and updates the
 * proposals row in place.
 *
 * What it changes per stub:
 *   title                       ← <document_title>
 *   type                        ← 'appointment'
 *   metadata.original_procedural_title  ← old title
 *   metadata.original_legacy_bill_number ← old "S 11-22"
 *   metadata.legacy_bill_number ← corrected "PN 11-22"
 *   metadata.retitled_by        ← 'fix-164'
 *   metadata.retitled_at        ← ISO timestamp
 *
 * The bill_details row stays attached (votes.bill_proposal_id FKs through
 * it) — schema-cleaning that out is a separate, larger task.
 *
 * Selection criteria:
 *   - title starts with "On "
 *   - metadata.legacy_session set
 *   - metadata.legacy_bill_number matches /^S \d+-\d+$/
 *
 * Run:
 *   pnpm --filter @civitics/data data:retitle-pn-stubs --dry-run
 *   pnpm --filter @civitics/data data:retitle-pn-stubs --apply
 *   pnpm --filter @civitics/data data:retitle-pn-stubs --apply --limit 5
 */

import { createAdminClient } from "@civitics/db";
import { fetchText, sleep } from "../pipelines/congress/members";
import { XMLParser } from "fast-xml-parser";

interface StubRow {
  id: string;
  title: string;
  metadata: Record<string, unknown>;
  source_url: string;
}

const PROCEDURAL_TITLE_REGEX = /^on\s/i;
// Senate PN votes that fell through normalizeSenateDocType. Most show up
// as `S {parent}-{nominee}` ("S 11-22"), but the rare single-nominee form
// is just `S {pn}` ("S 19"). The script verifies via document_type=PN
// before writing anything, so a wider regex is safe.
const PN_BILL_NUMBER_REGEX = /^S \d+(-\d+)?$/;

const xmlParser = new XMLParser({ ignoreAttributes: false });

function parseArgs(): { apply: boolean; limit: number | null } {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = args.includes("--dry-run");
  if (!apply && !dryRun) {
    console.error("Pass either --dry-run or --apply.");
    process.exit(1);
  }
  if (apply && dryRun) {
    console.error("Pass --dry-run or --apply, not both.");
    process.exit(1);
  }
  const limitIdx = args.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) : null;
  if (limit !== null && (!Number.isFinite(limit) || limit <= 0)) {
    console.error("--limit must be a positive integer.");
    process.exit(1);
  }
  return { apply, limit };
}

interface XmlDocFields {
  documentTitle: string;
  documentType: string;
  documentNumber: string;
}

function extractDocFields(xmlText: string): XmlDocFields | null {
  const parsed = xmlParser.parse(xmlText) as Record<string, unknown>;
  const root = parsed["roll_call_vote"] as Record<string, unknown> | undefined;
  const doc = root?.["document"] as Record<string, unknown> | undefined;
  if (!doc) return null;
  const documentTitle = String(doc["document_title"] ?? "").trim();
  const documentType = String(doc["document_type"] ?? "").trim();
  const documentNumber = String(doc["document_number"] ?? "").trim();
  if (!documentTitle || !documentType || !documentNumber) return null;
  return { documentTitle, documentType, documentNumber };
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs();
  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "(unknown)";

  console.info("=================================================");
  console.info("  FIX-164 — Re-title presidential-nomination stubs");
  console.info(`  Mode:     ${apply ? "APPLY" : "DRY-RUN"}`);
  console.info(`  DB:       ${supabaseUrl}`);
  console.info(`  Limit:    ${limit ?? "no limit"}`);
  console.info("=================================================\n");

  const db = createAdminClient();

  // Pull all stubs and one source_url each. We pick the first vote per
  // proposal — they all reference the same nomination, so any URL works.
  const { data: rows, error } = await db
    .from("proposals")
    .select("id, title, metadata")
    .ilike("title", "On %")
    .not("metadata->legacy_session", "is", null)
    .filter("metadata->>legacy_bill_number", "like", "S %");

  if (error) {
    console.error(`Stub query failed: ${error.message}`);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.info("No PN stubs found. Nothing to do.");
    return;
  }

  const filtered = (rows as Array<Pick<StubRow, "id" | "title" | "metadata">>).filter((r) =>
    PROCEDURAL_TITLE_REGEX.test(r.title) &&
    PN_BILL_NUMBER_REGEX.test(String(r.metadata?.["legacy_bill_number"] ?? ""))
  );

  console.info(`Found ${filtered.length} PN stubs.`);

  // Resolve one source_url per stub via votes.bill_proposal_id. The naive
  // `.in("bill_proposal_id", stubIds)` shape would fan out to ~30k vote rows
  // (144 stubs × ~200 votes each) and trip the supabase-js default row cap,
  // so issue one targeted query per stub instead.
  const urlByProposal = new Map<string, string>();
  for (const r of filtered) {
    const { data: vRow } = await db
      .from("votes")
      .select("source_url")
      .eq("bill_proposal_id", r.id)
      .not("source_url", "is", null)
      .limit(1)
      .maybeSingle();
    const url = (vRow as { source_url: string } | null)?.source_url;
    if (url) urlByProposal.set(r.id, url);
  }

  const stubs: StubRow[] = filtered
    .map((r) => ({
      ...r,
      source_url: urlByProposal.get(r.id) ?? "",
    }))
    .filter((s) => {
      if (!s.source_url) {
        console.warn(`  ${s.id}: no source_url on attached votes, skipping.`);
        return false;
      }
      return true;
    });

  console.info(`Resolvable stubs (have a Senate XML URL): ${stubs.length}\n`);

  const targets = limit ? stubs.slice(0, limit) : stubs;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const stub = targets[i];
    const meta = stub.metadata ?? {};
    const oldBillNumber = String(meta["legacy_bill_number"] ?? "");
    const tag = `[${i + 1}/${targets.length}] ${oldBillNumber}`;

    let xmlText: string;
    try {
      // 200ms politeness delay between Senate.gov hits.
      await sleep(200);
      xmlText = await fetchText(stub.source_url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${tag}: fetch error — ${msg}`);
      failed += 1;
      await sleep(1000);
      continue;
    }

    const fields = extractDocFields(xmlText);
    if (!fields) {
      console.warn(`${tag}: XML had no usable <document> block, skipping.`);
      skipped += 1;
      continue;
    }
    if (fields.documentType !== "PN") {
      console.warn(
        `${tag}: expected PN, got ${fields.documentType} (${fields.documentNumber}), skipping.`
      );
      skipped += 1;
      continue;
    }

    const newTitle = fields.documentTitle.slice(0, 500);
    const correctedBillNumber = `PN ${fields.documentNumber}`;

    if (!apply) {
      console.info(
        `${tag}: would set type=appointment, title → ${newTitle.slice(0, 90)}${newTitle.length > 90 ? "…" : ""}`
      );
      updated += 1;
      continue;
    }

    const newMetadata = {
      ...meta,
      original_procedural_title: stub.title,
      original_legacy_bill_number: oldBillNumber,
      legacy_bill_number: correctedBillNumber,
      retitled_by: "fix-164",
      retitled_at: new Date().toISOString(),
    };

    const { error: updateErr } = await db
      .from("proposals")
      .update({ title: newTitle, type: "appointment", metadata: newMetadata })
      .eq("id", stub.id);

    if (updateErr) {
      console.error(`${tag}: update failed — ${updateErr.message}`);
      failed += 1;
      continue;
    }

    console.info(`${tag}: → ${newTitle.slice(0, 90)}${newTitle.length > 90 ? "…" : ""}`);
    updated += 1;
  }

  console.info("\n=================================================");
  console.info(`  Updated:  ${updated}`);
  console.info(`  Skipped:  ${skipped}`);
  console.info(`  Failed:   ${failed}`);
  console.info(`  Mode:     ${apply ? "APPLIED" : "DRY-RUN (no writes)"}`);
  console.info("=================================================");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
