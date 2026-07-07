/**
 * FIX-435 (Phase 2) — Backfill proposals.summary_plain from Congress.gov CRS
 * summaries. NON-AI ingestion: the CRS-authored plain-language summary is real
 * prose, so writing it to summary_plain shows real summaries on congress bill
 * pages with zero AI calls (flips title_only -> full_summary). Phase 1 did the
 * same for OpenStates abstracts (FIX-445); this is the higher-yield congress
 * side.
 *
 * Source: GET /bill/{congress}/{type}/{number}/summaries returns summaries[] of
 * { actionDate, actionDesc, text, updateDate, versionCode }. `text` is HTML
 * (entity-encoded prose). Bills carry multiple versions (Introduced, Reported,
 * Public Law, ...) — we take the LATEST by updateDate, strip tags + decode
 * entities, and write the plain prose.
 *
 * Idempotent / resumable: only rows where summary_plain IS NULL are selected,
 * and the UPDATE re-asserts `.is('summary_plain', null)` so a concurrent/prior
 * fill is never clobbered (source text owns this column; AI writes go to
 * ai_summary_cache, not here). Re-running skips already-filled rows naturally —
 * which also makes a scheduled re-run the ongoing-capture mechanism for new
 * bills without touching the batched hot ingest path.
 *
 * Rate limit: api.congress.gov is ~5,000 req/hr per key. fetchCongressApi
 * already sleeps 200ms; we add THROTTLE_MS-200 so each iteration is ~800ms
 * (~4,500/hr). ~2,900 bills ~= 40 min, under the hourly cap in a single run.
 * The cap is per-KEY (shared local+prod) — verify local with --limit, then run
 * the full backfill against prod.
 *
 * Run:
 *   pnpm --filter @civitics/data exec tsx --env-file=../../.env.local \
 *     src/scripts/backfill-crs-summaries.ts --apply --limit 50
 *   # prod (mind the per-key rate limit):
 *   pnpm --filter @civitics/data exec tsx \
 *     --env-file=<abs>/.env.local.prod \
 *     <abs>/src/scripts/backfill-crs-summaries.ts --apply --allow-prod
 */

import { createAdminClient } from "@civitics/db";
import { fetchCongressApi, sleep } from "../pipelines/congress/members";

interface SummariesResponse {
  summaries?: Array<{
    actionDate?: string;
    actionDesc?: string;
    text?: string;
    updateDate?: string;
    versionCode?: string;
  }>;
}

const LOOKUP_CHUNK = 100;
// ~800ms/iter total (fetchCongressApi sleeps 200ms, we add the rest) keeps the
// run near ~4,500 req/hr, safely under the ~5,000/hr Congress.gov ceiling.
const THROTTLE_MS = 800;

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
 * Parse a congress billKey "119-HJRES-141" / "118-S-3613" into the lowercased
 * components the API path wants: bill/{congress}/{type}/{number}.
 */
function parseBillKey(billKey: string): { congress: string; type: string; number: string } | null {
  const parts = billKey.split("-");
  if (parts.length !== 3) return null;
  const [congress, type, number] = parts;
  if (!/^\d+$/.test(congress) || !/^\d+$/.test(number) || !type) return null;
  return { congress, type: type.toLowerCase(), number };
}

// Minimal HTML → plain prose: strip tags, decode the entities CRS text actually
// uses, collapse whitespace. (CRS summaries are entity-encoded HTML fragments.)
function htmlToPlain(html: string): string {
  let s = html.replace(/<[^>]+>/g, " ");
  s = s
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&rsquo;/gi, "’")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rdquo;/gi, "”")
    .replace(/&ldquo;/gi, "“")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    // numeric entities (decimal + hex)
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    // ampersand last so we don't double-decode the entities above
    .replace(/&amp;/gi, "&");
  return s.replace(/\s+/g, " ").trim();
}

/** Pick the most recent summary version's plain text (latest updateDate). */
function latestSummaryText(resp: SummariesResponse): string | null {
  const summaries = resp.summaries ?? [];
  if (summaries.length === 0) return null;
  const sorted = [...summaries].sort((a, b) => {
    const ad = a.updateDate ?? a.actionDate ?? "";
    const bd = b.updateDate ?? b.actionDate ?? "";
    return ad < bd ? 1 : ad > bd ? -1 : 0; // descending
  });
  for (const s of sorted) {
    const plain = htmlToPlain(s.text ?? "");
    if (plain.length > 0) return plain;
  }
  return null;
}

async function main(): Promise<void> {
  const { apply, limit } = parseArgs();
  const apiKey = process.env["CONGRESS_API_KEY"] ?? process.env["CONGRESS_GOV_API_KEY"];
  if (!apiKey) {
    console.error("CONGRESS_API_KEY (or CONGRESS_GOV_API_KEY) not set in env.");
    process.exit(1);
  }

  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "(unknown)";
  const isLocal = /127\.0\.0\.1:54321|localhost:54321/.test(url);
  console.log("=================================================");
  console.log("  FIX-435 Phase 2 — Backfill CRS summaries → summary_plain");
  console.log(`  Mode:   ${apply ? "APPLY" : "DRY-RUN"}`);
  console.log(`  DB:     ${isLocal ? "local" : "PROD"}  (${url})`);
  console.log(`  Limit:  ${limit ?? "no limit"}`);
  console.log("=================================================\n");

  const db = createAdminClient();

  // ── 1. Collect congress_gov billKeys (paginated; PostgREST 1k cap) ─────────
  const refs: Array<{ entity_id: string; external_id: string }> = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db
      .from("external_source_refs")
      .select("entity_id, external_id")
      .eq("source", "congress_gov")
      .eq("entity_type", "proposal")
      .order("id") // FIX-760: stable unique order for .range() pagination
      .range(from, from + 999);
    if (error) {
      console.error(`external_source_refs page ${from}: ${error.message}`);
      process.exit(1);
    }
    const rows = (data ?? []) as Array<{ entity_id: string; external_id: string }>;
    refs.push(...rows);
    if (rows.length < 1000) break;
  }
  console.log(`  congress_gov proposal refs: ${refs.length}`);

  // ── 2. Restrict to rows still missing summary_plain (resumable) ────────────
  const byId = new Map<string, string>();
  for (const r of refs) byId.set(r.entity_id, r.external_id);
  const allIds = [...byId.keys()];
  const actionable: Array<{ id: string; billKey: string }> = [];
  for (let i = 0; i < allIds.length; i += LOOKUP_CHUNK) {
    const chunk = allIds.slice(i, i + LOOKUP_CHUNK);
    const { data, error } = await db
      .from("proposals")
      .select("id")
      .in("id", chunk)
      .is("summary_plain", null);
    if (error) {
      console.error(`proposals null-filter chunk ${i}: ${error.message}`);
      process.exit(1);
    }
    for (const r of (data ?? []) as Array<{ id: string }>) {
      actionable.push({ id: r.id, billKey: byId.get(r.id)! });
    }
  }
  console.log(`  actionable (summary_plain IS NULL): ${actionable.length}\n`);

  const targets = limit ? actionable.slice(0, limit) : actionable;

  let updated = 0, noSummary = 0, unparseable = 0, notFound = 0, failed = 0;

  for (let i = 0; i < targets.length; i++) {
    const { id, billKey } = targets[i];
    const parsed = parseBillKey(billKey);
    const tag = `[${i + 1}/${targets.length}] ${billKey}`;

    if (!parsed) {
      console.warn(`${tag}: unparseable billKey, skipping.`);
      unparseable += 1;
      continue;
    }

    let text: string | null;
    try {
      const resp = await fetchCongressApi<SummariesResponse>(
        `bill/${parsed.congress}/${parsed.type}/${parsed.number}/summaries`,
        apiKey,
      );
      text = latestSummaryText(resp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes(" 404 ")) {
        notFound += 1;
        await sleep(THROTTLE_MS - 200);
        continue;
      }
      console.error(`${tag}: fetch error — ${msg}`);
      failed += 1;
      await sleep(1000);
      continue;
    } finally {
      // Pace to ~THROTTLE_MS/iter (fetchCongressApi already slept 200ms).
      await sleep(THROTTLE_MS - 200);
    }

    if (!text) {
      noSummary += 1;
      continue;
    }

    if (!apply) {
      console.log(`${tag}: would set summary_plain (${text.length} chars): ${text.slice(0, 90)}...`);
      updated += 1;
      continue;
    }

    // Don't-clobber: re-assert summary_plain IS NULL in the UPDATE filter.
    const { error: updErr, count } = await db
      .from("proposals")
      .update({ summary_plain: text }, { count: "exact" })
      .eq("id", id)
      .is("summary_plain", null);

    if (updErr) {
      console.error(`${tag}: update failed — ${updErr.message}`);
      failed += 1;
      continue;
    }
    if (count === 0) {
      // Already filled between selection and now — treat as skip, not error.
      noSummary += 1;
      continue;
    }
    updated += 1;
    if (updated % 100 === 0) console.log(`  ...${updated} updated so far (${i + 1}/${targets.length})`);
  }

  console.log("\n=================================================");
  console.log(`  Updated (summary_plain set):  ${updated}`);
  console.log(`  No summary available:         ${noSummary}`);
  console.log(`  404 (bill not found):         ${notFound}`);
  console.log(`  Unparseable billKey:          ${unparseable}`);
  console.log(`  Failed:                       ${failed}`);
  console.log(`  Mode:                         ${apply ? "APPLIED" : "DRY-RUN (no writes)"}`);
  console.log("=================================================");
}

main()
  .then(() => setTimeout(() => process.exit(0), 200))
  .catch((err) => {
    console.error("Fatal error:", err);
    setTimeout(() => process.exit(1), 200);
  });
