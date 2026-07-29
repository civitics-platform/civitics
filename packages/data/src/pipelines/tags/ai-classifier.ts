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
import { selectDirect } from "../../lib/heavy-rebuild";
import { checkTagVocabulary } from "../../drain/vocabulary";
import { VALID_INDUSTRIES, INDUSTRY_LABELS, industryDisplay } from "./topics";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const MIN_DONATION_CENTS = 10_000_000; // $100k — not worth AI cost below this
const COST_PER_PAC_USD = 0.0002;
/** Named abstains kept in data_sync_log.metadata — a sample, not the full list. */
const ABSTAIN_SAMPLE_LIMIT = 25;

// FIX-908: the local 12-key VALID_INDUSTRIES + INDUSTRY_LABELS copies that lived
// here are gone. This file now imports the SAME constants the drain
// write-boundary guard uses (drain/vocabulary.ts →
// TAG_VOCABULARY.financial_entity.industry = VALID_INDUSTRIES), so the set the
// model is offered and the set the database will accept cannot drift apart —
// which they already had: this copy carried an `other` key that was never a
// member of the shared vocabulary.
//
// FIX-911 — CLOSED (was the "KNOWN, DELIBERATELY UNCHANGED" note left by FIX-908).
//
// This path used to coerce every model abstention AND every unparseable answer to
// the literal `other`, then WRITE it as a real entity_tags row — a value that is
// not a member of VALID_INDUSTRIES and that FIX-890's write-boundary guard exists
// to reject. It escaped that guard because the guard lives in the DRAIN path
// (drain/apply.ts → checkTagVocabulary) and this file upserts over PostgREST
// directly. A prompt is a request, not a constraint; so is a type alias.
//
// Two things made that worse than a display wart. `other` asserts nothing a
// reader can use — an "Other" pill is strictly worse than no pill — and the value
// propagates: official_sector_affinity_rollup mirrors donor tags verbatim, so a
// junk donor tag becomes a junk official industry, which used to THROW inside
// tagOfficials() and kill the whole nightly official tagger (FIX-920).
//
// The writer now fails CLOSED through the same guard the drain path uses, and an
// unclassifiable PAC ends with NO industry tag. That is the honest state, and it
// is exactly what the 362 NULL curated overrides already assert for the same
// class of entity (leadership PACs, party committees, vanity PACs).
type Industry = (typeof VALID_INDUSTRIES)[number];

/**
 * What the model may answer that is NOT a tag. The prompt still offers it — an
 * explicit "I cannot tell" beats a forced guess from a bare committee name — but
 * it now routes to an abstain record instead of an entity_tags row.
 */
const ABSTAIN_ANSWER = "other";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface UntaggedPac {
  id: string;
  display_name: string;
  total_donated_cents: number;
}

/**
 * FIX-917 — the candidate-set filter, extracted so the guard below is pinnable
 * by a unit test rather than only reachable through a live API run.
 *
 * THE FAILURE THIS PREVENTS
 * -------------------------
 * The candidate set is "PACs over the donation threshold that have NO industry
 * tag". FIX-916 de-tagged 362 committees — leadership PACs, party committees and
 * abstract vanity PACs (WinRed, NRSC, Save America, Huck PAC, AmeriPAC) — on the
 * deliberate finding that they are not industries at all, and its migration
 * deleted their surviving generated_by='ai' rows. That leaves them with ZERO
 * industry tags, which is EXACTLY the shape this function reads as "needs
 * classifying". Without the override subtraction the very next run re-tags the
 * precise committees the audit de-tagged — and because this path upserts
 * generated_by='ai', those rows land OUTSIDE the nightly
 * clear_financial_entity_rule_tags scope and persist.
 *
 * `industry IS NULL` in the override table is a POSITIVE assertion ("no
 * industry, ever"), not a gap, so the exclusion covers NULL rows especially —
 * the 380 re-assigned donors are already protected by carrying a curated tag,
 * which makes them incidental beneficiaries rather than the reason this exists.
 *
 * This is the same silent-strand class as FIX-884/885: a guard that looks fine
 * and never runs. Verified 2026-07-28 by deleting the `overriddenEntityIds`
 * clause below: industry-overrides.test.ts fails both FIX-917 cases.
 */
export function selectClassifierCandidates(
  allPacs: readonly UntaggedPac[],
  alreadyTagged: ReadonlySet<string>,
  overriddenEntityIds: ReadonlySet<string>,
): UntaggedPac[] {
  return allPacs.filter((r) => !alreadyTagged.has(r.id) && !overriddenEntityIds.has(r.id));
}

interface ClassificationResult {
  /**
   * FIX-911: the model's RAW answer, uncoerced. It is validated at the write
   * boundary by checkTagVocabulary(), not silently rewritten here — collapsing
   * an unparseable answer into a plausible-looking tag is how junk reached the
   * table in the first place.
   */
  industry: string;
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

    // FIX-911: NO coercion. An out-of-vocabulary answer (including the prompt's
    // own `other`) and an answer we could not make sense of are both handed on
    // verbatim and rejected at the write boundary, where the rejection is
    // counted and named. Coercing here made an abstention indistinguishable from
    // a classification.
    const confidence = Math.min(1.0, Math.max(0.0, Number(parsed.confidence) || 0.3));

    return {
      industry: String(parsed.industry ?? "").trim().toLowerCase(),
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

    // FIX-917: every entity with a curated override is off the table, whether or
    // not it currently carries a tag. See selectClassifierCandidates() for the
    // re-tagging failure this prevents.
    //
    // Resolved by a direct-pg JOIN rather than PostgREST: the override table is
    // keyed on fec_committee_id and the classifier needs financial_entities.id,
    // and a PostgREST `.in("fec_committee_id", [...742 ids])` is a ~8 KB URL —
    // past what the gateway will carry, and the chunk-to-200 workaround would
    // turn one guard into four round-trips that can each half-fail. One query,
    // no caps, and it THROWS on error so the guard can never silently no-op into
    // a re-tagging run (which is the entire failure being prevented).
    const overriddenRows = await selectDirect<{ id: string }>(
      `SELECT fe.id
         FROM public.financial_entity_industry_overrides o
         JOIN public.financial_entities fe
           ON fe.fec_committee_id = o.fec_committee_id`,
    );
    const overriddenIds = new Set<string>(overriddenRows.map((r) => r.id));
    console.log(`  Curated overrides excluded from classification: ${overriddenIds.size}`);

    const pacs: UntaggedPac[] = selectClassifierCandidates(allPacs, alreadyTagged, overriddenIds);

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
    // FIX-911: abstentions are RECORDED, not coerced into a tag. Keyed by the raw
    // answer so `other` (an honest "cannot tell") stays distinguishable from a
    // hallucinated slug — the two want different follow-ups: the first is a PAC
    // that genuinely has no industry, the second is a prompt or vocabulary bug.
    const abstainsByAnswer = new Map<string, number>();
    const abstainedPacs: { name: string; answer: string; reason: string }[] = [];

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

      // FIX-911: the write boundary. Same guard the drain path uses
      // (drain/vocabulary.ts), so the set the model is offered, the set the drain
      // accepts, and the set this pipeline writes are one set by construction.
      // An unclassifiable PAC ends with NO industry tag — the honest state.
      const verdict = checkTagVocabulary("financial_entity", "industry", result.industry);
      if (!verdict.allowed) {
        const answer = result.industry || "(empty)";
        abstainsByAnswer.set(answer, (abstainsByAnswer.get(answer) ?? 0) + 1);
        if (abstainedPacs.length < ABSTAIN_SAMPLE_LIMIT) {
          abstainedPacs.push({ name: pac.display_name, answer, reason: verdict.reason });
        }
        process.stdout.write(
          answer === ABSTAIN_ANSWER
            ? "ABSTAIN (no industry)\n"
            : `ABSTAIN — out of vocabulary: ${answer}\n`,
        );
        continue;
      }

      // Non-null by construction: checkTagVocabulary just proved membership of
      // VALID_INDUSTRIES, and industry-vocabulary.test.ts pins INDUSTRY_LABELS to
      // cover every member.
      const info = industryDisplay(result.industry)!;
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
    const abstained = [...abstainsByAnswer.values()].reduce((a, b) => a + b, 0);

    console.log("\n  ─────────────────────────────────────────────────");
    console.log("  AI classifier report");
    console.log("  ─────────────────────────────────────────────────");
    console.log(`  ${"PACs processed:".padEnd(32)} ${pacsToProcess.length}`);
    console.log(`  ${"Tagged:".padEnd(32)} ${tagged}`);
    console.log(`  ${"Abstained (no tag written):".padEnd(32)} ${abstained}`);
    console.log(`  ${"Skipped/failed:".padEnd(32)} ${skipped}`);
    console.log(`  ${"Actual cost (est):".padEnd(32)} $${(tagged * COST_PER_PAC_USD).toFixed(4)}`);

    if (abstained > 0) {
      // FIX-911: an out-of-vocabulary answer that is NOT the prompt's own `other`
      // is a different animal — the model invented a slug, which means the prompt
      // and the vocabulary have drifted. Call it out separately rather than
      // burying it in one abstain count.
      const invented = [...abstainsByAnswer.entries()].filter(([a]) => a !== ABSTAIN_ANSWER);
      console.log(
        `  Abstain breakdown: ` +
          [...abstainsByAnswer.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([answer, n]) => `${answer}=${n}`)
            .join(", "),
      );
      if (invented.length > 0) {
        console.warn(
          `  [FIX-911] WARNING: the model returned ${invented.length} answer(s) that are ` +
            `neither a vocabulary member nor '${ABSTAIN_ANSWER}': ` +
            `${invented.map(([a, n]) => `${a} (${n})`).join(", ")}. ` +
            `The prompt is built from VALID_INDUSTRIES, so this means the model is ` +
            `ignoring the offered set — check buildPrompt() output.`,
        );
      }
    }

    await completeSync(logId, {
      inserted: tagged,
      updated: 0,
      failed: skipped,
      estimatedMb: 0,
      // FIX-911: the abstain record is DURABLE, not just a CI log line that
      // scrolls past. A count in data_sync_log.metadata is greppable months
      // later, which is the whole point of preferring an abstain to a junk tag.
      metadata: {
        vocabulary_abstains: abstained,
        vocabulary_abstains_by_answer: Object.fromEntries(abstainsByAnswer),
        vocabulary_abstain_sample: abstainedPacs,
      },
    });
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
