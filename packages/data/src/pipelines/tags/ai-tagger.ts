/**
 * AI-powered PROPOSAL tagger.
 *
 * Uses claude-haiku-4-5-20251001 — cheapest model, great at classification.
 * Only runs on proposals that don't already have AI topic tags.
 *
 * FIX-896 — officials are NO LONGER AI-classified. classifyOfficial() asked the
 * model for an official's "primary policy focus areas" from full_name /
 * role_title / party / state / a bare vote_count NUMBER / total_raised / a
 * PAC-vs-individual percentage — nothing about what the official actually voted
 * on. For officials with votes that answer could only come from training-data
 * priors about a named public figure; for the ~22.8k active officials with no
 * votes, donations, or committee it reduced to name + party + state. `confidence`
 * was self-reported and `visibility` gated on it, so the quality gate was the
 * model grading its own homework — an unsourceable inferred claim about a named
 * real person. The generalized rule: AI-classify only where the classification
 * derives from text we hold. An official is not a document; a proposal is.
 * Officials now get DERIVED, citeable industry labels from donation sector
 * affinity — see tagOfficials() in ./rules.ts (FIX-897).
 *
 * Cost estimate before running full batch:
 *   1 proposal classification: ~150 input + ~30 output tokens ≈ $0.00008
 *
 * Reports estimate and requires --confirm flag to run full batch.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:tag-ai
 *   pnpm --filter @civitics/data data:tag-ai -- --confirm   (run full batch)
 *   pnpm --filter @civitics/data data:tag-ai -- --dry-run   (estimate only)
 */

import { createAdminClient, fetchAllKeyset, afterKey } from "@civitics/db";
import { createAiClient } from "@civitics/ai";
import { costGate } from "@civitics/ai/cost-gate";
import { calculateCostUsd } from "@civitics/db";
import { startSync, completeSync, failSync } from "../sync-log";
import { checkFlag, FLAGS } from "../../feature-flags";
import { TOPIC_ICONS, VALID_TOPICS } from "./topics";
import {
  enqueue,
  zeroCounts,
  buildProposalTagContext,
  hasUsableSourceText,
  tallySkip,
  formatSkipTally,
  type SkipTally,
  loadJurisdictionPriorities,
} from "../enrichment/queue";
import { withDirectClient } from "../../lib/direct-pg-upsert";

const AI_MODEL = "claude-haiku-4-5-20251001";

// Max cost per standalone invocation ($0.10 = 10 cents)
const DEFAULT_MAX_COST_CENTS = 10;

// FIX-823 — upper bound on candidate rows fetched per onlyNew run. Comfortably
// above the maxCostCents (~$0.10 ≈ a few hundred items) ceiling, so the cost
// cap — not this LIMIT — is what stops the run.
const AI_CANDIDATE_LIMIT = 2000;

// FIX-893: HAIKU_INPUT_COST_PER_M / HAIKU_OUTPUT_COST_PER_M lived here and were
// a third private copy of Haiku-3-era pricing (~4x low). Prices now come only
// from packages/db/src/ai-pricing.ts via calculateCostUsd.

const anthropic = createAiClient();

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

let sessionCostCents = 0;
// FIX-893: real per-call usage is now accumulated alongside cost, so the
// gate's recorded actuals carry measured token counts instead of counts
// reverse-engineered from a cost figure (see costGate.complete below).
let sessionInputTokens = 0;
let sessionOutputTokens = 0;

function trackCost(inputTokens: number, outputTokens: number): number {
  const cost = Math.round(
    calculateCostUsd(inputTokens, outputTokens, AI_MODEL) * 100 * 100
  ) / 100; // cost in cents, 2dp
  sessionCostCents += cost;
  sessionInputTokens += inputTokens;
  sessionOutputTokens += outputTokens;
  return cost;
}

// 50 req/min rate limit → 1.3s between calls to stay safe
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Proposal topic classification
// ---------------------------------------------------------------------------

interface ProposalClassification {
  topics: string[];
  confidence: number;
  primary_topic: string;
  affects_individuals: boolean;
  technical_complexity: "low" | "medium" | "high";
}

async function classifyProposal(proposal: {
  id: string;
  title: string | null;
  summary_plain: string | null;
  metadata: Record<string, unknown> | null;
}): Promise<ProposalClassification | null> {
  const agencyId = String(proposal.metadata?.agency_id ?? "");
  const summary = (proposal.summary_plain ?? "").slice(0, 300);

  const userMessage =
    `Classify this federal proposal.\n\n` +
    `Title: ${proposal.title ?? "(untitled)"}\n` +
    `Agency: ${agencyId}\n` +
    `Summary: ${summary}\n\n` +
    `Return JSON:\n` +
    `{\n` +
    `  "topics": ["topic1", "topic2"],\n` +
    `  "confidence": 0.0-1.0,\n` +
    `  "primary_topic": "topic1",\n` +
    `  "affects_individuals": true,\n` +
    `  "technical_complexity": "low"\n` +
    `}\n\n` +
    `Topics must be from this list only:\n` +
    VALID_TOPICS.join(", ") + `\n\n` +
    `Return 1-3 topics maximum. Only topics with > 0.6 confidence.`;

  try {
    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 200,
      system:
        "You are a government policy classifier. Classify proposals into topic categories. " +
        "Respond ONLY with valid JSON. No explanation, no markdown, no code fences.",
      messages: [{ role: "user", content: userMessage }],
    });

    trackCost(message.usage.input_tokens, message.usage.output_tokens);
    await sleep(1300);

    const raw   = message.content[0]?.type === "text" ? message.content[0].text : "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<ProposalClassification>;

    // Validate topics against allowed list
    const validTopics = (parsed.topics ?? []).filter((t) => VALID_TOPICS.includes(t));
    if (validTopics.length === 0) return null;

    return {
      topics:              validTopics,
      confidence:          typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      primary_topic:       validTopics[0],
      affects_individuals: parsed.affects_individuals ?? false,
      technical_complexity: parsed.technical_complexity ?? "medium",
    };
  } catch (err) {
    console.error(`    Classification failed for proposal ${proposal.id}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runProposalAiTagger(db: any, maxCostCents: number, onlyNew: boolean): Promise<number> {
  console.log("\n  [AI] Classifying proposals...");

  type ProposalRow = { id: string; title: string | null; summary_plain: string | null; metadata: Record<string, unknown> | null };

  let proposals: ProposalRow[];
  if (onlyNew) {
    // FIX-823 — server-side anti-join: only untagged proposals, newest first,
    // bounded by LIMIT. Replaces the prior load-all-proposals + fetchDistinctIds
    // + in-memory filter (two full scans on the cold Micro to feed a run the
    // maxCostCents cap stops after a few hundred items). Same candidate set
    // (untagged), just server-side, ordered, and bounded.
    proposals = await fetchUntaggedForAi<ProposalRow>(
      "proposal",
      ["id", "title", "summary_plain", "metadata"],
      AI_CANDIDATE_LIMIT,
    );
    if (proposals.length === 0) {
      console.log("    All proposals already have AI topic tags. Skipping.");
      return 0;
    }
  } else {
    // Full retag (manual --confirm without onlyNew): page the entire proposals
    // table (unchanged). FIX-476 — a stable unique order key so PostgREST's
    // 1,000-row cap paginates cleanly instead of silently truncating.
    // FIX-984: keyset on the `id` pkey rather than OFFSET. Deep pages of this
    // walk measured cost 22,539 · 76,520 buffers · 852 ms on prod (91,302
    // proposals, 2026-09-04); the keyset page is cost 499 · 431 buffers · 121 ms.
    const PROPOSAL_PAGE = 1000;
    const res = await fetchAllKeyset<ProposalRow, string>(
      "ai-tagger full-retag proposals",
      (after, limit) => afterKey(
        db
          .from("proposals")
          .select("id, title, summary_plain, metadata")
          .order("id", { ascending: true })
          .limit(limit), "id", after),
      { key: (r) => r.id, pageSize: PROPOSAL_PAGE },
    );
    if (res.error) { console.error("    Error fetching proposals:", res.error.message); return 0; }
    const allProposals: ProposalRow[] = res.rows;
    if (allProposals.length === 0) { console.log("    No proposals to classify."); return 0; }
    proposals = allProposals;
  }

  console.log(`    ${proposals.length} proposals to classify`);

  let tagsInserted = 0;

  for (const proposal of proposals) {
    if (sessionCostCents >= maxCostCents) {
      console.log(`    Cost limit reached ($${(maxCostCents / 100).toFixed(2)}). Stopping.`);
      break;
    }

    const result = await classifyProposal(proposal);
    if (!result) continue;

    const tags = [];

    for (const topic of result.topics) {
      const confidence = result.confidence;
      const visibility = confidence >= 0.8 ? "primary" : "secondary";

      tags.push({
        entity_type:    "proposal",
        entity_id:      proposal.id,
        tag:            topic,
        tag_category:   "topic",
        display_label:  topic.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
        display_icon:   TOPIC_ICONS[topic] ?? null,
        visibility:     confidence < 0.7 ? "internal" : visibility,
        generated_by:   "ai",
        confidence,
        ai_model:       AI_MODEL,
        pipeline_version: "v1",
        metadata: {
          reasoning:          result.primary_topic,
          affects_individuals: result.affects_individuals,
          is_primary:         topic === result.primary_topic,
        },
      });
    }

    // Technical complexity tag
    if (result.technical_complexity) {
      const complexityTag = result.technical_complexity === "high" ? "technical" : "accessible";
      const complexityLabel = result.technical_complexity === "high" ? "Technical" : "Accessible";
      tags.push({
        entity_type:    "proposal",
        entity_id:      proposal.id,
        tag:            complexityTag,
        tag_category:   "quality",
        display_label:  complexityLabel,
        display_icon:   null,
        visibility:     "secondary",
        generated_by:   "ai",
        confidence:     1.0,
        ai_model:       AI_MODEL,
        pipeline_version: "v1",
        metadata: { complexity_level: result.technical_complexity },
      });
    }

    for (const tag of tags) {
      const { error: insertErr } = await db.from("entity_tags").upsert(tag, {
        onConflict: "entity_type,entity_id,tag,tag_category",
      });
      if (!insertErr) tagsInserted++;
    }
  }

  console.log(`    Inserted ${tagsInserted} AI proposal tags (cost so far: $${(sessionCostCents / 100).toFixed(4)})`);
  return tagsInserted;
}

// ---------------------------------------------------------------------------
// FIX-896 — classifyOfficial() / runOfficialAiTagger() lived here and are gone.
// See the module header for why. Officials get derived industry labels from
// donation sector affinity in tagOfficials() (./rules.ts), not model output.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Shared fetch helpers — used by the inline path, the queue-mode branch, and
// the backlog seeder. "Needing tags" = no (entity_type, generated_by=ai,
// tag_category=topic) row in entity_tags.
//
// FIX-896: `official` left this map along with the official tagger. The type is
// a one-member union rather than a bare string so a future entity type has to be
// added deliberately (and to keep the $1 bind and the table name in lockstep).
// ---------------------------------------------------------------------------

const AI_TABLE_BY_ENTITY: Record<"proposal", string> = {
  proposal: "proposals",
};
const SAFE_IDENT = /^[a-z_][a-z0-9_]*$/i;

/**
 * Shared "untagged" predicate for the AI-topic tagger: an entity of the given
 * type with NO (entity_type, generated_by='ai', tag_category='topic') row in
 * entity_tags. Aliased `p` (the entity) / `t` (the tag), binds entity_type as $1.
 * Both the candidate SELECT (fetchUntaggedForAi) and the cost-estimate COUNT
 * (countUntaggedForAi) build on this one fragment so they can never drift
 * (FIX-824).
 *
 * FIX-896: the `activeOnly` parameter appended an `officials.is_active` guard
 * and had exactly one caller — the official tagger. It went with it; proposals
 * have no is_active column.
 */
function untaggedWhere(): string {
  return (
    `WHERE NOT EXISTS (` +
    `SELECT 1 FROM public.entity_tags t ` +
    `WHERE t.entity_type = $1 AND t.entity_id = p.id ` +
    `AND t.generated_by = 'ai' AND t.tag_category = 'topic')`
  );
}

/**
 * FIX-823 — server-side anti-join for AI-untagged entities. Replaces the
 * load-entire-table-into-Node + fetchDistinctIds + in-memory-filter pattern
 * (two full scans on the cold Micro to feed a maxCostCents-capped run that only
 * touches a few hundred rows). A single `NOT EXISTS` returns only untagged
 * rows, newest first, bounded by LIMIT — the cost cap, not the LIMIT, stops the
 * run. "Untagged" == no (entity_type, generated_by='ai', tag_category='topic')
 * row in entity_tags — byte-for-byte the prior in-memory predicate and
 * fetchDistinctIds' filter. Seeks via idx_entity_tags_entity
 * (entity_type, entity_id). Runs over withDirectClient, whose buildDbUrl()
 * resolves local Docker / CI SUPABASE_DB_URL / composed prod pooler alike.
 *
 * `cols` are code-controlled literals; each is asserted against SAFE_IDENT
 * before interpolation (mirrors direct-pg-upsert.ts quoteIdent). Values bind as
 * $1/$2. node-pg returns timestamptz as a Date; we normalize those back to ISO
 * strings so callers forwarding updated_at into enqueue() see the PostgREST shape.
 */
export async function fetchUntaggedForAi<T>(
  entityType: "proposal",
  cols: string[],
  limit: number,
): Promise<T[]> {
  const table = AI_TABLE_BY_ENTITY[entityType];
  for (const c of cols) {
    if (!SAFE_IDENT.test(c)) throw new Error(`fetchUntaggedForAi: unsafe column ${JSON.stringify(c)}`);
  }
  const selectList = cols.map((c) => `p.${c}`).join(", ");
  const sql =
    `SELECT ${selectList} FROM public.${table} p ` +
    `${untaggedWhere()} ` +
    `ORDER BY p.created_at DESC LIMIT $2`;
  const rows = await withDirectClient((client) =>
    client.query(sql, [entityType, limit]).then((r) => r.rows as Record<string, unknown>[]),
  );
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (row[k] instanceof Date) row[k] = (row[k] as Date).toISOString();
    }
  }
  return rows as T[];
}

/**
 * FIX-824 — server-side COUNT of AI-untagged entities, sharing untaggedWhere()
 * with fetchUntaggedForAi so the cost-gate estimate and the candidate selection
 * apply the identical predicate. Replaces four full id-projection scans that were
 * paginated into Node and diffed in memory (the pre-FIX-824 onlyNew estimate).
 * Distinct-by-construction (one row per entity), so no tag-row-count subtraction.
 */
export async function countUntaggedForAi(entityType: "proposal"): Promise<number> {
  const table = AI_TABLE_BY_ENTITY[entityType];
  const sql =
    `SELECT count(*)::bigint AS n FROM public.${table} p ` +
    `${untaggedWhere()}`;
  return withDirectClient((client) =>
    client.query(sql, [entityType]).then((r) => Number((r.rows[0] as { n: string }).n)),
  );
}

export type ProposalNeedingTags = {
  id: string;
  title: string;
  summary_plain: string | null;
  metadata: Record<string, unknown> | null;
  jurisdiction_id: string;
  updated_at: string;
  // FIX-894: only used to break the enqueue gate's skip count down by source.
  primary_source: string | null;
};

export async function fetchProposalsNeedingTags(limit = 2000): Promise<ProposalNeedingTags[]> {
  // FIX-823 — server-side anti-join (see fetchUntaggedForAi). No db needed.
  return fetchUntaggedForAi<ProposalNeedingTags>(
    "proposal",
    ["id", "title", "summary_plain", "metadata", "jurisdiction_id", "updated_at", "primary_source"],
    limit,
  );
}

// FIX-896: OfficialNeedingTags / fetchOfficialsNeedingTags() were the queue-mode
// half of the official tagger — they staged an official-tag task per untagged
// active official. Removed with the classifier. Nothing enqueues official tag
// tasks any more; the rows already staged are marked by data:sweep-official-tags
// (FIX-898).

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runAiTagger(options?: {
  maxCostCents?: number;
  onlyNew?: boolean;
}): Promise<{ tagsCreated: number; costCents: number }> {
  const onlyNew = options?.onlyNew ?? true;

  console.log("\n=== AI tagger ===");
  console.log(`  Only new: ${onlyNew} | Model: ${AI_MODEL}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  // ── Queue mode ───────────────────────────────────────────────────────────
  // When CIVITICS_ENRICHMENT_MODE=queue, stage work for an external worker
  // instead of calling Anthropic. No cost gate, no rate-limit sleep, no
  // recency guard — staging is cheap and idempotent.
  if (FLAGS.ENRICHMENT_MODE === "queue") {
    console.log("  Mode: queue — staging to enrichment_queue, no API calls");
    const proposals = await fetchProposalsNeedingTags();

    const jIds = proposals.map((p) => p.jurisdiction_id).filter(Boolean) as string[];
    const jPriority = await loadJurisdictionPriorities(db, jIds);

    const counts = zeroCounts();
    // FIX-894: gate on actual source text — a topic classified from a title
    // alone is the model supplying the knowledge rather than the record.
    // FIX-896 resolved the "separate decision" this comment used to defer for
    // officials: officials aren't AI-classified at all now, so proposals are the
    // only thing staged here.
    const tagSkips: SkipTally = new Map();
    for (const p of proposals) {
      if (!hasUsableSourceText(p.summary_plain, p.title)) {
        tallySkip(tagSkips, p.primary_source);
        continue;
      }
      const action = await enqueue(db, {
        entity_id: p.id,
        entity_type: "proposal",
        task_type: "tag",
        context: buildProposalTagContext(p),
        priority: jPriority.get(p.jurisdiction_id) ?? 0,
        entity_updated_at: p.updated_at,
      });
      counts[action]++;
    }
    console.log(formatSkipTally(tagSkips));
    console.log(`  [queue] proposals=${proposals.length} ${JSON.stringify(counts)}`);
    return { tagsCreated: counts.created + counts.retried, costCents: 0 };
  }

  // ── Recency guard ────────────────────────────────────────────────────────
  // Prevent re-runs within 2 hours. Pass --force to override.
  const force = process.argv.includes("--force");
  const { data: recencyState } = await db
    .from("pipeline_state")
    .select("value")
    .eq("key", "tags_last_run")
    .maybeSingle();
  const lastRunTs = (recencyState?.value as Record<string, unknown> | null)?.last_run as string | undefined;
  if (lastRunTs && !force) {
    const hoursSince = (Date.now() - new Date(lastRunTs).getTime()) / 3_600_000;
    if (hoursSince < 2) {
      console.log(
        `⏭  AI Tagger skipping — ran ${hoursSince.toFixed(1)}h ago. Min interval: 2h. Use --force to override.`
      );
      return { tagsCreated: 0, costCents: 0 };
    }
  }
  if (force) {
    console.log("⚠  --force flag set: skipping recency guard");
  }
  // ─────────────────────────────────────────────────────────────────────────

  const logId = await startSync("tag_ai");

  sessionCostCents = 0;
  sessionInputTokens = 0;
  sessionOutputTokens = 0;

  try {
    // Fetch a sample proposal to use for cost estimation
    // reads-ok: cost-estimate sample only; a hard-coded fallback row below covers the empty case
    const { data: sampleProposals } = await db
      .from("proposals")
      .select("id, title, summary_plain, metadata")
      .limit(1);

    const sampleProposal = sampleProposals?.[0] ?? {
      id: "sample",
      title: "Sample Federal Proposal",
      summary_plain: "Sample summary for cost estimation.",
      metadata: { agency_id: "EPA" },
    };

    // Count entities that ACTUALLY need processing — apply onlyNew filter FIRST
    // so costGate estimate reflects the untagged subset, not the full table.
    let totalEntities: number;
    if (onlyNew) {
      // FIX-824: a server-side COUNT anti-join over withDirectClient, sharing
      // untaggedWhere() with fetchUntaggedForAi so the estimate and the candidate
      // selection apply the identical predicate. Replaces four full id-projection
      // scans that were paginated into Node and diffed in memory (FIX-430/760) —
      // distinct-by-construction, no page-boundary or 1,000-row-cap hazards.
      // FIX-896: the officials half of this count went with the official tagger.
      totalEntities = await countUntaggedForAi("proposal");
    } else {
      const proposalRes = await db.from("proposals").select("id", { count: "exact", head: true });
      totalEntities = proposalRes.count ?? 0;
    }

    // Wire cost gate
    const gate = await costGate.gate({
      pipelineName: "ai_tagger",
      entityCount:  Math.max(1, totalEntities),
      model:        AI_MODEL,
      sampleFn: async () => {
        const agencyId = sampleProposal.metadata?.agency_id ?? "";
        const summary = (sampleProposal.summary_plain ?? "").slice(0, 300);
        const userMessage =
          `Classify this federal proposal.\n\n` +
          `Title: ${sampleProposal.title}\nAgency: ${agencyId}\nSummary: ${summary}\n\n` +
          `Return JSON: {"topics":["topic1"],"confidence":0.8,"primary_topic":"topic1","affects_individuals":true,"technical_complexity":"low"}\n\n` +
          `Topics must be from: ${VALID_TOPICS.join(", ")}`;

        return anthropic.messages.create({
          model:      AI_MODEL,
          max_tokens: 200,
          system:
            "You are a government policy classifier. Classify proposals into topic categories. " +
            "Respond ONLY with valid JSON. No explanation, no markdown, no code fences.",
          messages: [{ role: "user", content: userMessage }],
        });
      },
    });

    if (!gate.approved) {
      await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 });
      return { tagsCreated: 0, costCents: 0 };
    }

    // Run the actual taggers — use per-run limit from cost gate config
    const maxCostCents = gate.estimate.run_limit_usd * 100;

    const totalTags = await runProposalAiTagger(db, maxCostCents, onlyNew);

    console.log("\n  ─────────────────────────────────────────────────");
    console.log("  AI tagger report");
    console.log("  ─────────────────────────────────────────────────");
    console.log(`  ${"Proposal tags:".padEnd(32)} ${totalTags}`);
    console.log(`  ${"Total cost:".padEnd(32)} $${(sessionCostCents / 100).toFixed(4)}`);

    // Record actual costs via gate
    if (gate.run_id) {
      // FIX-893: this used to invert the (wrong) cost formula to reconstruct
      // token counts — dividing cost by a blended 0.45/M rate and assuming an
      // 80/20 input/output split. That inversion is doubly wrong now the rate
      // is corrected, and it was never necessary: trackCost() sees real
      // message.usage on every call, so carry those numbers through.
      await costGate.complete(
        gate.run_id,
        sessionInputTokens,
        sessionOutputTokens,
        AI_MODEL,
      );
    }

    await completeSync(logId, { inserted: totalTags, updated: 0, failed: 0, estimatedMb: 0 });

    // Persist last-run timestamp for recency guard
    await db.from("pipeline_state").upsert(
      { key: "tags_last_run", value: { last_run: new Date().toISOString() } },
      { onConflict: "key" }
    );

    return { tagsCreated: totalTags, costCents: sessionCostCents };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  AI tagger fatal error:", msg);
    await failSync(logId, msg);
    return { tagsCreated: 0, costCents: sessionCostCents };
  }
}

// ---------------------------------------------------------------------------
// Cost estimate (no API calls)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function estimateCost(db: any): Promise<void> {
  // FIX-896: the officials leg of this estimate went with the official tagger.
  const [proposalRes, taggedProposalRes] = await Promise.all([
    db.from("proposals").select("id", { count: "exact", head: true }),
    db.from("entity_tags").select("entity_id", { count: "exact", head: true })
      .eq("entity_type", "proposal").eq("generated_by", "ai").eq("tag_category", "topic"),
  ]);

  const totalProposals   = proposalRes.count ?? 0;
  const taggedProposals  = taggedProposalRes.count ?? 0;
  const untaggedProposals = Math.max(0, totalProposals - taggedProposals);

  const totalCost = untaggedProposals * 0.000075; // ~$0.000075 each

  console.log("\n  ─────────────────────────────────────────────────");
  console.log("  AI tagger cost estimate");
  console.log("  ─────────────────────────────────────────────────");
  console.log(`  Proposals:  ${untaggedProposals.toLocaleString()} untagged / ${totalProposals.toLocaleString()} total → ~$${totalCost.toFixed(2)}`);
  console.log(`  Total estimate: ~$${totalCost.toFixed(2)}`);
  console.log(`\n  To run: pnpm --filter @civitics/data data:tag-ai -- --confirm`);
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    if (!checkFlag("AI_TAGGER_ENABLED", "ai-tagger")) process.exit(0);
    const args = process.argv.slice(2);
    const isDryRun = args.includes("--dry-run") || (!args.includes("--confirm"));
    const isConfirmed = args.includes("--confirm");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;

    if (isDryRun && !isConfirmed) {
      console.log("\n=== AI tagger — cost estimate ===");
      console.log("  (No API calls will be made. Pass --confirm to run.)\n");
      await estimateCost(db);
      process.exit(0);
    }

    try {
      await runAiTagger({ maxCostCents: DEFAULT_MAX_COST_CENTS, onlyNew: true });
      process.exit(0);
    } catch (err) {
      console.error("Fatal:", err);
      process.exit(1);
    }
  })();
}
