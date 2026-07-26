/**
 * Enrichment backlog seeder (FIX-064)
 *
 * One-shot script: stages every proposal + official that's missing an AI tag
 * or an AI summary into enrichment_queue. Unlike the pipeline's queue-mode
 * branch (narrow scope — open-comment proposals, active Sen/Rep with records),
 * the seeder widens to "everything missing" so a worker can drain the whole
 * backlog in one go.
 *
 *   pnpm --filter @civitics/data data:enrich-seed             # real inserts
 *   pnpm --filter @civitics/data data:enrich-seed -- --dry-run
 */

import { createAdminClient, agencyFullName, selectAllOrThrow } from "@civitics/db";
import {
  zeroCounts,
  buildProposalTagContext,
  buildProposalSummaryContext,
  buildOfficialSummaryContext,
  buildFinancialEntityTagContext,
  hasUsableSourceText,
  NO_SOURCE_TEXT_STATUS,
  tallySkip,
  formatSkipTally,
  type SkipTally,
  aggregateOfficialStats,
  loadJurisdictionPriorities,
  type EnqueueCounts,
  type EnqueueAction,
  type EntityType,
  type TaskType,
} from "./queue";

const DRY_RUN = process.argv.includes("--dry-run");
// --force: also reseeds items already marked 'done', refreshing context + priority.
const FORCE = process.argv.includes("--force");
// --pacs-only: skip proposals/officials entirely; only enqueue PAC + party_committee
// industry tags at priority 100 so they drain ahead of any other backlog.
const PACS_ONLY = process.argv.includes("--pacs-only");
// Pagination size for the snapshot SELECTs (fetchAll). enrichment_queue
// lacks an index on (entity_type, task_type) for non-pending rows, so each
// page scan is O(N) on a growing table. 500 keeps a full page inside Pro's
// ~8s statement timeout even at 100k+ rows.
const PAGE = 500;
// Chunk size is constrained by Pro's statement timeout. Context JSONB is
// ~1-2 KB per row; a 500-row upsert can exceed 8s and get cancelled
// server-side with "canceling statement due to statement timeout".
// 100 keeps each statement well under the budget.
const UPSERT_CHUNK = 100;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

// ---------------------------------------------------------------------------
// Pagination helpers
// ---------------------------------------------------------------------------

// FIX-545: this used to console.error + break on a page error, returning a
// PARTIAL snapshot — the already-tagged/already-summarized sets would
// under-count and the seeder would re-enqueue items that were already done.
// selectAllOrThrow fails the run instead.
async function fetchAll<T>(
  label: string,
  loader: (from: number, to: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  return selectAllOrThrow<T>(label, loader, { pageSize: PAGE });
}

// ---------------------------------------------------------------------------
// Already-done sets (so we can "fetch all missing X" efficiently)
// ---------------------------------------------------------------------------

// FIX-896: `official` left this union with the official-tag leg — proposals are
// the only entity type whose AI topic tags gate an enqueue now.
async function taggedEntityIds(
  db: Db,
  entityType: "proposal",
): Promise<Set<string>> {
  const rows = await fetchAll<{ entity_id: string }>(
    `entity_tags(${entityType})`,
    (from, to) =>
      db
        .from("entity_tags")
        .select("entity_id")
        .eq("entity_type", entityType)
        .eq("generated_by", "ai")
        .eq("tag_category", "topic")
        // FIX-760: stable unique order — unordered .range() pagination can
        // skip/duplicate rows as page boundaries shift between queries.
        .order("id")
        .range(from, to),
  );
  return new Set(rows.map((r) => r.entity_id));
}

// Returns IDs that already have ANY industry tag (rule or AI) — skip those.
async function industryTaggedFinancialEntityIds(db: Db): Promise<Set<string>> {
  const rows = await fetchAll<{ entity_id: string }>(
    "entity_tags(financial_entity,industry)",
    (from, to) =>
      db
        .from("entity_tags")
        .select("entity_id")
        .eq("entity_type", "financial_entity")
        .eq("tag_category", "industry")
        .order("id") // FIX-760
        .range(from, to),
  );
  return new Set(rows.map((r) => r.entity_id));
}

async function summarizedEntityIds(
  db: Db,
  entityType: "proposal" | "official",
  summaryType: string,
): Promise<Set<string>> {
  const rows = await fetchAll<{ entity_id: string }>(
    `ai_summary_cache(${entityType},${summaryType})`,
    (from, to) =>
      db
        .from("ai_summary_cache")
        .select("entity_id")
        .eq("entity_type", entityType)
        .eq("summary_type", summaryType)
        .order("id") // FIX-760
        .range(from, to),
  );
  return new Set(rows.map((r) => r.entity_id));
}

// ---------------------------------------------------------------------------
// Proposal sources
// ---------------------------------------------------------------------------

type ProposalRow = {
  id: string;
  title: string;
  summary_plain: string | null;
  type: string | null;
  metadata: Record<string, unknown> | null;
  jurisdiction_id: string;
  updated_at: string;
  // FIX-894: only used to break the gate's skip count down by source.
  primary_source: string | null;
};

async function fetchAllProposals(db: Db): Promise<ProposalRow[]> {
  // Exclude procedural votes and case names — see FIX-065 / FIX-066
  return fetchAll<ProposalRow>("proposals", (from, to) =>
    db
      .from("proposals")
      .select("id, title, summary_plain, type, metadata, jurisdiction_id, updated_at, primary_source")
      .not("title", "ilike", "On %")
      .filter("title", "not.ilike", "% v. %")
      .order("id") // FIX-760
      .range(from, to),
  );
}

// ---------------------------------------------------------------------------
// Official sources
// ---------------------------------------------------------------------------

type OfficialRow = {
  id: string;
  full_name: string;
  role_title: string;
  party: string | null;
  metadata: Record<string, unknown> | null;
  jurisdiction_id: string;
  updated_at: string;
};

async function fetchAllActiveOfficials(db: Db): Promise<OfficialRow[]> {
  return fetchAll<OfficialRow>("officials", (from, to) =>
    db
      .from("officials")
      .select("id, full_name, role_title, party, metadata, jurisdiction_id, updated_at")
      .eq("is_active", true)
      .order("id") // FIX-760
      .range(from, to),
  );
}

// ---------------------------------------------------------------------------
// Enqueue loops
// ---------------------------------------------------------------------------

// Snapshot of enrichment_queue state for one (entity_type, task_type) pair.
// Pre-fetched once so we can classify each row into created/retried/skipped
// without a per-row RPC round-trip (Windows exhausts ephemeral ports at ~10k
// sockets in TIME_WAIT, so per-row calls EADDRINUSE on large backlogs).
type QueueSnapshot = Map<string, { status: string; retry_count: number }>;

async function fetchQueueSnapshot(
  db: Db,
  entityType: EntityType,
  taskType: TaskType,
): Promise<QueueSnapshot> {
  const rows = await fetchAll<{ entity_id: string; status: string; retry_count: number }>(
    `enrichment_queue(${entityType},${taskType})`,
    (from, to) =>
      db
        .from("enrichment_queue")
        .select("entity_id, status, retry_count")
        .eq("entity_type", entityType)
        .eq("task_type", taskType)
        .order("id") // FIX-760
        .range(from, to),
  );
  const out: QueueSnapshot = new Map();
  for (const r of rows) out.set(r.entity_id, { status: r.status, retry_count: r.retry_count });
  return out;
}

function classifyAction(
  existing: { status: string; retry_count: number } | undefined,
): EnqueueAction {
  if (!existing) return "created";
  if (existing.status === "done") return FORCE ? "retried" : "skipped_done";
  // FIX-895: a row marked no-source-text must stay marked. It would otherwise
  // fall through to "skipped_pending" below — correct behaviour (not reseeded),
  // but reported under a label that hides the gate's effect. Note --force does
  // NOT resurrect these: the reverse sweep (data:sweep-no-text --reverse) is the
  // only path back to pending, and it requires the text to actually be there.
  if (existing.status === NO_SOURCE_TEXT_STATUS) return "skipped_no_source_text";
  if (existing.status === "failed" && existing.retry_count < 3) return "retried";
  return "skipped_pending";
}

async function enqueueAll(
  db: Db,
  entityType: EntityType,
  taskType: TaskType,
  rows: Array<{
    entity_id: string;
    entity_type: EntityType;
    task_type: "tag" | "summary";
    context: unknown;
    priority: number;
    entity_updated_at: string;
  }>,
  label: string,
): Promise<EnqueueCounts> {
  const counts = zeroCounts();
  if (rows.length === 0) return counts;

  const snapshot = await fetchQueueSnapshot(db, entityType, taskType);

  type Classified = { row: (typeof rows)[number]; action: EnqueueAction };
  const classified: Classified[] = rows.map((row) => ({
    row,
    action: classifyAction(snapshot.get(row.entity_id)),
  }));
  for (const c of classified) counts[c.action]++;

  if (DRY_RUN) {
    console.log(`   [dry-run] would upsert ${counts.created + counts.retried} ${label} ` +
      `(${fmt(counts)})`);
    return counts;
  }

  // Only "created" and "retried" rows hit the DB. Including status/claimed_*/
  // last_error in the payload makes INSERT use defaults (which match) and
  // ON CONFLICT DO UPDATE reset them — matching the RPC's retried path.
  // retry_count is intentionally omitted so it stays at 0 on INSERT and is
  // preserved on UPDATE.
  const toUpsert = classified.filter(
    (c) => c.action === "created" || c.action === "retried",
  );
  let errors = 0;
  for (let i = 0; i < toUpsert.length; i += UPSERT_CHUNK) {
    const chunk = toUpsert.slice(i, i + UPSERT_CHUNK).map((c) => ({
      entity_id: c.row.entity_id,
      entity_type: c.row.entity_type,
      task_type: c.row.task_type,
      context: c.row.context,
      priority: c.row.priority,
      entity_updated_at: c.row.entity_updated_at,
      status: "pending",
      claimed_at: null,
      claimed_by: null,
      last_error: null,
    }));
    const { error } = await db.from("enrichment_queue").upsert(chunk, {
      onConflict: "entity_id,entity_type,task_type",
      ignoreDuplicates: false,
    });
    if (error) {
      errors++;
      if (errors <= 3) {
        console.error(
          `   ✗ upsert ${label} chunk ${i}-${i + chunk.length}:`,
          error.message,
        );
      }
    }
  }
  if (errors > 0) console.error(`   ✗ ${errors} ${label} upsert chunk(s) failed`);
  return counts;
}

function fmt(counts: EnqueueCounts): string {
  return (
    `created=${counts.created} retried=${counts.retried} ` +
    `skipped_done=${counts.skipped_done} skipped_pending=${counts.skipped_pending} ` +
    `skipped_no_source_text=${counts.skipped_no_source_text}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n═══ Enrichment backlog seed ════════════════════════════════`);
  console.log(`    Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}${FORCE ? " + FORCE (reseed done items)" : ""}${PACS_ONLY ? " + PACS-ONLY (skip proposals/officials)" : ""}`);
  console.log(`    Time: ${new Date().toISOString()}\n`);

  const db = createAdminClient() as unknown as Db;

  // In --pacs-only mode skip proposals/officials entirely. The financial-entity
  // industry-tag block at the bottom does its own filtering.
  let proposalTagCounts: EnqueueCounts = zeroCounts();
  let proposalSummaryCounts: EnqueueCounts = zeroCounts();
  // FIX-896: officialTagCounts is gone with the official-tag leg.
  let officialSummaryCounts: EnqueueCounts = zeroCounts();

  if (!PACS_ONLY) {
    // Fetch proposals + officials, then resolve jurisdiction priorities in one batch.
    const [proposals, officials] = await Promise.all([
      fetchAllProposals(db),
      fetchAllActiveOfficials(db),
    ]);

    const allJurisdictionIds = [
      ...proposals.map((p) => p.jurisdiction_id),
      ...officials.map((o) => o.jurisdiction_id),
    ].filter(Boolean) as string[];
    const jPriority = await loadJurisdictionPriorities(db, allJurisdictionIds);

  // 1. Proposal tags
  //    FIX-894: gate on actual source text. A topic classified from a title
  //    alone is the model supplying the knowledge rather than the record.
  const taggedProposalIds = await taggedEntityIds(db, "proposal");
  const proposalTagSkips: SkipTally = new Map();
  const proposalTagRows = proposals
    .filter((p) => FORCE || !taggedProposalIds.has(p.id))
    .filter((p) => {
      if (hasUsableSourceText(p.summary_plain, p.title)) return true;
      tallySkip(proposalTagSkips, p.primary_source);
      return false;
    })
    .map((p) => ({
      entity_id: p.id,
      entity_type: "proposal" as const,
      task_type: "tag" as const,
      priority: jPriority.get(p.jurisdiction_id) ?? 0,
      entity_updated_at: p.updated_at,
      context: buildProposalTagContext({
        id: p.id,
        title: p.title,
        summary_plain: p.summary_plain,
        metadata: p.metadata,
      }),
    }));
  console.log(`── Proposal tags (${proposalTagRows.length} to seed, with source text) ──`);
  console.log(formatSkipTally(proposalTagSkips));
  proposalTagCounts = await enqueueAll(db, "proposal", "tag", proposalTagRows, "proposal-tags");
  console.log(`   ${fmt(proposalTagCounts)}\n`);

  // 2. Proposal summaries — require real source text (FIX-894)
  const summarizedProposalIds = await summarizedEntityIds(db, "proposal", "plain_language");
  const proposalSummarySkips: SkipTally = new Map();
  const proposalSummaryRows = proposals
    .filter((p) => FORCE || !summarizedProposalIds.has(p.id))
    // FIX-894: was `!== "truly_empty"`, which admitted every title_only row —
    // i.e. a summary generated from nothing but the title. Now requires real
    // source text, which subsumes the truly_empty check.
    .filter((p) => {
      if (hasUsableSourceText(p.summary_plain, p.title)) return true;
      tallySkip(proposalSummarySkips, p.primary_source);
      return false;
    })
    .map((p) => {
      const acronym = (p.metadata?.["agency_id"] as string | undefined) ?? null;
      return {
        entity_id: p.id,
        entity_type: "proposal" as const,
        task_type: "summary" as const,
        priority: jPriority.get(p.jurisdiction_id) ?? 0,
        entity_updated_at: p.updated_at,
        context: buildProposalSummaryContext({
          id: p.id,
          title: p.title,
          summary_plain: p.summary_plain,
          type: p.type,
          agency_name: agencyFullName(acronym),
          agency_acronym: acronym,
          latest_action: (p.metadata?.["latest_action"] as string | undefined) ?? null,
        }),
      };
    });
  console.log(`── Proposal summaries (${proposalSummaryRows.length} to seed, with source text) ──`);
  console.log(formatSkipTally(proposalSummarySkips));
  proposalSummaryCounts = await enqueueAll(db, "proposal", "summary", proposalSummaryRows, "proposal-summaries");
  console.log(`   ${fmt(proposalSummaryCounts)}\n`);

  // 3. Official summaries. FIX-896 removed the official TAG leg that used to sit
  //    here: AI issue-area classification for officials is retired (the model was
  //    being asked to name a real person's policy focus from name/party/state and
  //    a bare vote count). Officials get derived industry labels from donation
  //    sector affinity in tagOfficials() instead — no queue, no model.
  //
  //    Official SUMMARIES are deliberately untouched: whether an official profile
  //    summary is defensible is a separate policy question from whether an
  //    issue-area LABEL is, and `ai_summary_cache` holds zero official rows today
  //    regardless. `aggregateOfficialStats` stays — it feeds this summary context
  //    (and ai-summaries/index.ts).
  const summarizedOfficialIds = await summarizedEntityIds(db, "official", "profile");
  const officialIds = officials.map((o) => o.id);
  const stats = await aggregateOfficialStats(db, officialIds);

  const officialSummaryRows = officials
    .filter((o) => FORCE || !summarizedOfficialIds.has(o.id))
    .map((o) => {
      const agg = stats.get(o.id);
      return {
        entity_id: o.id,
        entity_type: "official" as const,
        task_type: "summary" as const,
        priority: jPriority.get(o.jurisdiction_id) ?? 0,
        entity_updated_at: o.updated_at,
        context: buildOfficialSummaryContext({
          id: o.id,
          full_name: o.full_name,
          role_title: o.role_title,
          state: (o.metadata?.["state"] as string | undefined) ?? null,
          party: o.party ?? null,
          vote_count: agg?.vote_count ?? 0,
          donor_count: agg?.donor_count ?? 0,
          total_raised: agg?.total_raised ?? 0,
        }),
      };
    });
  console.log(`── Official summaries (${officialSummaryRows.length} to seed) ──`);
  officialSummaryCounts = await enqueueAll(db, "official", "summary", officialSummaryRows, "official-summaries");
  console.log(`   ${fmt(officialSummaryCounts)}\n`);
  } // end !PACS_ONLY

  // 5. Financial entity industry tags — seed only entities without any industry tag.
  //    Rule-based pass (data:tag-rules) should run first; this seeds the remainder.
  //    The legacy `industry_hint` from `financial_entities.industry` was dropped
  //    in FIX-167 (the column was polluted with FEC CONNECTED_ORG_NM values, not
  //    sectors, so it actively misled the AI classifier).
  //
  //    PAC + party_committee rows seed at priority 100; other financial-entity
  //    types (corporation, super_pac, union, …) stay at the country-level
  //    baseline of 40 so the user-visible PAC sector treemap fills first.
  //    --pacs-only filters non-PAC types out of the queue entirely.
  type FinancialEntityRow = {
    id: string;
    display_name: string;
    entity_type: string;
    total_donated_cents: number;
    updated_at: string;
  };
  const financialEntities = await fetchAll<FinancialEntityRow>(
    "financial_entities",
    (from, to) => {
      let q = db
        .from("financial_entities")
        .select("id, display_name, entity_type, total_donated_cents, updated_at")
        .order("id") // FIX-760
        .range(from, to);
      if (PACS_ONLY) q = q.in("entity_type", ["pac", "party_committee"]);
      return q;
    },
  );

  const industryTaggedIds = await industryTaggedFinancialEntityIds(db);

  const feTagRows = financialEntities
    .filter((fe) => FORCE || !industryTaggedIds.has(fe.id))
    .map((fe) => {
      const isPac = fe.entity_type === "pac" || fe.entity_type === "party_committee";
      return {
        entity_id: fe.id,
        entity_type: "financial_entity" as EntityType,
        task_type: "tag" as TaskType,
        priority: isPac ? 100 : 40,
        entity_updated_at: fe.updated_at,
        context: buildFinancialEntityTagContext({
          id: fe.id,
          display_name: fe.display_name,
          entity_subtype: fe.entity_type,
          total_donated_cents: fe.total_donated_cents,
        }),
      };
    });
  console.log(`── Financial entity industry tags (${feTagRows.length} to seed) ──`);
  const feTagCounts = await enqueueAll(db, "financial_entity", "tag", feTagRows, "financial-entity-tags");
  console.log(`   ${fmt(feTagCounts)}\n`);

  // In --pacs-only mode, also bump priority on already-pending PAC tag rows.
  // The classifier in `enqueueAll` skips pending rows ("skipped_pending"), so
  // a fresh seed alone won't reorder a queue that already had PAC rows enqueued
  // at the older priority of 40.
  if (PACS_ONLY && !DRY_RUN) {
    const pacIds = financialEntities.map((fe) => fe.id);
    let bumped = 0;
    const BUMP_CHUNK = 100;
    for (let i = 0; i < pacIds.length; i += BUMP_CHUNK) {
      const batch = pacIds.slice(i, i + BUMP_CHUNK);
      const { data, error } = await db
        .from("enrichment_queue")
        .update({ priority: 100 })
        .eq("entity_type", "financial_entity")
        .eq("task_type", "tag")
        .eq("status", "pending")
        .lt("priority", 100)
        .in("entity_id", batch)
        .select("id");
      if (error) {
        console.error(`   ✗ priority bump batch ${i}-${i + batch.length}:`, error.message);
        continue;
      }
      bumped += (data ?? []).length;
    }
    console.log(`── Priority bump (existing pending PAC tag rows) ──`);
    console.log(`   bumped ${bumped} row(s) to priority=100\n`);
  } else if (PACS_ONLY && DRY_RUN) {
    console.log(`── Priority bump (existing pending PAC tag rows) — skipped in dry-run ──\n`);
  }

  // Summary report
  console.log(`══ Seed complete ════════════════════════════════════════════`);
  console.log(`   Proposal tags:              ${fmt(proposalTagCounts)}`);
  console.log(`   Proposal summaries:         ${fmt(proposalSummaryCounts)}`);
  console.log(`   Official tags:              retired (FIX-896)`);
  console.log(`   Official summaries:         ${fmt(officialSummaryCounts)}`);
  console.log(`   Financial entity tags:      ${fmt(feTagCounts)}`);
  if (DRY_RUN) console.log(`   (DRY RUN — nothing inserted)`);
}

main()
  .then(() => setTimeout(() => process.exit(0), 500))
  .catch((err) => {
    console.error("Seed failed:", err);
    setTimeout(() => process.exit(1), 500);
  });
