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

import { createAdminClient, agencyFullName } from "@civitics/db";
import { createAiClient, MODELS } from "@civitics/ai";
import { costGate } from "@civitics/ai/cost-gate";
import { sleep } from "../utils";
import { checkFlag } from "../../feature-flags";

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
  context_level: ContextLevel;
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

function classifyContext(summaryPlain: string | null, title: string): ContextLevel {
  if ((summaryPlain?.length ?? 0) > 100) return "full_summary";
  if (title.trim().length >= 10) return "title_only";
  return "truly_empty";
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
  // Haiku: $0.25/M input + $1.25/M output → exact fractional cents, no rounding
  return (inputTokens * 0.25 + outputTokens * 1.25) / 10_000;
}

// ---------------------------------------------------------------------------
// Step 1 — Proposals
// ---------------------------------------------------------------------------

async function fetchOpenProposals(db: ReturnType<typeof createAdminClient>): Promise<ProposalRow[]> {
  // Proposals store agency as metadata->>'agency_id' (acronym string), not a FK.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await (db as any)
    .from("proposals")
    .select("id, title, summary_plain, type, metadata")
    .gt("comment_period_end", new Date().toISOString())
    .order("comment_period_end", { ascending: true })
    .limit(200);

  if (result.error || !result.data) {
    console.error("   ✗ Proposal fetch error:", result.error?.message ?? "no data");
    return [];
  }

  // Filter to those without a cached summary (onlyNew applied here)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cacheCheck = await (db as any)
    .from("ai_summary_cache")
    .select("entity_id")
    .eq("entity_type", "proposal")
    .eq("summary_type", "plain_language");

  const cached = new Set<string>((cacheCheck.data ?? []).map((r: { entity_id: string }) => r.entity_id));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return result.data
    .filter((p: any) => !cached.has(p.id))
    .slice(0, 100)
    .map((p: any) => {
      const acronym: string | null = p.metadata?.agency_id ?? null;
      const contextLevel = classifyContext(p.summary_plain ?? null, p.title ?? "");
      return {
        id: p.id,
        title: p.title ?? "",
        summary_plain: p.summary_plain ?? null,
        type: p.type,
        agency_acronym: acronym,
        agency_name: agencyFullName(acronym),
        context_level: contextLevel,
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

async function fetchOfficials(db: ReturnType<typeof createAdminClient>): Promise<OfficialRow[]> {
  // Fetch federal officials with the most data, excluding those already cached
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const officialsRes = await (db as any)
    .from("officials")
    .select("id, full_name, role_title, party, metadata")
    .in("role_title", ["Senator", "Representative"])
    .eq("is_active", true)
    .limit(200);

  if (officialsRes.error || !officialsRes.data) return [];

  // Find which ones already have cached summaries (onlyNew applied here)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cacheCheck = await (db as any)
    .from("ai_summary_cache")
    .select("entity_id")
    .eq("entity_type", "official")
    .eq("summary_type", "profile");

  const cached = new Set<string>((cacheCheck.data ?? []).map((r: { entity_id: string }) => r.entity_id));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const uncached = officialsRes.data.filter((o: any) => !cached.has(o.id));
  const officialIds = uncached.map((o: { id: string }) => o.id).slice(0, 50);

  if (officialIds.length === 0) return [];

  // Get vote counts
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const votesRes = await (db as any)
    .from("votes")
    .select("official_id")
    .in("official_id", officialIds);

  const voteCounts = new Map<string, number>();
  for (const v of votesRes.data ?? []) {
    voteCounts.set(v.official_id, (voteCounts.get(v.official_id) ?? 0) + 1);
  }

  // Get donor counts + totals
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const donorRes = await (db as any)
    .from("financial_relationships")
    .select("official_id, amount_cents")
    .in("official_id", officialIds);

  const donorCounts = new Map<string, number>();
  const donorTotals = new Map<string, number>();
  for (const d of donorRes.data ?? []) {
    donorCounts.set(d.official_id, (donorCounts.get(d.official_id) ?? 0) + 1);
    donorTotals.set(d.official_id, (donorTotals.get(d.official_id) ?? 0) + (d.amount_cents ?? 0));
  }

  // Only include officials with votes OR donor records
  return uncached
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .map((o: any) => ({
      id: o.id,
      full_name: o.full_name,
      role_title: o.role_title,
      state: o.metadata?.state ?? null,
      party: o.party ?? null,
      vote_count: voteCounts.get(o.id) ?? 0,
      donor_count: donorCounts.get(o.id) ?? 0,
      total_raised: donorTotals.get(o.id) ?? 0,
    }))
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
      const totalRaisedDollars = (official.total_raised / 100).toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      });

      const userPrompt =
        `Write a 2-sentence factual profile of this official based on their record.\n` +
        `Focus on their role and legislative activity. Be completely neutral.\n\n` +
        `Name: ${official.full_name}\n` +
        `Title: ${official.role_title}\n` +
        `State: ${official.state ?? "Unknown"}\n` +
        `Party: ${official.party ?? "Unknown"}\n` +
        `Votes on record: ${official.vote_count.toLocaleString()}\n` +
        `Donor relationships: ${official.donor_count.toLocaleString()}\n` +
        `Total raised: ${totalRaisedDollars}`;

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

  if (!gate.approved) return;

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
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  if (!checkFlag("AI_SUMMARIES_ENABLED", "ai-summaries")) process.exit(0);
  const incremental = process.argv.includes("--incremental");

  runAiSummariesPipeline(incremental)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
}
