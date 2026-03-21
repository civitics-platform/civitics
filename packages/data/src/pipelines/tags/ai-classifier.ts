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

import Anthropic from "@anthropic-ai/sdk";
import { createAdminClient } from "@civitics/db";
import { startSync, completeSync, failSync } from "../sync-log";
import * as readline from "readline";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MIN_DONATION_CENTS = 10_000_000; // $100k — not worth AI cost below this
const COST_PER_PAC_USD = 0.0002;
const AUTO_CONFIRM_THRESHOLD_USD = 0.50;

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
  client: Anthropic,
  pac: UntaggedPac
): Promise<ClassificationResult | null> {
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

    return { industry, confidence, reasoning: String(parsed.reasoning ?? "") };
  } catch (err) {
    console.error(`    [ai-classifier] Parse error for "${pac.name}":`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Confirm with user
// ---------------------------------------------------------------------------

async function confirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes");
    });
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runAiClassifier(opts: { autoConfirm?: boolean } = {}): Promise<{ tagged: number; skipped: number }> {
  console.log("\n=== AI industry classifier ===");
  const logId = await startSync("tag-ai");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  try {
    // 1. Find untagged PACs above the minimum donation threshold
    const { data: untagged, error: fetchErr } = await db
      .from("financial_entities")
      .select("id, name, total_donated_cents")
      .eq("entity_type", "pac")
      .gt("total_donated_cents", MIN_DONATION_CENTS)
      .not(
        "id",
        "in",
        db
          .from("entity_tags")
          .select("entity_id")
          .eq("entity_type", "financial_entity")
          .eq("tag_category", "industry")
      )
      .order("total_donated_cents", { ascending: false });

    if (fetchErr) {
      console.error("  Error fetching untagged PACs:", fetchErr.message);
      await failSync(logId, fetchErr.message);
      return { tagged: 0, skipped: 0 };
    }

    const pacs: UntaggedPac[] = (untagged ?? []).map((r: { id: string; name: string; total_donated_cents: number }) => r);

    if (pacs.length === 0) {
      console.log("  No untagged PACs found over threshold. Nothing to do.");
      await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 });
      return { tagged: 0, skipped: 0 };
    }

    // 2. Cost estimate
    const estimatedCost = pacs.length * COST_PER_PAC_USD;
    console.log(`\n  Untagged PACs (over $${(MIN_DONATION_CENTS / 100).toLocaleString()}): ${pacs.length}`);
    console.log(`  Estimated cost: $${estimatedCost.toFixed(4)}`);

    if (!opts.autoConfirm && estimatedCost > AUTO_CONFIRM_THRESHOLD_USD) {
      const ok = await confirm(`\n  Proceed? This will cost ~$${estimatedCost.toFixed(4)} [y/N]: `);
      if (!ok) {
        console.log("  Aborted.");
        await completeSync(logId, { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 });
        return { tagged: 0, skipped: pacs.length };
      }
    } else {
      console.log(
        estimatedCost <= AUTO_CONFIRM_THRESHOLD_USD
          ? `  Auto-confirming (under $${AUTO_CONFIRM_THRESHOLD_USD} threshold).`
          : "  --confirm flag set, skipping prompt."
      );
    }

    // 3. Classify each PAC
    const apiKey = process.env.CIVITICS_ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("CIVITICS_ANTHROPIC_API_KEY not set");
    const anthropic = new Anthropic({ apiKey });

    let tagged = 0;
    let skipped = 0;

    console.log(`\n  Classifying ${pacs.length} PACs...\n`);

    for (const pac of pacs) {
      process.stdout.write(`  ${pac.name.slice(0, 55).padEnd(55)} → `);

      const result = await classifyPac(anthropic, pac);
      if (!result) {
        process.stdout.write("FAILED\n");
        skipped++;
        continue;
      }

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

    // 4. Summary
    console.log("\n  ─────────────────────────────────────────────────");
    console.log("  AI classifier report");
    console.log("  ─────────────────────────────────────────────────");
    console.log(`  ${"PACs processed:".padEnd(32)} ${pacs.length}`);
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
  const autoConfirm = process.argv.includes("--confirm");
  (async () => {
    try {
      await runAiClassifier({ autoConfirm });
      process.exit(0);
    } catch (err) {
      console.error("Fatal:", err);
      process.exit(1);
    }
  })();
}
