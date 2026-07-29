/**
 * AI Summaries Pipeline
 *
 * Generates and caches plain-language summaries for:
 *   Step 1 — Open-comment-period proposals (priority, most actionable)
 *   Step 2 — Federal officials with voting/donor records
 *
 * Skips entities already in ai_summary_cache.
 * 300ms delay between API calls to be respectful.
 *
 * Context levels for proposals:
 *   full_summary  — summary_plain > 100 chars → full 2-3 sentence summary
 *   title_only    — title only, no summary → 1-2 sentence inference from title + agency
 *   truly_empty   — no usable text at all → skipped, no API call
 *
 * Cost estimate per run:
 *   ~100 proposals × ~300 tokens (mix of full + title-only) = ~$0.020
 *    ~50 officials × ~300 tokens = ~$0.009
 *   Total: ~$0.029 (well within $4.00/month cap)
 *
 * Run:
 *   pnpm --filter @civitics/data data:ai-summaries
 *
 * Run (incremental — only new entities):
 *   pnpm --filter @civitics/data data:ai-summaries-new
 */

import { calculateCostUsd, createAdminClient, agencyFullName, rowsOrThrow, selectAllOrThrow } from "@civitics/db";
import { createAiClient, MODELS } from "@civitics/ai";
import { costGate } from "@civitics/ai/cost-gate";
import { sleep } from "../utils";
import { checkFlag, FLAGS } from "../../feature-flags";
import { startSync, completeSync, failSync } from "../sync-log";
import {
  enqueue,
  zeroCounts,
  buildProposalSummaryContext,
  hasUsableSourceText,
  tallySkip,
  formatSkipTally,
  type SkipTally,
  buildOfficialSummaryContext,
  aggregateOfficialStats,
  loadJurisdictionPriorities,
  classifyProposalContext,
} from "../enrichment/queue";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ContextLevel = "full_summary" | "title_only" | "truly_empty";

type ProposalRow = {
  id: string;
  title: string;
  summary_plain: string | null;
  type: string;
  agency_name: string | null;
  agency_acronym: string | null;
  latest_action: string | null;
  context_level: ContextLevel;
  jurisdiction_id: string;
  updated_at: string;
  // FIX-894: only used to break the enqueue gate's skip count down by source.
  primary_source: string | null;
};

type OfficialRow = {
  id: string;
  full_name: string;
  role_title: string;
  state: string | null;
  party: string | null;
  vote_count: number;
  donor_count: number;
  total_raised: number;
  jurisdiction_id: string;
  updated_at: string;
};

type ProposalStats = {
  summarized_full: number;
  summarized_title_only: number;
  skipped_truly_empty: number;
  failed: number;
  costCents: number;
};

// ---------------------------------------------------------------------------
// Context classification
// ---------------------------------------------------------------------------

// Delegates to the shared classifier so the live-API path and the queue path
// agree on the title-as-summary guard (FIX-434).
function classifyContext(summaryPlain: string | null, title: string): ContextLevel {
  return classifyProposalContext(summaryPlain, title);
}

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

async function writeSummaryCache(
  db: ReturnType<typeof createAdminClient>,
  entityType: string,
  entityId: string,
  summaryType: string,
  summaryText: string,
  model: string,
  tokensUsed: number,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).from("ai_summary_cache").upsert(
    { entity_type: entityType, entity_id: entityId, summary_type: summaryType, summary_text: summaryText, model, tokens_used: tokensUsed, metadata },
    { onConflict: "entity_type,entity_id,summary_type" }
  );
}

async function logApiUsage(
  db: ReturnType<typeof createAdminClient>,
  model: string,
  inputTokens: number,
  outputTokens: number,
  costCents: number
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).from("api_usage_logs").insert({
    service:       "anthropic",
    endpoint:      "ai_summaries_pipeline",
    model,
    tokens_used:   inputTokens + outputTokens,
    input_tokens:  inputTokens,
    output_tokens: outputTokens,
    cost_cents:    costCents,
  });
}

function computeCostCents(inputTokens: number, outputTokens: number): number {
  // FIX-893: was an inline (in*0.25 + out*1.25)/10_000 — a fifth private copy of
  // Haiku-3-era pricing, ~4x low. This site was NOT in the original FIX-893
  // brief; the literal-grep sweep found it. Exact fractional cents, no rounding.
  return calculateCostUsd(inputTokens, outputTokens, MODELS.haiku) * 100;
}

// ---------------------------------------------------------------------------
// Step 1 — Proposals
// ---------------------------------------------------------------------------

export async function fetchOpenProposals(db: ReturnType<typeof createAdminClient>): Promise<ProposalRow[]> {
  // Proposals store agency as metadata->>'agency_id' (acronym string), not a FK.
  // Post-cutover, comment_period_end lives in metadata JSONB (not a top-level column).
  // ISO 8601 strings compare lexicographically == chronologically, so .gt() against
  // a fresh now() ISO string still gives "still-open" semantics.
  // FIX-545: work-list read was log-and-continue (an error read as "no open
  // proposals" and the step skipped while the run looked clean).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposals = rowsOrThrow(
    await (db as any)
      .from("proposals")
      .select("id, title, summary_plain, type, metadata, jurisdiction_id, updated_at, primary_source")
      .gt("metadata->>comment_period_end", new Date().toISOString())
      .order("metadata->>comment_period_end", { ascending: true })
      .limit(200),
    "ai-summaries open-proposals work list",
  );

  // Filter to those without a cached summary (onlyNew applied here).
  // FIX-545: the cache read was silent-zero AND truncated at PostgREST's
  // 1,000-row cap — already-summarized proposals looked unsummarized and
  // re-burned Anthropic budget. Paginate + throw.
  const cacheRows = await selectAllOrThrow(
    "ai-summaries proposal cache preload",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (from, to) => (db as any)
      .from("ai_summary_cache")
      .select("entity_id")
      .eq("entity_type", "proposal")
      .eq("summary_type", "plain_language")
      .order("entity_id")
      .range(from, to),
  ) as { entity_id: string }[];
  const cached = new Set<string>(cacheRows.map((r) => r.entity_id));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return proposals
    .filter((p: any) => !cached.has(p.id))
    .slice(0, 100)
    .map((p: any) => {
      const acronym: string | null = p.metadata?.agency_id ?? null;
      const contextLevel = classifyContext(p.summary_plain ?? null, p.title ?? "");
      const primarySource = (p as { primary_source?: string | null }).primary_source ?? null;
      return {
        id: p.id,
        title: p.title ?? "",
        summary_plain: p.summary_plain ?? null,
        type: p.type,
        agency_acronym: acronym,
        agency_name: agencyFullName(acronym),
        latest_action: (p.metadata?.latest_action as string | undefined) ?? null,
        context_level: contextLevel,
        jurisdiction_id: p.jurisdiction_id ?? "",
        updated_at: p.updated_at ?? new Date().toISOString(),
        primary_source: primarySource,
      };
    });
}

function buildProposalPrompt(proposal: ProposalRow): { userPrompt: string; maxTokens: number } {
  const agencyLine = proposal.agency_name
    ? `${proposal.agency_name}${proposal.agency_acronym ? ` (${proposal.agency_acronym})` : ""}`
    : (proposal.agency_acronym ?? "Federal Agency");

  if (proposal.context_level === "full_summary") {
    return {
      maxTokens: 300,
      userPrompt:
        `Summarize this federal proposal in 2-3 sentences in plain language.\n` +
        `Focus on: what is changing, who is affected, and why it matters.\n\n` +
        `Agency: ${agencyLine}\n` +
        `Title: ${proposal.title}\n` +
        `Summary: ${proposal.summary_plain}\n\n` +
        `Write as if explaining to someone with no policy background.`,
    };
  }

  // title_only — infer from title + agency
  return {
    maxTokens: 200,
    userPrompt:
      `Based only on this federal regulation title and the issuing agency, write 1-2 sentences ` +
      `explaining what type of regulation this likely is and who it probably affects. ` +
      `Be clear this is based on the title only.\n\n` +
      `Agency: ${agencyLine}\n` +
      `Title: ${proposal.title}`,
  };
}

async function generateProposalSummaries(
  proposals: ProposalRow[],
  incremental: boolean,
  onTokens?: (input: number, output: number) => void
): Promise<ProposalStats> {
  const db = createAdminClient();
  const ai = createAiClient();
  let summarizedFull = 0, summarizedTitleOnly = 0, skippedTrulyEmpty = 0, failed = 0, totalCostCents = 0;

  const actionable = proposals.filter((p) => p.context_level !== "truly_empty");
  const trulyEmpty = proposals.filter((p) => p.context_level === "truly_empty");
  skippedTrulyEmpty = trulyEmpty.length;

  console.log(`\n── Step 1: Proposals ─────────────────────────────────────`);
  console.log(`   ${proposals.length} proposals need summaries${incremental ? " (incremental)" : ""}`);
  console.log(`     full_summary:  ${proposals.filter((p) => p.context_level === "full_summary").length}`);
  console.log(`     title_only:    ${proposals.filter((p) => p.context_level === "title_only").length}`);
  console.log(`     truly_empty:   ${skippedTrulyEmpty} (skipping — no usable text)`);

  for (const proposal of actionable) {
    try {
      const { userPrompt, maxTokens } = buildProposalPrompt(proposal);

      const response = await ai.messages.create({
        model: MODELS.haiku,
        max_tokens: maxTokens,
        system:
          "You are a plain language expert helping ordinary citizens understand federal regulations. " +
          "Write clear, jargon-free summaries that explain what a proposal means for real people. " +
          "Be factual and neutral. Never editorialize. " +
          "Write in plain prose only — no markdown, no headers, no bullet points, no bold text.",
        messages: [{ role: "user", content: userPrompt }],
      });

      const summaryText = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
      if (!summaryText) { failed++; continue; }

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const costCents = computeCostCents(inputTokens, outputTokens);

      await Promise.all([
        writeSummaryCache(
          db, "proposal", proposal.id, "plain_language", summaryText, MODELS.haiku,
          inputTokens + outputTokens,
          { context_level: proposal.context_level }
        ),
        logApiUsage(db, MODELS.haiku, inputTokens, outputTokens, costCents),
      ]);

      onTokens?.(inputTokens, outputTokens);
      totalCostCents += costCents;

      if (proposal.context_level === "full_summary") {
        summarizedFull++;
        const n = summarizedFull + summarizedTitleOnly;
        if (n <= 3) {
          console.log(`   ✓ [full] ${proposal.title.slice(0, 70)}…`);
          console.log(`       → ${summaryText.slice(0, 100)}…`);
        } else if (n % 10 === 0) {
          console.log(`   ✓ ${n} proposals done so far…`);
        }
      } else {
        summarizedTitleOnly++;
        const n = summarizedFull + summarizedTitleOnly;
        if (n <= 3) {
          console.log(`   ✓ [title] ${proposal.title.slice(0, 70)}…`);
          console.log(`       → ${summaryText.slice(0, 100)}…`);
        } else if (n % 10 === 0) {
          console.log(`   ✓ ${n} proposals done so far…`);
        }
      }
    } catch (err) {
      console.error(`   ✗ ${proposal.id}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }

    // Respectful 300ms delay between API calls
    await sleep(300);
  }

  return { summarized_full: summarizedFull, summarized_title_only: summarizedTitleOnly, skipped_truly_empty: skippedTrulyEmpty, failed, costCents: totalCostCents };
}

// ---------------------------------------------------------------------------
// Step 2 — Officials
// ---------------------------------------------------------------------------

export async function fetchOfficials(db: ReturnType<typeof createAdminClient>): Promise<OfficialRow[]> {
  // Fetch federal officials with the most data, excluding those already cached
  // FIX-545: work-list read was return-[]-on-error; cache read was
  // silent-zero + 1,000-row truncated (re-summarizing cached officials).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const officialRows = rowsOrThrow(
    await (db as any)
      .from("officials")
      .select("id, full_name, role_title, party, metadata, jurisdiction_id, updated_at")
      .in("role_title", ["Senator", "Representative"])
      .eq("is_active", true)
      .limit(200),
    "ai-summaries officials work list",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any[];

  const cacheRows = await selectAllOrThrow(
    "ai-summaries official cache preload",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (from, to) => (db as any)
      .from("ai_summary_cache")
      .select("entity_id")
      .eq("entity_type", "official")
      .eq("summary_type", "profile")
      .order("entity_id")
      .range(from, to),
  ) as { entity_id: string }[];
  const cached = new Set<string>(cacheRows.map((r) => r.entity_id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uncached = officialRows.filter((o: any) => !cached.has(o.id));
  const officialIds = uncached.map((o: { id: string }) => o.id).slice(0, 50);

  if (officialIds.length === 0) return [];

  // FIX-547: the prior inline reads selected the dead financial_relationships
  // official_id column (dropped at the 2026-04-22 cutover — the 400 was
  // silently swallowed) and the votes .in() read truncated at the 1,000-row
  // cap, so the vote/donor filter below ran on broken counts and silently
  // dropped officials from the summary pass. Route through the shared
  // RPC-backed aggregate instead.
  const stats = await aggregateOfficialStats(db, officialIds);

  // Only include officials with votes OR donor records
  return uncached
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((o: any) => {
      const agg = stats.get(o.id);
      return {
        id: o.id,
        full_name: o.full_name,
        role_title: o.role_title,
        state: o.metadata?.state ?? null,
        party: o.party ?? null,
        vote_count: agg?.vote_count ?? 0,
        donor_count: agg?.donor_count ?? 0,
        total_raised: agg?.total_raised ?? 0,
        jurisdiction_id: o.jurisdiction_id ?? "",
        updated_at: o.updated_at ?? new Date().toISOString(),
      };
    })
    .filter((o: OfficialRow) => o.vote_count > 0 || o.donor_count > 0)
    .sort((a: OfficialRow, b: OfficialRow) => b.vote_count - a.vote_count)
    .slice(0, 50);
}

async function generateOfficialSummaries(
  officials: OfficialRow[],
  incremental: boolean,
  onTokens?: (input: number, output: number) => void
): Promise<{ summarized: number; failed: number; costCents: number }> {
  const db = createAdminClient();
  const ai = createAiClient();
  let summarized = 0, failed = 0, totalCostCents = 0;

  console.log(`\n── Step 2: Officials ─────────────────────────────────────`);
  console.log(`   ${officials.length} officials need profiles${incremental ? " (incremental)" : ""}`);

  for (const official of officials) {

    try {
      const itemizedDollars = (official.total_raised / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });

      // FIX-931: kept byte-identical to the on-demand route's prompt in
      // apps/civitics/app/api/officials/[id]/summary/route.ts — the two write
      // into the SAME ai_summary_cache, so a reader cannot tell which produced
      // the text they are reading and the framing must not depend on that.
      // The labels are the model's only description of these numbers: the money
      // is the all-cycle ITEMIZED donation sum (no unitemized giving, no JFC
      // transfers, no IEs, no loans) and the count is donor-and-cycle rows, not
      // distinct donors.
      const userPrompt =
        `Write a 2-sentence factual profile of this official based on their record.\n` +
        `Focus on their role and legislative activity. Be completely neutral.\n` +
        `Do not describe the donation figure as total money raised — it is a partial, ` +
        `itemized-only subset. Do not describe the donor figure as a number of donors.\n\n` +
        `Name: ${official.full_name}\n` +
        `Title: ${official.role_title}\n` +
        `State: ${official.state ?? "Unknown"}\n` +
        `Party: ${official.party ?? "Unknown"}\n` +
        `Votes on record: ${official.vote_count.toLocaleString()}\n` +
        `Donor records (donor-and-cycle pairs, not distinct donors): ${official.donor_count.toLocaleString()}\n` +
        `Itemized donations, all cycles (excludes unitemized giving, transfers, ` +
        `independent expenditures and loans): ${itemizedDollars}`;

      const response = await ai.messages.create({
        model: MODELS.haiku,
        max_tokens: 200,
        system:
          "You are a civic analyst writing neutral factual profiles of elected officials for citizens. " +
          "Be factual, balanced, and brief. " +
          "Write in plain prose only — no markdown, no headers, no bullet points, no bold text.",
        messages: [{ role: "user", content: userPrompt }],
      });

      const summaryText = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
      if (!summaryText) { failed++; continue; }

      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      const costCents = computeCostCents(inputTokens, outputTokens);

      await Promise.all([
        writeSummaryCache(db, "official", official.id, "profile", summaryText, MODELS.haiku, inputTokens + outputTokens),
        logApiUsage(db, MODELS.haiku, inputTokens, outputTokens, costCents),
      ]);

      onTokens?.(inputTokens, outputTokens);
      totalCostCents += costCents;
      summarized++;

      if (summarized <= 3) {
        console.log(`   ✓ ${official.full_name} (${official.role_title})`);
        console.log(`       → ${summaryText.slice(0, 100)}…`);
      } else if (summarized % 10 === 0) {
        console.log(`   ✓ ${summarized} officials done so far…`);
      }
    } catch (err) {
      console.error(`   ✗ ${official.id} (${official.full_name}): ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }

    await sleep(300);
  }

  return { summarized, failed, costCents: totalCostCents };
}

// ---------------------------------------------------------------------------
// Step 3 — Verify and report
// ---------------------------------------------------------------------------

async function reportResults(
  proposalStats: ProposalStats,
  officialStats: { summarized: number; failed: number; costCents: number },
  db: ReturnType<typeof createAdminClient>
): Promise<void> {
  const totalCostCents = proposalStats.costCents + officialStats.costCents;
  const totalEntries = proposalStats.summarized_full + proposalStats.summarized_title_only + officialStats.summarized;

  // Fetch 3 sample summaries
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const samplesRes = await (db as any)
    .from("ai_summary_cache")
    .select("entity_id, entity_type, summary_type, summary_text, metadata, created_at")
    .eq("entity_type", "proposal")
    .order("created_at", { ascending: false })
    .limit(3);

  console.log(`\n══ Results ═══════════════════════════════════════════════`);
  console.log(`   Proposals summarized:  ${proposalStats.summarized_full + proposalStats.summarized_title_only}`);
  console.log(`     full_summary:        ${proposalStats.summarized_full}`);
  console.log(`     title_only:          ${proposalStats.summarized_title_only}`);
  console.log(`   Proposals skipped:     ${proposalStats.skipped_truly_empty} (truly empty — no title)`);
  console.log(`   Proposals failed:      ${proposalStats.failed}`);
  console.log(`   Officials summarized:  ${officialStats.summarized}`);
  console.log(`   Officials failed:      ${officialStats.failed}`);
  console.log(`   Cache entries created: ${totalEntries}`);
  console.log(`   This run cost:         $${(totalCostCents / 100).toFixed(4)}`);

  if (samplesRes.data?.length > 0) {
    console.log(`\n── Sample Outputs ────────────────────────────────────────`);
    for (const s of samplesRes.data) {
      const level = (s.metadata as { context_level?: string } | null)?.context_level ?? "unknown";
      console.log(`\n   Entity: ${s.entity_type} ${s.entity_id} [${level}]`);
      console.log(`   Summary: ${s.summary_text}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runAiSummariesPipeline(incremental = false): Promise<void> {
  console.log(`\n═══ AI Summaries Pipeline ════════════════════════════════`);
  console.log(`    Mode: ${incremental ? "incremental (new entities only)" : "full (all unsummarized)"}`);
  console.log(`    Time: ${new Date().toISOString()}`);

  const db = createAdminClient();

  // ── Queue mode ───────────────────────────────────────────────────────────
  // When CIVITICS_ENRICHMENT_MODE=queue, stage work for an external worker
  // instead of calling Anthropic. Scope stays narrow (open-comment proposals
  // + active Sen/Rep with records) — the seed-backlog script is responsible
  // for widening to "everything missing."
  if (FLAGS.ENRICHMENT_MODE === "queue") {
    console.log("    Mode: queue — staging to enrichment_queue, no API calls");
    const proposals = await fetchOpenProposals(db);
    const officials = await fetchOfficials(db);

    const jIds = [
      ...proposals.map((p) => p.jurisdiction_id),
      ...officials.map((o) => o.jurisdiction_id),
    ].filter(Boolean) as string[];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jPriority = await loadJurisdictionPriorities(db as any, jIds);

    const counts = zeroCounts();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const q = db as any;
    // FIX-894: was `context_level === "truly_empty"` only, which staged every
    // title_only proposal — a summary generated from nothing but its title.
    // Now requires real source text. Proposals only; the officials loop below
    // builds context from structured aggregates and is governed separately.
    const summarySkips: SkipTally = new Map();
    for (const p of proposals) {
      if (!hasUsableSourceText(p.summary_plain, p.title)) {
        tallySkip(summarySkips, p.primary_source);
        continue;
      }
      const action = await enqueue(q, {
        entity_id: p.id,
        entity_type: "proposal",
        task_type: "summary",
        context: buildProposalSummaryContext({
          id: p.id,
          title: p.title,
          summary_plain: p.summary_plain,
          type: p.type,
          agency_name: p.agency_name,
          agency_acronym: p.agency_acronym,
          latest_action: p.latest_action,
        }),
        priority: jPriority.get(p.jurisdiction_id) ?? 0,
        entity_updated_at: p.updated_at,
      });
      counts[action]++;
    }
    for (const o of officials) {
      const action = await enqueue(q, {
        entity_id: o.id,
        entity_type: "official",
        task_type: "summary",
        context: buildOfficialSummaryContext({
          id: o.id,
          full_name: o.full_name,
          role_title: o.role_title,
          state: o.state,
          party: o.party,
          vote_count: o.vote_count,
          donor_count: o.donor_count,
          total_raised: o.total_raised,
        }),
        priority: jPriority.get(o.jurisdiction_id) ?? 0,
        entity_updated_at: o.updated_at,
      });
      counts[action]++;
    }
    console.log(formatSkipTally(summarySkips));
    console.log(
      `    [queue] proposals=${proposals.filter((p) => hasUsableSourceText(p.summary_plain, p.title)).length} officials=${officials.length} ${JSON.stringify(counts)}`,
    );
    return;
  }

  // ── Recency guard ────────────────────────────────────────────────────────
  // Prevent re-runs within 2 hours. Pass --force to override.
  const force = process.argv.includes("--force");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: recencyState } = await (db as any)
    .from("pipeline_state")
    .select("value")
    .eq("key", "ai_summaries_last_run")
    .maybeSingle();
  const lastRunTs = (recencyState?.value as Record<string, unknown> | null)?.last_run as string | undefined;
  if (lastRunTs && !force) {
    const hoursSince = (Date.now() - new Date(lastRunTs).getTime()) / 3_600_000;
    if (hoursSince < 2) {
      console.log(
        `⏭  AI Summaries skipping — ran ${hoursSince.toFixed(1)}h ago. Min interval: 2h. Use --force to override.`
      );
      return;
    }
  }
  if (force) {
    console.log("⚠  --force flag set: skipping recency guard");
  }
  // ─────────────────────────────────────────────────────────────────────────

  const ai = createAiClient();
  const logId = await startSync("ai_summaries");

  try {
  // Fetch entities first (cache filter applied inside each fetch fn)
  const proposals = await fetchOpenProposals(db);
  const officials  = await fetchOfficials(db);

  // FIX 2: Count only proposals that will actually get API calls — exclude truly_empty.
  // The cache filter (onlyNew) is already applied in fetchOpenProposals/fetchOfficials.
  const actionableProposals = proposals.filter((p) => p.context_level !== "truly_empty");
  const totalEntities = actionableProposals.length + officials.length;

  if (totalEntities === 0) {
    console.log("    ✓ Nothing to summarize — all entities are cached");
    if (proposals.some((p) => p.context_level === "truly_empty")) {
      console.log(`    (${proposals.filter((p) => p.context_level === "truly_empty").length} truly-empty proposals skipped)`);
    }
    await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 });
    return;
  }

  // Sample from the first actionable proposal (representative of cost)
  const sampleProposal = actionableProposals[0] ?? {
    id: "sample",
    title: "Sample Federal Proposal",
    summary_plain: "This is a sample proposal for cost estimation purposes.",
    type: "rule",
    agency_name: "Federal Agency",
    agency_acronym: "FA",
    context_level: "full_summary" as ContextLevel,
  };

  const gate = await costGate.gate({
    pipelineName: "ai_summaries",
    entityCount:  totalEntities,   // count after cache filter + truly_empty exclusion
    model:        MODELS.haiku,
    sampleFn: async () => {
      const { userPrompt, maxTokens } = buildProposalPrompt(sampleProposal);
      return ai.messages.create({
        model:      MODELS.haiku,
        max_tokens: maxTokens,
        system:
          "You are a plain language expert helping ordinary citizens understand federal regulations. " +
          "Write clear, jargon-free summaries that explain what a proposal means for real people. " +
          "Be factual and neutral. Never editorialize. " +
          "Write in plain prose only — no markdown, no headers, no bullet points, no bold text.",
        messages: [{ role: "user", content: userPrompt }],
      });
    },
  });

  if (!gate.approved) {
    await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 });
    return;
  }

  // Apply entity limit if the gate capped us due to budget
  const proposalLimit = gate.entity_limit
    ? Math.min(proposals.length, gate.entity_limit)
    : proposals.length;
  const officialLimit = gate.entity_limit
    ? Math.max(0, gate.entity_limit - proposalLimit)
    : officials.length;

  // Track tokens across both steps
  let totalInputTokens  = 0;
  let totalOutputTokens = 0;

  // Step 1: Proposals
  const proposalStats = await generateProposalSummaries(
    proposals.slice(0, proposalLimit),
    incremental,
    (input, output) => { totalInputTokens += input; totalOutputTokens += output; }
  );

  // Step 2: Officials
  const officialStats = await generateOfficialSummaries(
    officials.slice(0, officialLimit),
    incremental,
    (input, output) => { totalInputTokens += input; totalOutputTokens += output; }
  );

  // Step 3: Report actual costs
  if (gate.run_id) {
    await costGate.complete(gate.run_id, totalInputTokens, totalOutputTokens, MODELS.haiku);
  }

  await reportResults(proposalStats, officialStats, db);

  // Persist last-run timestamp for recency guard
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).from("pipeline_state").upsert(
    { key: "ai_summaries_last_run", value: { last_run: new Date().toISOString() } },
    { onConflict: "key" }
  );

    const inserted =
      proposalStats.summarized_full +
      proposalStats.summarized_title_only +
      officialStats.summarized;
    const failed = proposalStats.failed + officialStats.failed;
    const estimatedMb = +((inserted * 600) / 1024 / 1024).toFixed(2);
    await completeSync(logId, { inserted, updated: 0, failed, estimatedMb });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await failSync(logId, msg);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  if (!checkFlag("AI_SUMMARIES_ENABLED", "ai-summaries")) process.exit(0);
  const incremental = process.argv.includes("--incremental");
  const confirmed = process.argv.includes("--confirm");

  if (!incremental && !confirmed) {
    console.log("[ai-summaries] Non-incremental run against ALL entities will spend uncapped Claude credits.");
    console.log("[ai-summaries] Re-run with --confirm to proceed, or --incremental for the daily safe path.");
    process.exit(0);
  }

  runAiSummariesPipeline(incremental)
    .then(() => { setTimeout(() => process.exit(0), 500); })
    .catch((err) => {
      console.error("Pipeline failed:", err);
      setTimeout(() => process.exit(1), 500);
    });
}
