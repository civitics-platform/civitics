export const dynamic = "force-dynamic";

/**
 * POST /api/admin/enrichment/submit
 *
 * Accepts worker-produced results for queued enrichment tasks, writes them
 * to the terminal tables (entity_tags / ai_summary_cache), and marks each
 * queue row 'done' or 'failed' (retry_count++ on failure).
 *
 * Body: { results: Array<{
 *   queue_id: number;
 *   success: boolean;
 *   result?: unknown;      // task-shaped payload when success
 *   error?: string;        // worker-side failure reason when !success
 * }> }
 *
 * Admin-only — matches /api/admin/run-pipeline auth (ADMIN_EMAIL via
 * Supabase Auth session cookies). No new secret.
 */

import { createServerClient, createAdminClient, summaryPromptVersion } from "@civitics/db";
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

type SubmitResult = {
  queue_id: number;
  success: boolean;
  result?: unknown;
  error?: string;
};

type QueueRow = {
  id: number;
  task_type: "tag" | "summary";
  entity_id: string;
  entity_type: "proposal" | "official";
};

type TagResultItem = {
  tag: string;
  display_label?: string;
  display_icon?: string | null;
  visibility?: "primary" | "secondary" | "internal";
  confidence?: number;
  is_primary?: boolean;
  reasoning?: string;
  affects_individuals?: boolean;
  rank?: number;
};

type TagResultPayload = {
  tags: TagResultItem[];
  model?: string;
  pipeline_version?: string;
};

type SummaryResultPayload = {
  summary_text: string;
  model?: string;
  context_level?: string;
  tokens_used?: number | null;
};

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function parseTagResult(x: unknown): TagResultPayload | null {
  if (!isRecord(x) || !Array.isArray(x["tags"])) return null;
  const tags: TagResultItem[] = [];
  for (const t of x["tags"]) {
    if (!isRecord(t) || typeof t["tag"] !== "string") return null;
    tags.push({
      tag: t["tag"] as string,
      display_label: typeof t["display_label"] === "string" ? (t["display_label"] as string) : undefined,
      display_icon:
        typeof t["display_icon"] === "string" || t["display_icon"] === null
          ? (t["display_icon"] as string | null)
          : undefined,
      visibility:
        t["visibility"] === "primary" || t["visibility"] === "secondary" || t["visibility"] === "internal"
          ? (t["visibility"] as "primary" | "secondary" | "internal")
          : undefined,
      confidence: typeof t["confidence"] === "number" ? (t["confidence"] as number) : undefined,
      is_primary: typeof t["is_primary"] === "boolean" ? (t["is_primary"] as boolean) : undefined,
      reasoning: typeof t["reasoning"] === "string" ? (t["reasoning"] as string) : undefined,
      affects_individuals:
        typeof t["affects_individuals"] === "boolean" ? (t["affects_individuals"] as boolean) : undefined,
      rank: typeof t["rank"] === "number" ? (t["rank"] as number) : undefined,
    });
  }
  if (tags.length === 0) return null;
  return {
    tags,
    model: typeof x["model"] === "string" ? (x["model"] as string) : undefined,
    pipeline_version:
      typeof x["pipeline_version"] === "string" ? (x["pipeline_version"] as string) : undefined,
  };
}

function parseSummaryResult(x: unknown): SummaryResultPayload | null {
  if (!isRecord(x)) return null;
  const text = x["summary_text"];
  if (typeof text !== "string" || text.trim().length === 0) return null;
  return {
    summary_text: text,
    model: typeof x["model"] === "string" ? (x["model"] as string) : undefined,
    context_level: typeof x["context_level"] === "string" ? (x["context_level"] as string) : undefined,
    tokens_used: typeof x["tokens_used"] === "number" ? (x["tokens_used"] as number) : null,
  };
}

function titleize(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (supabaseUnavailable()) return unavailableResponse();
  const adminEmail = process.env["ADMIN_EMAIL"];
  if (!adminEmail) {
    return NextResponse.json({ error: "ADMIN_EMAIL not configured" }, { status: 503 });
  }

  const supabase = createServerClient(cookies());
  const { data: { user } } = await supabase.auth.getUser();

  if (!user || user.email !== adminEmail) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  let body: { results?: SubmitResult[] };
  try {
    body = (await request.json()) as { results?: SubmitResult[] };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const results = Array.isArray(body.results) ? body.results : null;
  if (!results) {
    return NextResponse.json({ error: "body.results must be an array" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  let processed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const r of results) {
    if (typeof r?.queue_id !== "number") continue;
    processed++;

    const { data: rowData, error: fetchErr } = await admin
      .from("enrichment_queue")
      .select("id, task_type, entity_id, entity_type")
      .eq("id", r.queue_id)
      .single();

    if (fetchErr || !rowData) {
      failed++;
      continue;
    }
    const queueRow = rowData as QueueRow;

    const recordFailure = async (msg: string) => {
      await admin.rpc("record_enrichment_failure", {
        p_queue_id: queueRow.id,
        p_error: msg,
      });
      failed++;
    };

    if (!r.success) {
      await recordFailure(r.error ?? "worker reported failure");
      continue;
    }

    try {
      if (queueRow.task_type === "tag") {
        const parsed = parseTagResult(r.result);
        if (!parsed) {
          await recordFailure("invalid tag result payload");
          continue;
        }
        const model = parsed.model ?? "claude-sonnet-4-6";
        const pipelineVersion = parsed.pipeline_version ?? "v1";
        const rows = parsed.tags.map((t) => ({
          entity_type: queueRow.entity_type,
          entity_id: queueRow.entity_id,
          tag: t.tag,
          tag_category: "topic",
          display_label: t.display_label ?? titleize(t.tag),
          display_icon: t.display_icon ?? null,
          visibility: t.visibility ?? "secondary",
          generated_by: "ai",
          confidence: typeof t.confidence === "number" ? t.confidence : 0.7,
          ai_model: model,
          pipeline_version: pipelineVersion,
          metadata: {
            ...(t.is_primary !== undefined ? { is_primary: t.is_primary } : {}),
            ...(t.reasoning !== undefined ? { reasoning: t.reasoning } : {}),
            ...(t.affects_individuals !== undefined
              ? { affects_individuals: t.affects_individuals }
              : {}),
            ...(t.rank !== undefined ? { rank: t.rank } : {}),
          },
        }));

        const { error: upsertErr } = await admin
          .from("entity_tags")
          .upsert(rows, { onConflict: "entity_type,entity_id,tag,tag_category" });
        if (upsertErr) {
          await recordFailure(`entity_tags upsert: ${upsertErr.message}`);
          continue;
        }
      } else if (queueRow.task_type === "summary") {
        const parsed = parseSummaryResult(r.result);
        if (!parsed) {
          await recordFailure("invalid summary result payload");
          continue;
        }
        const model = parsed.model ?? "claude-sonnet-4-6";
        const summaryType =
          queueRow.entity_type === "proposal" ? "plain_language" : "profile";
        const metadata: Record<string, unknown> = {};
        if (parsed.context_level) metadata["context_level"] = parsed.context_level;

        const { error: upsertErr } = await admin.from("ai_summary_cache").upsert(
          {
            entity_type: queueRow.entity_type,
            entity_id: queueRow.entity_id,
            summary_type: summaryType,
            summary_text: parsed.summary_text,
            model,
            tokens_used: parsed.tokens_used ?? null,
            metadata,
            // FIX-938 — same cache keys as the drain CLI path; same version.
            prompt_version: summaryPromptVersion(queueRow.entity_type, summaryType),
          },
          { onConflict: "entity_type,entity_id,summary_type" },
        );
        if (upsertErr) {
          await recordFailure(`ai_summary_cache upsert: ${upsertErr.message}`);
          continue;
        }
      } else {
        await recordFailure(`unknown task_type: ${String(queueRow.task_type)}`);
        continue;
      }

      // Mark queue row done. If this update fails the data write already
      // succeeded and the upsert is idempotent — row stays 'processing' and
      // can be reclaimed by a later stale-claim sweep. Benign.
      const { error: doneErr } = await admin
        .from("enrichment_queue")
        .update({
          status: "done",
          completed_at: new Date().toISOString(),
          result: r.result as unknown as object,
          last_error: null,
        })
        .eq("id", queueRow.id);
      if (doneErr) {
        // Data already landed — count as success, log server-side.
        console.warn(`enrichment_queue update (done) failed for ${queueRow.id}:`, doneErr.message);
      }
      succeeded++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await recordFailure(`submit exception: ${msg}`);
    }
  }

  return NextResponse.json({ processed, succeeded, failed });
}
