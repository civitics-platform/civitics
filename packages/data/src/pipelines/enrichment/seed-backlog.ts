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

import { createAdminClient, agencyFullName, selectAllKeyset, afterKey } from "@civitics/db";
import {
  financialEntityPopulation,
  parseMaxEnqueue,
  ceilingVerdict,
  formatPlanTable,
} from "./seed-plan";
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
// FIX-1158: it doubles as the override for the --max-enqueue ceiling below.
const FORCE = process.argv.includes("--force");
// --pacs-only: skip proposals/officials entirely; only enqueue PAC + party_committee
// industry tags at priority 100 so they drain ahead of any other backlog.
const PACS_ONLY = process.argv.includes("--pacs-only");

// ── FIX-1158: the financial-entity arm's default population ──────────────────
//
// --all-financial-entities: include entity_type='individual' in the FE arm.
// OFF by default, and the default is the fix.
//
// This arm walks ALL financial_entities (5,204,854 on prod 2026-09-04) and
// enqueues everything without an industry tag. Individuals are 4,975,895 of
// that and NONE of them carry an industry tag, so on the default path every
// single one qualified: one mistyped invocation of a manual script staged ~4.98
// million rows of downstream drain work, each of which is a model call. Craig is
// pre-revenue; this is the cost blow-up class the project designs against.
//
// Individuals are not a legitimate member of this queue, and that is measured,
// not assumed. The rule tagger is explicitly scoped to non-individual entities
// (tags/rules.ts, FIX-437) with a partial index
// `financial_entities_nonindividual_id ... WHERE entity_type <> 'individual'`
// built for exactly that predicate. On the prod clone (2026-09-05) the industry
// tag rows cover corporation 29,157 / other 9,184 / pac 2,918 / union 167 /
// super_pac 130 / party_committee 77 / nonprofit 3 — and individual ZERO,
// against a population of 3,453,892 individuals. Every financial_entity row
// already in enrichment_queue is likewise non-individual.
//
// The exclusion goes in the QUERY, not in a post-filter, so the FIX-984 keyset
// walk itself shrinks from 5.2M rows to ~229k rather than streaming 5M rows to
// throw them away.
const ALL_FINANCIAL_ENTITIES = process.argv.includes("--all-financial-entities");

// ── FIX-1158: the ceiling ────────────────────────────────────────────────────
//
// Nothing is written until the whole plan is built and counted, and a plan
// bigger than this refuses rather than running. --dry-run prints the same table
// and writes nothing at all.
const MAX_ENQUEUE = (() => {
  try {
    return parseMaxEnqueue(process.argv);
  } catch (err) {
    console.error(`[seed-backlog] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
})();
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
// selectAllKeyset fails the run instead.
//
// FIX-984: keyset, not OFFSET. Every walk below is keyed on the table's uuid
// `id` pkey, so a page is one index range scan from the cursor that stops at
// LIMIT. It matters most at :475 — that one walks ALL of financial_entities
// (5,204,854 rows on prod as of 2026-09-04), which under OFFSET meant a seq
// scan + a 374 MB external-merge sort of the whole table PER PAGE, 5,205 times
// (measured: cost 1,005,602 · 245,569 buffers · 36,420 ms for the last page
// alone; keyset is cost 1,065 · 949 buffers · 893 ms).
//
// Every loader must `.order("id")`, `.limit(limit)`, and pass the cursor
// through `afterKey(q, "id", after)` — the three have to name the same column.
async function fetchAll<T extends { id?: string }>(
  label: string,
  loader: (after: string | null, limit: number) => Promise<{ data: T[] | null; error: { message: string } | null }>,
  key: (row: T) => string = (row) => row.id as string,
): Promise<T[]> {
  return selectAllKeyset<T, string>(label, loader, { key, pageSize: PAGE });
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
  const rows = await fetchAll<{ id: string; entity_id: string }>(
    `entity_tags(${entityType})`,
    (after, limit) =>
      afterKey(
        db
          .from("entity_tags")
          .select("id, entity_id")
          .eq("entity_type", entityType)
          .eq("generated_by", "ai")
          .eq("tag_category", "topic")
          // FIX-760 total order / FIX-984 keyset key: the same unique column
          // must appear in .order(), in .limit()'s cursor, and in the seek.
          .order("id") // FIX-984: keyset key
          .limit(limit),
        "id",
        after,
      ),
  );
  return new Set(rows.map((r) => r.entity_id));
}

// Returns IDs that already have ANY industry tag (rule or AI) — skip those.
async function industryTaggedFinancialEntityIds(db: Db): Promise<Set<string>> {
  const rows = await fetchAll<{ id: string; entity_id: string }>(
    "entity_tags(financial_entity,industry)",
    (after, limit) =>
      afterKey(
        db
          .from("entity_tags")
          .select("id, entity_id")
          .eq("entity_type", "financial_entity")
          .eq("tag_category", "industry")
          .order("id") // FIX-760 (total order) / FIX-984 (keyset key)
          .limit(limit),
        "id",
        after,
      ),
  );
  return new Set(rows.map((r) => r.entity_id));
}

async function summarizedEntityIds(
  db: Db,
  entityType: "proposal" | "official",
  summaryType: string,
): Promise<Set<string>> {
  const rows = await fetchAll<{ id: string; entity_id: string }>(
    `ai_summary_cache(${entityType},${summaryType})`,
    (after, limit) =>
      afterKey(
        db
          .from("ai_summary_cache")
          .select("id, entity_id")
          .eq("entity_type", entityType)
          .eq("summary_type", summaryType)
          .order("id") // FIX-760 (total order) / FIX-984 (keyset key)
          .limit(limit),
        "id",
        after,
      ),
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
  return fetchAll<ProposalRow>("proposals", (after, limit) =>
    afterKey(
      db
        .from("proposals")
        .select("id, title, summary_plain, type, metadata, jurisdiction_id, updated_at, primary_source")
        .not("title", "ilike", "On %")
        .filter("title", "not.ilike", "% v. %")
        .order("id") // FIX-760 (total order) / FIX-984 (keyset key)
        .limit(limit),
      "id",
      after,
    ),
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
  return fetchAll<OfficialRow>("officials", (after, limit) =>
    afterKey(
      db
        .from("officials")
        .select("id, full_name, role_title, party, metadata, jurisdiction_id, updated_at")
        .eq("is_active", true)
        .order("id") // FIX-760 (total order) / FIX-984 (keyset key)
        .limit(limit),
      "id",
      after,
    ),
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
  const rows = await fetchAll<{ id: string; entity_id: string; status: string; retry_count: number }>(
    `enrichment_queue(${entityType},${taskType})`,
    (after, limit) =>
      afterKey(
        db
          .from("enrichment_queue")
          .select("id, entity_id, status, retry_count")
          .eq("entity_type", entityType)
          .eq("task_type", taskType)
          .order("id") // FIX-760 (total order) / FIX-984 (keyset key)
          .limit(limit),
        "id",
        after,
      ),
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

type SeedRow = {
  entity_id: string;
  entity_type: EntityType;
  task_type: "tag" | "summary";
  context: unknown;
  priority: number;
  entity_updated_at: string;
};

/**
 * FIX-1158 — one arm's classified work, NOT yet written.
 *
 * Planning is split from applying so the run can count everything it is about
 * to do before it does any of it. Without that split, the --max-enqueue ceiling
 * could only ever fire after earlier arms had already committed their rows, and
 * --dry-run's per-type table could not exist at all.
 */
type EnqueuePlan = {
  entityType: EntityType;
  taskType: TaskType;
  label: string;
  counts: EnqueueCounts;
  /** Only "created" + "retried" rows — the ones that would actually be upserted. */
  toWrite: SeedRow[];
};

async function planEnqueue(
  db: Db,
  entityType: EntityType,
  taskType: TaskType,
  rows: SeedRow[],
  label: string,
): Promise<EnqueuePlan> {
  const counts = zeroCounts();
  const empty: EnqueuePlan = { entityType, taskType, label, counts, toWrite: [] };
  if (rows.length === 0) return empty;

  const snapshot = await fetchQueueSnapshot(db, entityType, taskType);

  type Classified = { row: SeedRow; action: EnqueueAction };
  const classified: Classified[] = rows.map((row) => ({
    row,
    action: classifyAction(snapshot.get(row.entity_id)),
  }));
  for (const c of classified) counts[c.action]++;

  // Only "created" and "retried" rows hit the DB.
  const toWrite = classified
    .filter((c) => c.action === "created" || c.action === "retried")
    .map((c) => c.row);

  return { entityType, taskType, label, counts, toWrite };
}

async function applyEnqueue(db: Db, plan: EnqueuePlan): Promise<void> {
  const { toWrite, label } = plan;
  if (toWrite.length === 0) return;

  // Including status/claimed_*/last_error in the payload makes INSERT use
  // defaults (which match) and ON CONFLICT DO UPDATE reset them — matching the
  // RPC's retried path. retry_count is intentionally omitted so it stays at 0
  // on INSERT and is preserved on UPDATE.
  const toUpsert = toWrite;
  let errors = 0;
  for (let i = 0; i < toUpsert.length; i += UPSERT_CHUNK) {
    const chunk = toUpsert.slice(i, i + UPSERT_CHUNK).map((r) => ({
      entity_id: r.entity_id,
      entity_type: r.entity_type,
      task_type: r.task_type,
      context: r.context,
      priority: r.priority,
      entity_updated_at: r.entity_updated_at,
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
}

/** Flatten every plan's writable rows to the (type, task, priority) keys the table groups on. */
function planTableRows(plans: EnqueuePlan[]) {
  return plans.flatMap((p) =>
    p.toWrite.map((r) => ({
      entity_type: r.entity_type as string,
      task_type: r.task_type as string,
      priority: r.priority,
    })),
  );
}

export function planTotal(plans: EnqueuePlan[]): number {
  return plans.reduce((sum, p) => sum + p.toWrite.length, 0);
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
  console.log(`    Mode: ${DRY_RUN ? "DRY RUN" : "LIVE"}${FORCE ? " + FORCE (reseed done items; ceiling override)" : ""}${PACS_ONLY ? " + PACS-ONLY (skip proposals/officials)" : ""}${ALL_FINANCIAL_ENTITIES ? " + ALL-FINANCIAL-ENTITIES (individuals INCLUDED)" : ""}`);
  console.log(`    FE pool: ${PACS_ONLY ? "pac + party_committee only" : ALL_FINANCIAL_ENTITIES ? "every financial_entity INCLUDING individuals" : "every financial_entity EXCEPT individuals (FIX-1158 default)"}`);
  console.log(`    Ceiling: ${MAX_ENQUEUE.toLocaleString()} rows${FORCE ? " (overridden by --force)" : ""}`);
  console.log(`    Time: ${new Date().toISOString()}\n`);

  const db = createAdminClient() as unknown as Db;

  // FIX-1158: every arm plans into here; NOTHING is written until the whole
  // plan is counted and the ceiling has passed.
  const plans: EnqueuePlan[] = [];

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
  const proposalTagPlan = await planEnqueue(db, "proposal", "tag", proposalTagRows, "proposal-tags");
  plans.push(proposalTagPlan);
  proposalTagCounts = proposalTagPlan.counts;
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
  const proposalSummaryPlan = await planEnqueue(db, "proposal", "summary", proposalSummaryRows, "proposal-summaries");
  plans.push(proposalSummaryPlan);
  proposalSummaryCounts = proposalSummaryPlan.counts;
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
  const officialSummaryPlan = await planEnqueue(db, "official", "summary", officialSummaryRows, "official-summaries");
  plans.push(officialSummaryPlan);
  officialSummaryCounts = officialSummaryPlan.counts;
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
    (after, limit) => {
      // FIX-984: the walk that most needed keyset. Unfiltered this is all
      // 5,204,854 financial_entities; under OFFSET the planner seq-scanned and
      // external-merge-sorted the whole table for EVERY one of the ~5,205 pages
      // (last page measured on prod 2026-09-04: 245,569 buffers + 374 MB temp,
      // 36,420 ms). Keyset is a pkey range scan: 949 buffers, 893 ms.
      //
      // FIX-1158: the DEFAULT population excludes individuals, and the
      // exclusion is a QUERY predicate rather than a post-filter so the walk
      // itself shrinks -- ~229k non-individual rows instead of streaming all
      // 5,204,854 and discarding 4,975,895 of them. `entity_type <> 'individual'`
      // is the same predicate the FIX-437 partial index
      // `financial_entities_nonindividual_id` was built for, so the rule tagger
      // and this seeder now walk the population by the same route.
      let q = db
        .from("financial_entities")
        .select("id, display_name, entity_type, total_donated_cents, updated_at")
        .order("id") // FIX-760 (total order) / FIX-984 (keyset key)
        .limit(limit);
      const pop = financialEntityPopulation({
        pacsOnly: PACS_ONLY,
        allFinancialEntities: ALL_FINANCIAL_ENTITIES,
      });
      if (pop.kind === "pacs_only") q = q.in("entity_type", pop.entityTypes);
      else if (pop.kind === "exclude_individuals") q = q.neq("entity_type", pop.excludedEntityType);
      return afterKey(q, "id", after);
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
  const feTagPlan = await planEnqueue(db, "financial_entity", "tag", feTagRows, "financial-entity-tags");
  plans.push(feTagPlan);
  const feTagCounts = feTagPlan.counts;
  console.log(`   ${fmt(feTagCounts)}\n`);

  // -- FIX-1158: count first, then decide, then write -------------------------
  //
  // Everything above only PLANNED. This is the first point at which the run
  // knows its own total, and the first point at which anything could be
  // written. That ordering is the whole fix: a ceiling checked after the first
  // arm has already committed is not a ceiling.
  console.log(`══ Enqueue plan ═════════════════════════════════════════════`);
  console.log(formatPlanTable(planTableRows(plans)));
  console.log("");

  const total = planTotal(plans);
  const verdict = ceilingVerdict(total, MAX_ENQUEUE, FORCE);

  // --dry-run is a SURVEY: it reports the verdict it would have hit and exits
  // 0, because it wrote nothing and "tell me what this would do" must not be a
  // failure. Only a live run refuses.
  if (DRY_RUN) {
    console.log(`   [dry-run] ${total.toLocaleString()} row(s) would be upserted -- nothing written.`);
    if (verdict === "refuse") {
      console.log(
        `   [dry-run] a LIVE run would REFUSE this plan: ${total.toLocaleString()} > the ` +
          `--max-enqueue ceiling of ${MAX_ENQUEUE.toLocaleString()}.`,
      );
    }
    console.log("");
  } else if (verdict === "refuse") {
    console.error(
      `[seed-backlog] REFUSING: this run would enqueue ${total.toLocaleString()} rows, ` +
        `over the --max-enqueue ceiling of ${MAX_ENQUEUE.toLocaleString()}.`,
    );
    console.error(
      `[seed-backlog] Every row is downstream drain work and a model call, so a plan this ` +
        `size is a cost decision, not a default.`,
    );
    console.error(
      `[seed-backlog] If it is genuinely intended: re-run with --max-enqueue ${total} ` +
        `(preferred -- it records the number you agreed to) or with --force. ` +
        `--dry-run prints this table and writes nothing.`,
    );
    process.exit(1);
  } else {
    for (const plan of plans) {
      await applyEnqueue(db, plan);
    }
  }

  // In --pacs-only mode, also bump priority on already-pending PAC tag rows.
  // The classifier in `planEnqueue` skips pending rows ("skipped_pending"), so
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
