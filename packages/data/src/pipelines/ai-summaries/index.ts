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
 * Cost estimate per run:
 *   100 proposals × ~450 tokens = ~$0.026
 *   50  officials × ~300 tokens = ~$0.009
 *   Total: ~$0.035 (well within $4.00/month cap)
 *
 * Run:
 *   pnpm --filter @civitics/data data:ai-summaries
 *
 * Run (incremental — only new entities):
 *   pnpm --filter @civitics/data data:ai-summaries-new
 */

import { createAdminClient } from "@civitics/db";
import { createAiClient, MODELS } from "@civitics/ai";
import { sleep } from "../utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ProposalRow = {
  id: string;
  title: string;
  summary_plain: string | null;
  type: string;
  agency_name: string | null;
  agency_acronym: string | null;
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

// ---------------------------------------------------------------------------
// DB helpers (mirror client.ts internals — no re-export available)
// ---------------------------------------------------------------------------

const MONTHLY_SPEND_LIMIT_CENTS = 400; // $4.00

async function getMonthlySpendCents(): Promise<number> {
  try {
    const db = createAdminClient();
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data } = await (db as any)
      .from("api_usage_logs")
      .select("cost_cents")
      .eq("service", "anthropic")
      .gte("created_at", start.toISOString());
    return data?.reduce((sum: number, r: { cost_cents: number }) => sum + (r.cost_cents ?? 0), 0) ?? 0;
  } catch {
    return 0;
  }
}

async function writeSummaryCache(
  db: ReturnType<typeof createAdminClient>,
  entityType: string,
  entityId: string,
  summaryType: string,
  summaryText: string,
  model: string,
  tokensUsed: number
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).from("ai_summary_cache").upsert(
    { entity_type: entityType, entity_id: entityId, summary_type: summaryType, summary_text: summaryText, model, tokens_used: tokensUsed },
    { onConflict: "entity_type,entity_id,summary_type" }
  );
}

async function logApiUsage(
  db: ReturnType<typeof createAdminClient>,
  model: string,
  tokensUsed: number,
  costCents: number
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (db as any).from("api_usage_logs").insert({
    service: "anthropic",
    endpoint: "ai_summaries_pipeline",
    model,
    tokens_used: tokensUsed,
    cost_cents: costCents,
  });
}

function computeCostCents(inputTokens: number, outputTokens: number): number {
  // Haiku: $0.25/M input + $1.25/M output
  return Math.ceil((inputTokens * 0.00025 + outputTokens * 0.00125) / 10);
}

// ---------------------------------------------------------------------------
// Step 1 — Proposals
// ---------------------------------------------------------------------------

// Agency acronym → full name (subset; used for prompt context only)
const AGENCY_NAMES: Record<string, string> = {
  EPA: "Environmental Protection Agency",
  FAA: "Federal Aviation Administration",
  USCG: "U.S. Coast Guard",
  FCC: "Federal Communications Commission",
  FWS: "U.S. Fish and Wildlife Service",
  NOAA: "National Oceanic and Atmospheric Administration",
  IRS: "Internal Revenue Service",
  NCUA: "National Credit Union Administration",
  OSHA: "Occupational Safety and Health Administration",
  AMS: "Agricultural Marketing Service",
  CMS: "Centers for Medicare & Medicaid Services",
  OCC: "Office of the Comptroller of the Currency",
  NRC: "Nuclear Regulatory Commission",
  ED: "Department of Education",
  FERC: "Federal Energy Regulatory Commission",
  OPM: "Office of Personnel Management",
  FDA: "Food and Drug Administration",
  VA: "Department of Veterans Affairs",
  CPSC: "Consumer Product Safety Commission",
  NHTSA: "National Highway Traffic Safety Administration",
  HHS: "Department of Health and Human Services",
  DOT: "Department of Transportation",
  DOE: "Department of Energy",
  SEC: "Securities and Exchange Commission",
  CFTC: "Commodity Futures Trading Commission",
  FMCSA: "Federal Motor Carrier Safety Administration",
  FTA: "Federal Transit Administration",
};

async function fetchOpenProposals(db: ReturnType<typeof createAdminClient>): Promise<ProposalRow[]> {
  // Proposals store agency as metadata->>'agency_id' (acronym string), not a FK.
  // Fetch open proposals, then filter out those already cached.
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

  // Filter to those without a cached summary
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
      return {
        id: p.id,
        title: p.title,
        summary_plain: p.summary_plain ?? null,
        type: p.type,
        agency_acronym: acronym,
        agency_name: acronym ? (AGENCY_NAMES[acronym] ?? null) : null,
      };
    });
}

async function generateProposalSummaries(
  proposals: ProposalRow[],
  incremental: boolean
): Promise<{ summarized: number; skipped: number; failed: number; costCents: number }> {
  const db = createAdminClient();
  const ai = createAiClient();
  let summarized = 0, skipped = 0, failed = 0, totalCostCents = 0;

  console.log(`\n── Step 1: Proposals ─────────────────────────────────────`);
  console.log(`   ${proposals.length} proposals need summaries${incremental ? " (incremental)" : ""}`);

  for (const proposal of proposals) {
    // Re-check spend cap before each call
    const spent = await getMonthlySpendCents();
    if (spent + totalCostCents >= MONTHLY_SPEND_LIMIT_CENTS) {
      console.log(`   ⚠ Monthly spend cap reached — stopping at ${summarized} proposals`);
      break;
    }

    try {
      // Skip if there isn't enough context beyond the title alone
      const inputText = proposal.summary_plain ?? proposal.title;
      if (inputText.length < 100) {
        console.log(`   — Skipping (insufficient context): ${proposal.title.slice(0, 60)}…`);
        skipped++;
        continue;
      }

      const agencyLine = proposal.agency_name
        ? `${proposal.agency_name}${proposal.agency_acronym ? ` (${proposal.agency_acronym})` : ""}`
        : (proposal.agency_acronym ?? "Federal Agency");

      const userPrompt =
        `Summarize this federal proposal in 2-3 sentences in plain language.\n` +
        `Focus on: what is changing, who is affected, and why it matters.\n\n` +
        `Agency: ${agencyLine}\n` +
        `Title: ${proposal.title}\n` +
        `Summary: ${proposal.summary_plain ?? "No summary provided"}\n\n` +
        `Write as if explaining to someone with no policy background.`;

      const response = await ai.messages.create({
        model: MODELS.haiku,
        max_tokens: 300,
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
        writeSummaryCache(db, "proposal", proposal.id, "plain_language", summaryText, MODELS.haiku, inputTokens + outputTokens),
        logApiUsage(db, MODELS.haiku, inputTokens + outputTokens, costCents),
      ]);

      totalCostCents += costCents;
      summarized++;

      if (summarized <= 3) {
        console.log(`   ✓ [${summarized}] ${proposal.title.slice(0, 70)}…`);
        console.log(`       → ${summaryText.slice(0, 100)}…`);
      } else if (summarized % 10 === 0) {
        console.log(`   ✓ ${summarized} proposals done so far…`);
      }
    } catch (err) {
      console.error(`   ✗ ${proposal.id}: ${err instanceof Error ? err.message : String(err)}`);
      failed++;
    }

    // Respectful 300ms delay between API calls
    await sleep(300);
  }

  return { summarized, skipped, failed, costCents: totalCostCents };
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

  // Find which ones already have cached summaries
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
  incremental: boolean
): Promise<{ summarized: number; failed: number; costCents: number }> {
  const db = createAdminClient();
  const ai = createAiClient();
  let summarized = 0, failed = 0, totalCostCents = 0;

  console.log(`\n── Step 2: Officials ─────────────────────────────────────`);
  console.log(`   ${officials.length} officials need profiles${incremental ? " (incremental)" : ""}`);

  for (const official of officials) {
    const spent = await getMonthlySpendCents();
    if (spent + totalCostCents >= MONTHLY_SPEND_LIMIT_CENTS) {
      console.log(`   ⚠ Monthly spend cap reached — stopping at ${summarized} officials`);
      break;
    }

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
        logApiUsage(db, MODELS.haiku, inputTokens + outputTokens, costCents),
      ]);

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
  proposalStats: { summarized: number; skipped: number; failed: number; costCents: number },
  officialStats: { summarized: number; failed: number; costCents: number },
  db: ReturnType<typeof createAdminClient>
): Promise<void> {
  const totalCostCents = proposalStats.costCents + officialStats.costCents;
  const totalEntries = proposalStats.summarized + officialStats.summarized;

  // Get fresh monthly total from DB
  const monthlySpent = await getMonthlySpendCents();

  // Fetch 3 sample summaries
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const samplesRes = await (db as any)
    .from("ai_summary_cache")
    .select("entity_id, entity_type, summary_type, summary_text, created_at")
    .eq("entity_type", "proposal")
    .order("created_at", { ascending: false })
    .limit(3);

  console.log(`\n══ Results ═══════════════════════════════════════════════`);
  console.log(`   Proposals summarized: ${proposalStats.summarized}`);
  console.log(`   Proposals skipped:    ${proposalStats.skipped}`);
  console.log(`   Proposals failed:     ${proposalStats.failed}`);
  console.log(`   Officials summarized: ${officialStats.summarized}`);
  console.log(`   Officials failed:     ${officialStats.failed}`);
  console.log(`   Cache entries created: ${totalEntries}`);
  console.log(`   This run cost:        $${(totalCostCents / 100).toFixed(4)}`);
  console.log(`   Monthly spend to date: $${(monthlySpent / 100).toFixed(4)} / $4.00`);
  console.log(`   ✓ Cost stayed under $1.00: ${totalCostCents < 100 ? "YES" : "NO"}`);

  if (samplesRes.data?.length > 0) {
    console.log(`\n── Sample Outputs ────────────────────────────────────────`);
    for (const s of samplesRes.data) {
      console.log(`\n   Entity: ${s.entity_type} ${s.entity_id}`);
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

  // Check spend cap before starting
  const currentSpend = await getMonthlySpendCents();
  console.log(`    Monthly spend so far: $${(currentSpend / 100).toFixed(4)} / $4.00`);
  if (currentSpend >= MONTHLY_SPEND_LIMIT_CENTS) {
    console.log("    ✗ Monthly spend cap already reached — aborting");
    return;
  }

  // Step 1: Proposals
  const proposals = await fetchOpenProposals(db);
  const proposalStats = await generateProposalSummaries(proposals, incremental);

  // Step 2: Officials
  const officials = await fetchOfficials(db);
  const officialStats = await generateOfficialSummaries(officials, incremental);

  // Step 3: Report
  await reportResults(proposalStats, officialStats, db);
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const incremental = process.argv.includes("--incremental");

  runAiSummariesPipeline(incremental)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Fatal:", err);
      process.exit(1);
    });
}
