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

import { createAdminClient, selectAllOrThrow } from "@civitics/db";
import { createAiClient } from "@civitics/ai";
import { costGate } from "@civitics/ai/cost-gate";
import { startSync, completeSync, failSync } from "../sync-log";
import { VALID_INDUSTRIES, INDUSTRY_LABELS, industryDisplay } from "./topics";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MIN_DONATION_CENTS = 10_000_000; // $100k — not worth AI cost below this
const COST_PER_PAC_USD = 0.0002;

// FIX-908: the local 12-key VALID_INDUSTRIES + INDUSTRY_LABELS copies that lived
// here are gone. This file now imports the SAME constants the drain
// write-boundary guard uses (drain/vocabulary.ts →
// TAG_VOCABULARY.financial_entity.industry = VALID_INDUSTRIES), so the set the
// model is offered and the set the database will accept cannot drift apart —
// which they already had: this copy carried an `other` key that was never a
// member of the shared vocabulary.
//
// KNOWN, DELIBERATELY UNCHANGED (FIX-908): the prompt offers "other" as an answer
// and "other" is NOT a member of VALID_INDUSTRIES — yet it is still WRITTEN, as
// a real entity_tags row tagged `other`. Every model abstention, and every
// unparseable answer (the coercion below collapses both to "other"), lands in
// the table as out-of-vocabulary drift: the same class as the four singleton
// rows this change is deleting, and the class FIX-890's write-boundary guard
// exists to stop — except this path upserts over PostgREST and never passes
// through that guard. Measured 2026-07-27: prod carries 8 such rows (local
// carries 0), so this is open AND bleeding. Left as-is here on purpose — fixing
// it changes what gets written, which is not what a vocabulary PR should do
// quietly, and the 8 rows are a display wart rather than a correctness break.
// Tracked as its own FIX; the FIX-909 migration deliberately tolerates `other`
// in its vocabulary assertion rather than deleting rows this PR was not
// authorised to touch.
type Industry = (typeof VALID_INDUSTRIES)[number] | "other";

/** Not a vocabulary member — see the note above. Kept only to preserve current behaviour. */
const OTHER_DISPLAY = { label: "Other", icon: "⚙" } as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UntaggedPac {
  id: string;
  display_name: string;
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

// FIX-908: the allowed list is BUILT from VALID_INDUSTRIES rather than restated in
// prose. The old hardcoded twelve is what made the classifier the root cause the
// audit found — with no bucket for electric utilities, industrial manufacturing,
// chemicals, autos, steel, mining or media, a model handed "Duke Energy PAC" can
// only answer `oil_gas`, and it is not wrong to. Enumerating from the constant
// means the next key added to the vocabulary reaches the model automatically.
//
// The one-line label gloss is included so the model classifies against what a
// bucket MEANS rather than guessing from the slug — `lobby` vs `legal` and
// `retail` vs `manufacturing` are otherwise coin flips on a bare key.
function buildPrompt(pacName: string): string {
  const options = VALID_INDUSTRIES
    .map((k) => `  ${k} — ${INDUSTRY_LABELS[k].label}`)
    .join("\n");

  return `What industry does this political action committee represent?

PAC name: ${pacName}

Choose exactly one of these industries:
${options}
  other — none of the above / cannot tell from the name

Return ONLY valid JSON with no markdown and no explanation:
{
  "industry": "one of the keys listed above",
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
      messages: [{ role: "user", content: buildPrompt(pac.display_name) }],
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

    const industry: Industry = (VALID_INDUSTRIES as readonly string[]).includes(parsed.industry)
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
    console.error(`    [ai-classifier] Parse error for "${pac.display_name}":`, err instanceof Error ? err.message : err);
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
    // FIX-545: both reads were capped at PostgREST's 1,000 rows — the tagged
    // set truncated (re-tagging already-tagged PACs, re-burning AI budget)
    // and only the top-1,000 PACs were ever considered; the tagged read was
    // also silent-zero on error. Paginate + throw.
    const taggedIds = await selectAllOrThrow(
      "ai-classifier industry-tagged FE preload",
      (from, to) => db
        .from("entity_tags")
        .select("entity_id")
        .eq("entity_type", "financial_entity")
        .eq("tag_category", "industry")
        .order("id")
        .range(from, to),
    ) as { entity_id: string }[];
    const alreadyTagged = new Set<string>(taggedIds.map((r) => r.entity_id));

    const allPacs = await selectAllOrThrow(
      "ai-classifier PAC preload",
      (from, to) => db
        .from("financial_entities")
        .select("id, display_name, total_donated_cents")
        .eq("entity_type", "pac")
        .gt("total_donated_cents", MIN_DONATION_CENTS)
        .order("total_donated_cents", { ascending: false })
        .order("id")
        .range(from, to),
    ) as { id: string; display_name: string; total_donated_cents: number }[];

    const pacs: UntaggedPac[] = allPacs.filter((r) => !alreadyTagged.has(r.id));

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
          messages: [{ role: "user", content: buildPrompt(samplePac.display_name) }],
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
      process.stdout.write(`  ${pac.display_name.slice(0, 55).padEnd(55)} → `);

      const result = await classifyPac(anthropic, pac);
      if (!result) {
        process.stdout.write("FAILED\n");
        skipped++;
        continue;
      }

      totalInputTokens  += result.input_tokens;
      totalOutputTokens += result.output_tokens;

      const info = industryDisplay(result.industry) ?? OTHER_DISPLAY;
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
