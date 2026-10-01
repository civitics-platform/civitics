/**
 * FIX-162 — Re-title procedural-vote bill stubs in public.proposals.
 *
 * Background: an older revision of the votes pipeline created proposals
 * rows for federal bills with `title` set to the procedural vote question
 * ("On Motion to Suspend the Rules and Pass") instead of the bill's actual
 * title. The current votes.ts uses "${type} ${number}" as a placeholder, but
 * the older bad rows are still in public.proposals — load-bearing because
 * thousands of votes hang off each one via votes.bill_proposal_id (CASCADE).
 *
 * This script identifies those stubs and replaces the title with the real
 * bill title fetched from the Congress.gov v3 API. The original procedural
 * string is preserved in metadata.original_procedural_title for audit.
 *
 * Selection criteria (must match all):
 *   - title starts with "On " (case-insensitive)
 *   - metadata->>'legacy_session' is set (came from votes ingester)
 *   - metadata->>'legacy_bill_number' is set
 *   - metadata->>'legacy_congress_num' is set
 *
 * Run:
 *   pnpm --filter @civitics/data data:retitle-stubs --dry-run
 *   pnpm --filter @civitics/data data:retitle-stubs --apply
 *   pnpm --filter @civitics/data data:retitle-stubs --apply --limit 10
 */

import { createAdminClient } from "@civitics/db";
import { fetchCongressApi, sleep } from "../pipelines/congress/members";

interface BillResponse {
  bill?: {
    title?: string;
    type?: string;
    number?: string;
    congress?: number;
  };
}

interface StubRow {
  id: string;
  title: string;
  metadata: Record<string, unknown>;
}

const PROCEDURAL_TITLE_REGEX = /^on\s/i;

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

/**
 * Map a stored legacy_bill_number like "HR 192" / "HRES 5" / "HJRES 2" /
 * "S 47" to the lowercase bill type and number expected by the Congress.gov
 * API (`bill/{congress}/{type}/{number}`).
 */
function parseBillNumber(legacy: string): { type: string; number: string } | null {
  const trimmed = legacy.trim().toUpperCase();
  // Order matters: longer prefixes first so "HCONRES 5" doesn't match "HR".
  const prefixes: Array<{ prefix: string; type: string }> = [
    { prefix: "HCONRES ", type: "hconres" },
    { prefix: "SCONRES ", type: "sconres" },
    { prefix: "HJRES ", type: "hjres" },
    { prefix: "SJRES ", type: "sjres" },
    { prefix: "HRES ", type: "hres" },
    { prefix: "SRES ", type: "sres" },
    { prefix: "HR ", type: "hr" },
    { prefix: "S ", type: "s" },
  ];
  for (const { prefix, type } of prefixes) {
    if (trimmed.startsWith(prefix)) {
      const number = trimmed.slice(prefix.length).trim();
      if (number && /^\d+$/.test(number)) return { type, number };
      return null;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs();
  const apiKey = process.env["CONGRESS_API_KEY"] ?? process.env["CONGRESS_GOV_API_KEY"];
  if (!apiKey) {
    console.error("CONGRESS_API_KEY (or CONGRESS_GOV_API_KEY) not set in .env.local.");
    process.exit(1);
  }

  const supabaseUrl = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "(unknown)";
  console.info("=================================================");
  console.info("  FIX-162 — Re-title procedural bill stubs");
  console.info(`  Mode:     ${apply ? "APPLY" : "DRY-RUN"}`);
  console.info(`  DB:       ${supabaseUrl}`);
  console.info(`  Limit:    ${limit ?? "no limit"}`);
  console.info("=================================================\n");

  const db = createAdminClient();

  // Pull all candidate stubs in one shot — there are only a few hundred.
  const { data: rows, error } = await db
    .from("proposals")
    .select("id, title, metadata")
    .ilike("title", "On %")
    .not("metadata->legacy_session", "is", null)
    .not("metadata->legacy_bill_number", "is", null)
    .not("metadata->legacy_congress_num", "is", null);

  if (error) {
    console.error(`Query failed: ${error.message}`);
    process.exit(1);
  }
  if (!rows || rows.length === 0) {
    console.info("No procedural bill stubs found. Nothing to do.");
    return;
  }

  // Defensive: re-check title pattern client-side (ilike "On %" is broader
  // than the documented regex; we want only "On " followed by something).
  const stubs: StubRow[] = (rows as StubRow[]).filter((r) =>
    PROCEDURAL_TITLE_REGEX.test(r.title)
  );

  console.info(`Found ${stubs.length} procedural-titled bill stubs.\n`);

  const targets = limit ? stubs.slice(0, limit) : stubs;
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const stub = targets[i];
    const meta = stub.metadata ?? {};
    const congress = Number(meta["legacy_congress_num"]);
    const billNumberStr = String(meta["legacy_bill_number"] ?? "");
    const parsed = parseBillNumber(billNumberStr);

    const tag = `[${i + 1}/${targets.length}] ${billNumberStr} (${congress}th)`;

    if (!parsed || !Number.isFinite(congress)) {
      console.warn(`${tag}: cannot parse bill identifier, skipping.`);
      skipped += 1;
      continue;
    }

    let title: string;
    try {
      const resp = await fetchCongressApi<BillResponse>(
        `bill/${congress}/${parsed.type}/${parsed.number}`,
        apiKey
      );
      const fetched = resp.bill?.title?.trim();
      if (!fetched) {
        console.warn(`${tag}: API returned no title, skipping.`);
        skipped += 1;
        continue;
      }
      title = fetched.slice(0, 500);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // 404 = bill never existed under that key; leave the stub alone but
      // mark it so a follow-up can review.
      if (msg.includes(" 404 ")) {
        console.warn(`${tag}: 404 from Congress.gov, skipping.`);
        skipped += 1;
        continue;
      }
      console.error(`${tag}: fetch error — ${msg}`);
      failed += 1;
      // Back off a little extra on errors before continuing.
      await sleep(1000);
      continue;
    }

    if (!apply) {
      console.info(`${tag}: would set title → ${title}`);
      updated += 1;
      continue;
    }

    const newMetadata = {
      ...meta,
      original_procedural_title: stub.title,
      retitled_by: "fix-162",
      retitled_at: new Date().toISOString(),
    };

    const { error: updateErr } = await db
      .from("proposals")
      .update({ title, metadata: newMetadata })
      .eq("id", stub.id);

    if (updateErr) {
      console.error(`${tag}: update failed — ${updateErr.message}`);
      failed += 1;
      continue;
    }

    console.info(`${tag}: → ${title}`);
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
