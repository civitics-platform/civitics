/**
 * GET /api/officials/[id]/summary
 *
 * On-demand civic profile summary for an official.
 *
 * Flow:
 *  1. Check ai_summary_cache — return immediately if found
 *  2. Fetch official data (votes + donors)
 *  3. Only generate if official has at least some record
 *  4. Check monthly spend cap ($4.00)
 *  5. Generate with Haiku, cache, log usage
 *
 * FIX-1029 — ONE RULE: AN ERROR IS NEVER A 200.
 *
 * This route used to answer every failure with the same `200 {summary: null}`
 * body it uses for "this official has no record", so a caller could not tell
 * "we have nothing to say" from "the database is down" — the same
 * signal-laundering class as FIX-1027, and the reason the FIX-1021 liveness
 * probe had to route around this route entirely.
 *
 * The two vocabularies are now disjoint:
 *
 *   200 {summary: null}   a real, cacheable-as-knowledge answer — the kill
 *                         switch is off, the spend cap is reached, the official
 *                         genuinely has no votes and no donors, or the model
 *                         returned empty text.
 *   503 {summary: null,   an infrastructure failure — the officials read
 *        error:            errored, the spend-ledger read errored, or anything
 *        "unavailable"}    downstream threw. NEVER cached: no CDN headers, and
 *                         an explicit `Cache-Control: no-store` so no
 *                         intermediary pins it either.
 *
 * `data === null` with NO error is still the genuine no-record 200 — a missing
 * row and a broken connection are different facts and supabase-js reports them
 * in different fields.
 */

export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { calculateCostUsd, createAdminClient } from "@civitics/db";
import { createAiClient, MODELS } from "@civitics/ai";
// FIX-796 — header handler-owned: only the two summary-bearing 200s are
// CDN-cached, so a transient null is never pinned at the edge. FIX-1029 makes
// that true BY CONSTRUCTION rather than by discipline: this route no longer
// builds any response itself. Every status and every cache header is decided in
// @/lib/summary-policy — `summaryTextResponse` is the only thing that calls
// withPublicCdnCache, and no error path can reach it. That also makes each
// branch testable without mocking a route handler (summary-policy.test.ts).
import {
  summaryUnavailable,
  summaryNone,
  summaryText as summaryTextResponse,
  officialsReadOutcome,
  spendCentsOrThrow,
  capDecision,
} from "@/lib/summary-policy";

const MONTHLY_SPEND_LIMIT_CENTS = 400;

/**
 * Month-to-date Anthropic spend, in cents.
 *
 * FIX-1029 — THIS FAILS CLOSED. It used to destructure `{ data }` only and
 * `catch { return 0 }`, so an unreadable spend ledger read as "$0 spent this
 * month" and the $4.00 cap was silently not enforced for that request — the
 * one direction a cost guard must never fail in. It now inspects `error` and
 * throws, and the caller turns that into a 503: an unreadable ledger means NO
 * model call, not an unmetered one.
 */
async function getMonthlySpendCents(db: ReturnType<typeof createAdminClient>): Promise<number> {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (db as any)
    .from("api_usage_logs")
    .select("cost_cents")
    .eq("service", "anthropic")
    .gte("created_at", start.toISOString());
  return spendCentsOrThrow(res);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const { id } = params;
  if (!id) return summaryNone();

  const db = createAdminClient();

  // 1. Cache check
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cacheRes = await (db as any)
      .from("ai_summary_cache")
      .select("summary_text")
      .eq("entity_type", "official")
      .eq("entity_id", id)
      .eq("summary_type", "profile")
      .maybeSingle();

    if (cacheRes.data?.summary_text) {
      return summaryTextResponse(cacheRes.data.summary_text);
    }
  } catch {
    // cache miss — proceed
  }

  // Kill switch: when AI_SUMMARIES_ENABLED=false, refuse on cache miss
  // instead of calling Anthropic. Mirrors the guard in
  // packages/ai/src/client.ts#generateSummary.
  if (process.env["AI_SUMMARIES_ENABLED"] === "false") {
    return summaryNone("disabled");
  }

  // 2. Fetch official
  //
  // FIX-1029 — the error field is inspected BEFORE the null check. supabase-js
  // resolves rather than throws on a failed query, returning `{data: null,
  // error}`, so a DB outage used to land on the `!official` branch below and be
  // reported as "this official does not exist". Two different facts, two
  // different answers.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const officialRes = await (db as any)
    .from("officials")
    .select("id, full_name, role_title, party, metadata, is_active")
    .eq("id", id)
    .maybeSingle();

  const officialsOutcome = officialsReadOutcome(officialRes);
  if (officialsOutcome === "unavailable") {
    console.error("[/api/officials/[id]/summary] officials read failed", officialRes.error);
    return summaryUnavailable();
  }
  // No error and no row: a genuine "no such official". Still a 200 — it is an
  // answer, not a failure.
  if (officialsOutcome === "no_record") return summaryNone();
  const official = officialRes.data;

  // Get vote count
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const voteCountRes = await (db as any)
    .from("votes")
    .select("id", { count: "exact", head: true })
    .eq("official_id", id);

  // Read donor count + total from the homepage MV (FIX-308 / FIX-344 pattern).
  // MV row may be missing for newly-created officials between nightly refreshes.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mvRes = await (db as any)
    .from("official_homepage_stats_mv")
    .select("donor_count, total_donations_cents")
    .eq("official_id", id)
    .maybeSingle();

  const voteCount = voteCountRes.count ?? 0;
  const donorCount = mvRes.data?.donor_count ?? 0;
  const totalRaisedCents = mvRes.data?.total_donations_cents ?? 0;

  // Only generate if there's meaningful data
  if (voteCount === 0 && donorCount === 0) {
    return summaryNone();
  }

  // 3. Cost cap check
  //
  // FIX-1029 — the cap FAILS CLOSED. getMonthlySpendCents throws rather than
  // returning 0 on an unreadable ledger, and that throw becomes a 503 here
  // instead of falling through to a model call we could not have metered.
  // Reaching the cap is a different thing entirely and stays a 200.
  let spent: number;
  try {
    spent = await getMonthlySpendCents(db);
  } catch (err) {
    console.error("[/api/officials/[id]/summary] spend-cap read failed", err);
    return summaryUnavailable();
  }
  if (capDecision(spent, MONTHLY_SPEND_LIMIT_CENTS) === "cap_reached") {
    return summaryNone("monthly_cap_reached");
  }

  // 4. Generate
  try {
    const ai = createAiClient();

    const itemizedDollars = (totalRaisedCents / 100).toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    });

    // FIX-931: these two labels are the model's ONLY description of the
    // numbers, so a wrong one is repeated verbatim into public prose. This is
    // not "total raised" — it is the all-cycle sum of ITEMIZED donations,
    // excluding unitemized giving, JFC transfers, IEs, loans and other
    // receipts — and the count is of donor-and-cycle rows, not distinct
    // donors. Both are spelled out inline rather than named, because the model
    // has no other context to correct them from.
    const userPrompt =
      `Write a 2-sentence factual profile of this official based on their record.\n` +
      `Focus on their role and legislative activity. Be completely neutral.\n` +
      `Do not describe the donation figure as total money raised — it is a partial, ` +
      `itemized-only subset. Do not describe the donor figure as a number of donors.\n\n` +
      `Name: ${official.full_name}\n` +
      `Title: ${official.role_title}\n` +
      `State: ${official.metadata?.state ?? "Unknown"}\n` +
      `Party: ${official.party ?? "Unknown"}\n` +
      `Votes on record: ${voteCount.toLocaleString()}\n` +
      `Donor records (donor-and-cycle pairs, not distinct donors): ${donorCount.toLocaleString()}\n` +
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

    const summaryText =
      response.content[0]?.type === "text" ? response.content[0].text.trim() : "";

    // An empty model response is an ANSWER (the model had nothing to say), not
    // an infrastructure failure — 200, and deliberately unstamped so the next
    // request retries rather than inheriting the blank from the edge.
    if (!summaryText) return summaryNone();

    const inputTokens = response.usage.input_tokens;
    const outputTokens = response.usage.output_tokens;
    const tokensUsed = inputTokens + outputTokens;
    // FIX-893: was Math.ceil((in*0.00025 + out*0.00125)/10) — a fourth private
    // copy of Haiku-3-era pricing, ~4x low. cost_cents is DECIMAL(10,4), so keep
    // exact fractional cents rather than ceiling to whole cents.
    const costCents = calculateCostUsd(inputTokens, outputTokens, MODELS.haiku) * 100;

    await Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).from("ai_summary_cache").upsert(
        {
          entity_type: "official",
          entity_id: id,
          summary_type: "profile",
          summary_text: summaryText,
          model: MODELS.haiku,
          tokens_used: tokensUsed,
        },
        { onConflict: "entity_type,entity_id,summary_type" }
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (db as any).from("api_usage_logs").insert({
        service: "anthropic",
        endpoint: "official_profile_ondemand",
        model: MODELS.haiku,
        tokens_used: tokensUsed,
        cost_cents: costCents,
      }),
    ]);

    return summaryTextResponse(summaryText);
  } catch (err) {
    // FIX-1029 — reached ONLY by a thrown error: the model client failed to
    // construct, the Anthropic call threw, or the cache/usage-log writes threw.
    // Every no-data outcome returned above without throwing, so there is no
    // legitimate 200 hiding in here.
    console.error("[/api/officials/[id]/summary]", err);
    return summaryUnavailable();
  }
}
