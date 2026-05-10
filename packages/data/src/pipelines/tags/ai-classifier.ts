/**
 * AI-based industry classifier for financial entities.
 *
 * Runs AFTER the rule-based tagger. Classifies PACs over $100k that still
 * have no industry tag — the long tail the keyword rules miss.
 *
 * Cost estimate: ~$0.0002 per PAC (claude-haiku-4-5-20251001, ~200 tokens in+out)
 * A batch of 200 untagged PACs ≈ $0.04
 *
 * Run:
 *   pnpm --filter @civitics/data data:tag-ai
 *   pnpm --filter @civitics/data data:tag-ai -- --confirm   (skip cost prompt)
 *
 * Never runs automatically — manual / weekly cron only.
 * Dry-run by default: prints estimates, prompts for confirmation.
 */

import { createAdminClient } from "@civitics/db";
import { createAiClient } from "@civitics/ai";
import { costGate } from "@civitics/ai/cost-gate";
import { startSync, completeSync, failSync } from "../sync-log";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MIN_DONATION_CENTS = 10_000_000; // $100k — not worth AI cost below this
const COST_PER_PAC_USD = 0.0002;

const VALID_INDUSTRIES = [
  "pharma", "oil_gas", "finance", "tech", "defense",
  "real_estate", "labor", "agriculture", "legal",
  "retail", "transportation", "lobby", "other",
] as const;
type Industry = typeof VALID_INDUSTRIES[number];

const INDUSTRY_LABELS: Record<Industry, { label: string; icon: string }> = {
  pharma:         { label: "Pharma",           icon: "💊" },
  oil_gas:        { label: "Oil & Gas",        icon: "🛢" },
  finance:        { label: "Finance",          icon: "📈" },
  tech:           { label: "Tech",             icon: "💻" },
  defense:        { label: "Defense",          icon: "🛡" },
  real_estate:    { label: "Real Estate",      icon: "🏠" },
  labor:          { label: "Labor",            icon: "👷" },
  agriculture:    { label: "Agriculture",      icon: "🌾" },
  legal:          { label: "Legal",            icon: "⚖️" },
  retail:         { label: "Retail",           icon: "🛒" },
  transportation: { label: "Transportation",   icon: "🚛" },
  lobby:          { label: "Lobby / Advocacy", icon: "🏛" },
  other:          { label: "Other",            icon: "⚙" },
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UntaggedPac {
  id: string;
  name: string;
  total_donated_cents: number;
}

interface ClassificationResult {
  industry: Industry;
  confidence: number;
  reasoning: string;
}

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

function buildPrompt(pacName: string): string {
  return `What industry does this political action committee represent?

PAC name: ${pacName}

Return ONLY valid JSON with no markdown and no explanation:
{
  "industry": "one of: pharma, oil_gas, finance, tech, defense, real_estate, labor, agriculture, legal, retail, transportation, lobby, other",
  "confidence": 0.0,
  "reasoning": "one sentence"
}

If unclear, return "other" with confidence 0.3.`;
}

// ---------------------------------------------------------------------------
// Classify one PAC
// ---------------------------------------------------------------------------

async function classifyPac(
  client: ReturnType<typeof createAiClient>,
  pac: UntaggedPac
): Promise<(ClassificationResult & { input_tokens: number; output_tokens: number }) | null> {
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 150,
      system:
        "You classify political action committees into industries. " +
        "Respond ONLY with valid JSON. No markdown, no explanation.",
      messages: [{ role: "user", content: buildPrompt(pac.name) }],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text.trim() : null;
    if (!raw) return null;

    // Strip accidental markdown fences
    const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const parsed = JSON.parse(cleaned) as {
      industry: string;
      confidence: number;
      reasoning: string;
    };

    const industry = VALID_INDUSTRIES.includes(parsed.industry as Industry)
      ? (parsed.industry as Industry)
      : "other";

    const confidence = Math.min(1.0, Math.max(0.0, Number(parsed.confidence) || 0.3));

    return {
      industry,
      confidence,
      reasoning:     String(parsed.reasoning ?? ""),
      input_tokens:  response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
    };
  } catch (err) {
    console.error(`    [ai-classifier] Parse error for "${pac.name}":`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runAiClassifier(options: { confirmed?: boolean } = {}): Promise<{ tagged: number; skipped: number }> {
  console.log("\n=== AI industry classifier ===");

  // `confirmed: true` (set by orchestrator + CLI --confirm) flips the
  // cost-gate into autonomous-approval mode for this process — it skips the
  // interactive Y/n prompt and applies the pre-configured budget caps in
  // packages/ai/src/cost-config.ts. Already-autonomous environments
  // (CI, Vercel cron, AUTONOMOUS=true) need no override.
  if (options.confirmed && !process.env["AUTONOMOUS"] && !process.env["CI"] && !process.env["VERCEL_CRON_SIGNATURE"]) {
    process.env["AUTONOMOUS"] = "true";
  }

  const logId = await startSync("tag_ai");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  try {
    // 1. Find untagged PACs above the minimum donation threshold.
    // Fetch already-tagged IDs first, then filter in a second query
    // (Supabase JS doesn't support nested subqueries in .not().in()).
    const { data: taggedIds } = await db
      .from("entity_tags")
      .select("entity_id")
      .eq("entity_type", "financial_entity")
      .eq("tag_category", "industry");

    const alreadyTagged = new Set<string>(
      (taggedIds ?? []).map((r: { entity_id: string }) => r.entity_id)
    );

    const { data: allPacs, error: fetchErr } = await db
      .from("financial_entities")
      .select("id, name, total_donated_cents")
      .eq("entity_type", "pac")
      .gt("total_donated_cents", MIN_DONATION_CENTS)
      .order("total_donated_cents", { ascending: false });

    if (fetchErr) {
      console.error("  Error fetching PACs:", fetchErr.message);
      await failSync(logId, fetchErr.message);
      return { tagged: 0, skipped: 0 };
    }

    const pacs: UntaggedPac[] = ((allPacs ?? []) as { id: string; name: string; total_donated_cents: number }[])
      .filter((r) => !alreadyTagged.has(r.id));

    if (pacs.length === 0) {
      console.log("  No untagged PACs found over threshold. Nothing to do.");
      await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 });
      return { tagged: 0, skipped: 0 };
    }

    console.log(`\n  Untagged PACs (over $${(MIN_DONATION_CENTS / 100).toLocaleString()}): ${pacs.length}`);

    // 2. Wire cost gate — samples 3 real API calls, asks for approval
    const anthropic = createAiClient();

    const samplePac = pacs[0]!;
    const gate = await costGate.gate({
      pipelineName: "ai_classifier",
      entityCount:  pacs.length,
      model:        "claude-haiku-4-5-20251001",
      sampleFn: async () =>
        anthropic.messages.create({
          model:      "claude-haiku-4-5-20251001",
          max_tokens: 150,
          system:
            "You classify political action committees into industries. " +
            "Respond ONLY with valid JSON. No markdown, no explanation.",
          messages: [{ role: "user", content: buildPrompt(samplePac.name) }],
        }),
    });

    if (!gate.approved) {
      await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 });
      return { tagged: 0, skipped: pacs.length };
    }

    // Respect entity limit from gate (budget cap)
    const pacsToProcess = gate.entity_limit ? pacs.slice(0, gate.entity_limit) : pacs;

    let tagged = 0;
    let skipped = 0;
    let totalInputTokens  = 0;
    let totalOutputTokens = 0;

    console.log(`\n  Classifying ${pacsToProcess.length} PACs...\n`);

    for (const pac of pacsToProcess) {
      process.stdout.write(`  ${pac.name.slice(0, 55).padEnd(55)} → `);

      const result = await classifyPac(anthropic, pac);
      if (!result) {
        process.stdout.write("FAILED\n");
        skipped++;
        continue;
      }

      totalInputTokens  += result.input_tokens;
      totalOutputTokens += result.output_tokens;

      const info = INDUSTRY_LABELS[result.industry];
      const visibility = result.confidence >= 0.7 ? "primary" : "internal";

      const { error: upsertErr } = await db.from("entity_tags").upsert(
        {
          entity_type: "financial_entity",
          entity_id: pac.id,
          tag: result.industry,
          tag_category: "industry",
          display_label: info.label,
          display_icon: info.icon,
          visibility,
          generated_by: "ai",
          confidence: result.confidence,
          pipeline_version: "v1",
          metadata: { reasoning: result.reasoning },
        },
        { onConflict: "entity_type,entity_id,tag,tag_category" }
      );

      if (upsertErr) {
        process.stdout.write(`UPSERT ERROR: ${upsertErr.message}\n`);
        skipped++;
      } else {
        process.stdout.write(`${result.industry} (${(result.confidence * 100).toFixed(0)}%)\n`);
        tagged++;
      }

      // Small delay to stay within rate limits
      await new Promise((r) => setTimeout(r, 150));
    }

    // Record actual costs via gate
    if (gate.run_id) {
      await costGate.complete(gate.run_id, totalInputTokens, totalOutputTokens, "claude-haiku-4-5-20251001");
    }

    // 4. Summary
    console.log("\n  ─────────────────────────────────────────────────");
    console.log("  AI classifier report");
    console.log("  ─────────────────────────────────────────────────");
    console.log(`  ${"PACs processed:".padEnd(32)} ${pacsToProcess.length}`);
    console.log(`  ${"Tagged:".padEnd(32)} ${tagged}`);
    console.log(`  ${"Skipped/failed:".padEnd(32)} ${skipped}`);
    console.log(`  ${"Actual cost (est):".padEnd(32)} $${(tagged * COST_PER_PAC_USD).toFixed(4)}`);

    await completeSync(logId, { inserted: tagged, updated: 0, failed: skipped, estimatedMb: 0 });
    return { tagged, skipped };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("  AI classifier fatal error:", msg);
    await failSync(logId, msg);
    return { tagged: 0, skipped: 0 };
  }
}

// ---------------------------------------------------------------------------
// Standalone entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  (async () => {
    try {
      const confirmed = process.argv.includes("--confirm");
      await runAiClassifier({ confirmed });
      process.exit(0);
    } catch (err) {
      console.error("Fatal:", err);
      process.exit(1);
    }
  })();
}
