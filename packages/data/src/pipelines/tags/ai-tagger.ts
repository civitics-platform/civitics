/**
 * AI-powered entity tagger.
 *
 * Uses claude-haiku-4-5-20251001 — cheapest model, great at classification.
 * Only runs on entities that don't already have AI topic tags.
 *
 * Cost estimate before running full batch:
 *   1 proposal classification: ~150 input + ~30 output tokens ≈ $0.00008
 *   1,917 proposals: ~$0.15
 *   8,042 officials: ~$0.45
 *   Total: ~$0.60
 *
 * Reports estimate and requires --confirm flag to run full batch.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:tag-ai
 *   pnpm --filter @civitics/data data:tag-ai -- --confirm   (run full batch)
 *   pnpm --filter @civitics/data data:tag-ai -- --dry-run   (estimate only)
 */

import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@civitics/db";
import { startSync, completeSync, failSync } from "../sync-log";

const AI_MODEL = "claude-haiku-4-5-20251001";

// Max cost per standalone invocation ($0.10 = 10 cents)
const DEFAULT_MAX_COST_CENTS = 10;

// Haiku pricing (per million tokens)
const HAIKU_INPUT_COST_PER_M  = 0.25;  // $0.25/M input
const HAIKU_OUTPUT_COST_PER_M = 1.25;  // $1.25/M output

const anthropic = new Anthropic({ apiKey: process.env["CIVITICS_ANTHROPIC_API_KEY"] });

// ---------------------------------------------------------------------------
// Topic icon map
// ---------------------------------------------------------------------------

const TOPIC_ICONS: Record<string, string> = {
  climate:             "🌊",
  healthcare:          "🏥",
  finance:             "📈",
  education:           "📚",
  housing:             "🏠",
  transportation:      "🚗",
  agriculture:         "🌾",
  energy:              "⚡",
  defense:             "🛡",
  technology:          "💻",
  labor:               "👷",
  immigration:         "🌍",
  civil_rights:        "⚖️",
  veterans:            "🎖",
  food_safety:         "🍽",
  consumer_protection: "🛡",
  environment:         "🌊",
  public_health:       "🏥",
  trade:               "🤝",
  other:               "📋",
};

const VALID_TOPICS = Object.keys(TOPIC_ICONS);

const ISSUE_AREAS = [
  "healthcare", "climate", "finance", "education", "defense",
  "technology", "labor", "agriculture", "housing", "immigration",
  "civil_rights", "veterans", "energy", "trade",
];

// ---------------------------------------------------------------------------
// Cost tracking
// ---------------------------------------------------------------------------

let sessionCostCents = 0;

function trackCost(inputTokens: number, outputTokens: number): number {
  const cost = Math.round(
    ((inputTokens * HAIKU_INPUT_COST_PER_M + outputTokens * HAIKU_OUTPUT_COST_PER_M) / 1_000_000) * 10000
  ) / 100; // cost in cents, 2dp
  sessionCostCents += cost;
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
  title: string;
  summary_plain: string | null;
  metadata: Record<string, string> | null;
}): Promise<ProposalClassification | null> {
  const agencyId = proposal.metadata?.agency_id ?? "";
  const summary = (proposal.summary_plain ?? "").slice(0, 300);

  const userMessage =
    `Classify this federal proposal.\n\n` +
    `Title: ${proposal.title}\n` +
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
  console.log("\n  [AI 1/2] Classifying proposals...");

  // Fetch proposals without existing AI topic tags
  let proposalQuery = db
    .from("proposals")
    .select("id, title, summary_plain, metadata");

  // Fetch all proposals; filter in-memory to avoid huge .in() URL params
  const { data: allProposals, error } = await proposalQuery.limit(2000);
  if (error) { console.error("    Error fetching proposals:", error.message); return 0; }
  if (!allProposals || allProposals.length === 0) { console.log("    No proposals to classify."); return 0; }

  let proposals = allProposals;

  if (onlyNew) {
    const { data: taggedIds } = await db
      .from("entity_tags")
      .select("entity_id")
      .eq("entity_type", "proposal")
      .eq("generated_by", "ai")
      .eq("tag_category", "topic");
    const alreadyTagged = new Set((taggedIds ?? []).map((r: { entity_id: string }) => r.entity_id));
    proposals = allProposals.filter((p: { id: string }) => !alreadyTagged.has(p.id));
    if (proposals.length === 0) {
      console.log("    All proposals already have AI topic tags. Skipping.");
      return 0;
    }
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
// Official issue area classification
// ---------------------------------------------------------------------------

interface OfficialClassification {
  issue_areas: string[];
  confidence: number;
  primary_area: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function classifyOfficial(official: any): Promise<OfficialClassification | null> {
  const userMessage =
    `What are this official's primary policy focus areas?\n\n` +
    `Name: ${official.full_name}\n` +
    `Role: ${official.role_title}\n` +
    `Party: ${official.party ?? "Unknown"}\n` +
    `State: ${official.state ?? "Unknown"}\n` +
    `Total votes: ${official.vote_count ?? 0}\n` +
    `Total raised: $${((official.total_raised ?? 0) / 100).toLocaleString()}\n` +
    `Top donor industries: ${official.top_industries ?? "Unknown"}\n\n` +
    `Return JSON:\n` +
    `{\n` +
    `  "issue_areas": ["area1", "area2"],\n` +
    `  "confidence": 0.0-1.0,\n` +
    `  "primary_area": "area1"\n` +
    `}\n\n` +
    `Issue areas from this list only:\n` +
    ISSUE_AREAS.join(", ") + `\n\n` +
    `Return 1-3 areas maximum.`;

  try {
    const message = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 150,
      system:
        "You are a political analyst. Classify an official's primary policy focus areas " +
        "based on their voting record data. Respond ONLY with valid JSON.",
      messages: [{ role: "user", content: userMessage }],
    });

    trackCost(message.usage.input_tokens, message.usage.output_tokens);
    await sleep(1300);

    const raw   = message.content[0]?.type === "text" ? message.content[0].text : "";
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Partial<OfficialClassification>;

    const validAreas = (parsed.issue_areas ?? []).filter((a) => ISSUE_AREAS.includes(a));
    if (validAreas.length === 0) return null;

    return {
      issue_areas:  validAreas,
      confidence:   typeof parsed.confidence === "number" ? parsed.confidence : 0.7,
      primary_area: validAreas[0],
    };
  } catch (err) {
    console.error(`    Classification failed for official ${official.id}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runOfficialAiTagger(db: any, maxCostCents: number, onlyNew: boolean): Promise<number> {
  console.log("\n  [AI 2/2] Classifying officials...");

  // Fetch officials with vote count + financial data (pre-aggregated)
  const { data: officials, error } = await db
    .from("officials")
    .select("id, full_name, role_title, party, metadata, is_active")
    .eq("is_active", true);

  if (error) { console.error("    Error fetching officials:", error.message); return 0; }
  if (!officials || officials.length === 0) { console.log("    No officials found."); return 0; }

  let targetOfficials = officials;

  if (onlyNew) {
    const { data: taggedIds } = await db
      .from("entity_tags")
      .select("entity_id")
      .eq("entity_type", "official")
      .eq("generated_by", "ai")
      .eq("tag_category", "topic");

    const alreadyTagged = new Set((taggedIds ?? []).map((r: { entity_id: string }) => r.entity_id));
    targetOfficials = officials.filter((o: { id: string }) => !alreadyTagged.has(o.id));
  }

  if (targetOfficials.length === 0) {
    console.log("    All active officials already have AI tags. Skipping.");
    return 0;
  }

  console.log(`    ${targetOfficials.length} officials to classify`);

  // Batch fetch vote counts and totals
  const officialIds = targetOfficials.map((o: { id: string }) => o.id);

  const [voteCountRes, donorRes] = await Promise.all([
    db.from("votes").select("official_id").in("official_id", officialIds),
    db.from("financial_relationships").select("official_id, donor_type, amount_cents").in("official_id", officialIds),
  ]);

  const voteCountByOfficial = new Map<string, number>();
  for (const v of voteCountRes.data ?? []) {
    voteCountByOfficial.set(v.official_id, (voteCountByOfficial.get(v.official_id) ?? 0) + 1);
  }

  const totalRaisedByOfficial = new Map<string, number>();
  const donorTypesByOfficial = new Map<string, Map<string, number>>();
  for (const f of donorRes.data ?? []) {
    totalRaisedByOfficial.set(f.official_id, (totalRaisedByOfficial.get(f.official_id) ?? 0) + (f.amount_cents ?? 0));
    const typeMap = donorTypesByOfficial.get(f.official_id) ?? new Map();
    typeMap.set(f.donor_type, (typeMap.get(f.donor_type) ?? 0) + (f.amount_cents ?? 0));
    donorTypesByOfficial.set(f.official_id, typeMap);
  }

  let tagsInserted = 0;

  for (const official of targetOfficials) {
    if (sessionCostCents >= maxCostCents) {
      console.log(`    Cost limit reached ($${(maxCostCents / 100).toFixed(2)}). Stopping.`);
      break;
    }

    const voteCount = voteCountByOfficial.get(official.id) ?? 0;
    const totalRaised = totalRaisedByOfficial.get(official.id) ?? 0;
    const typeMap = donorTypesByOfficial.get(official.id) ?? new Map();

    // Top 3 donor industries by amount
    const topIndustries = Array.from(typeMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([type]) => type)
      .join(", ");

    const enriched = {
      ...official,
      state: official.metadata?.state ?? "Unknown",
      vote_count: voteCount,
      total_raised: totalRaised,
      top_industries: topIndustries || "Unknown",
    };

    const result = await classifyOfficial(enriched);
    if (!result) continue;

    for (let i = 0; i < result.issue_areas.length; i++) {
      const area = result.issue_areas[i];
      const isPrimary = area === result.primary_area;
      const confidence = result.confidence;
      const visibility = isPrimary ? "primary" : "secondary";

      const tag = {
        entity_type:    "official",
        entity_id:      official.id,
        tag:            area,
        tag_category:   "topic",
        display_label:  area.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
        display_icon:   TOPIC_ICONS[area] ?? null,
        visibility:     confidence < 0.7 ? "internal" : visibility,
        generated_by:   "ai",
        confidence,
        ai_model:       AI_MODEL,
        pipeline_version: "v1",
        metadata: { is_primary: isPrimary, rank: i + 1 },
      };

      const { error: insertErr } = await db.from("entity_tags").upsert(tag, {
        onConflict: "entity_type,entity_id,tag,tag_category",
      });
      if (!insertErr) tagsInserted++;
    }
  }

  console.log(`    Inserted ${tagsInserted} AI official tags (cost so far: $${(sessionCostCents / 100).toFixed(4)})`);
  return tagsInserted;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

export async function runAiTagger(options?: {
  maxCostCents?: number;
  onlyNew?: boolean;
}): Promise<{ tagsCreated: number; costCents: number }> {
  const maxCostCents = options?.maxCostCents ?? DEFAULT_MAX_COST_CENTS;
  const onlyNew = options?.onlyNew ?? true;

  console.log("\n=== AI tagger ===");
  console.log(`  Max cost: $${(maxCostCents / 100).toFixed(2)} | Only new: ${onlyNew}`);
  console.log(`  Model: ${AI_MODEL}`);

  const logId = await startSync("tag-ai");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  sessionCostCents = 0;

  try {
    const proposalTags = await runProposalAiTagger(db, maxCostCents, onlyNew);
    const officialTags = sessionCostCents < maxCostCents
      ? await runOfficialAiTagger(db, maxCostCents, onlyNew)
      : 0;

    const totalTags = proposalTags + officialTags;

    console.log("\n  ─────────────────────────────────────────────────");
    console.log("  AI tagger report");
    console.log("  ─────────────────────────────────────────────────");
    console.log(`  ${"Proposal tags:".padEnd(32)} ${proposalTags}`);
    console.log(`  ${"Official tags:".padEnd(32)} ${officialTags}`);
    console.log(`  ${"Total tags:".padEnd(32)} ${totalTags}`);
    console.log(`  ${"Total cost:".padEnd(32)} $${(sessionCostCents / 100).toFixed(4)}`);

    // Log AI cost to api_usage_logs for dashboard transparency
    if (sessionCostCents > 0) {
      await db.from("api_usage_logs").insert({
        service:      "anthropic",
        endpoint:     "entity_tagging",
        model:        AI_MODEL,
        tokens_used:  0, // approximate — already tracked per call
        cost_cents:   sessionCostCents,
      });
    }

    await completeSync(logId, { inserted: totalTags, updated: 0, failed: 0, estimatedMb: 0 });
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
  const [proposalRes, officialRes, taggedProposalRes, taggedOfficialRes] = await Promise.all([
    db.from("proposals").select("id", { count: "exact", head: true }),
    db.from("officials").select("id", { count: "exact", head: true }).eq("is_active", true),
    db.from("entity_tags").select("entity_id", { count: "exact", head: true })
      .eq("entity_type", "proposal").eq("generated_by", "ai").eq("tag_category", "topic"),
    db.from("entity_tags").select("entity_id", { count: "exact", head: true })
      .eq("entity_type", "official").eq("generated_by", "ai").eq("tag_category", "topic"),
  ]);

  const totalProposals   = proposalRes.count ?? 0;
  const totalOfficials   = officialRes.count ?? 0;
  const taggedProposals  = taggedProposalRes.count ?? 0;
  const taggedOfficials  = taggedOfficialRes.count ?? 0;
  const untaggedProposals = Math.max(0, totalProposals - taggedProposals);
  const untaggedOfficials = Math.max(0, totalOfficials - taggedOfficials);

  const proposalCost = untaggedProposals * 0.000075; // ~$0.000075 each
  const officialCost = untaggedOfficials * 0.000055; // ~$0.000055 each
  const totalCost    = proposalCost + officialCost;

  console.log("\n  ─────────────────────────────────────────────────");
  console.log("  AI tagger cost estimate");
  console.log("  ─────────────────────────────────────────────────");
  console.log(`  Proposals:  ${untaggedProposals.toLocaleString()} untagged / ${totalProposals.toLocaleString()} total → ~$${proposalCost.toFixed(2)}`);
  console.log(`  Officials:  ${untaggedOfficials.toLocaleString()} untagged / ${totalOfficials.toLocaleString()} total → ~$${officialCost.toFixed(2)}`);
  console.log(`  Total estimate: ~$${totalCost.toFixed(2)}`);
  console.log(`\n  To run: pnpm --filter @civitics/data data:tag-ai -- --confirm`);
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
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
