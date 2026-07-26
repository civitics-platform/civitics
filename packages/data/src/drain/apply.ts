/**
 * Apply one worker-produced enrichment result to the DB.
 *
 * Mirrors the validation + write logic of
 * apps/civitics/app/api/admin/enrichment/submit/route.ts but runs against
 * createAdminClient() directly (no HTTP hop, no session cookie). The CLI
 * drain submit command uses this; the route handler can be refactored to
 * share this helper in a later pass.
 *
 * On success: upserts entity_tags or ai_summary_cache, marks the queue row
 * 'done'. On failure: routes through record_enrichment_failure RPC (retries
 * until retry_count >= 3, then permanent 'failed').
 */

import { checkTagVocabulary } from "./vocabulary";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any;

export type SubmitResult = {
  queue_id: number;
  success: boolean;
  result?: unknown;
  error?: string;
};

type QueueRow = {
  id: number;
  task_type: "tag" | "summary";
  entity_id: string;
  entity_type: "proposal" | "official" | "financial_entity" | "agency";
};

type TagResultItem = {
  tag: string;
  /**
   * FIX-890: per-tag category. Optional because result files written by the
   * pre-FIX-890 prompt carry no category at all; those fall back to the old
   * per-entity-type derivation in applyResult().
   */
  tag_category?: string;
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
      tag_category:
        typeof t["tag_category"] === "string" && t["tag_category"].length > 0
          ? (t["tag_category"] as string)
          : undefined,
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

export type ApplyOutcome =
  /** `rejected` counts tags dropped by the FIX-890 vocabulary guard. */
  | { kind: "ok"; rejected?: number }
  | { kind: "fail"; error: string; rejected?: number }
  | { kind: "missing_queue_row" };

async function recordFailure(db: Db, queueId: number, msg: string): Promise<void> {
  await db.rpc("record_enrichment_failure", {
    p_queue_id: queueId,
    p_error: msg,
  });
}

export async function applyResult(db: Db, r: SubmitResult): Promise<ApplyOutcome> {
  if (typeof r?.queue_id !== "number") {
    return { kind: "fail", error: "missing queue_id" };
  }

  const { data: rowData, error: fetchErr } = await db
    .from("enrichment_queue")
    .select("id, task_type, entity_id, entity_type")
    .eq("id", r.queue_id)
    .single();

  if (fetchErr || !rowData) {
    return { kind: "missing_queue_row" };
  }
  const queueRow = rowData as QueueRow;

  if (!r.success) {
    await recordFailure(db, queueRow.id, r.error ?? "worker reported failure");
    return { kind: "fail", error: r.error ?? "worker reported failure" };
  }

  let rejectedCount = 0;

  try {
    if (queueRow.task_type === "tag") {
      const parsed = parseTagResult(r.result);
      if (!parsed) {
        await recordFailure(db, queueRow.id, "invalid tag result payload");
        return { kind: "fail", error: "invalid tag result payload" };
      }
      const model = parsed.model ?? "claude-sonnet-4-6";
      const pipelineVersion = parsed.pipeline_version ?? "v1";
      // FIX-890: fallback only. A worker on the current prompt sends
      // `tag_category` per tag; this derivation exists for result files written
      // by the pre-FIX-890 prompt that may still be in flight. It is the exact
      // shape that caused FIX-889 — one category stamped on the whole batch —
      // so it must never win over an explicit per-tag value.
      const fallbackCategory =
        queueRow.entity_type === "financial_entity" ? "industry" : "topic";

      const rows = [];
      let rejected = 0;
      for (const t of parsed.tags) {
        const tagCategory = t.tag_category ?? fallbackCategory;

        const verdict = checkTagVocabulary(queueRow.entity_type, tagCategory, t.tag);
        if (!verdict.allowed) {
          rejected++;
          console.warn(
            `[drain:apply] queue_id=${queueRow.id} rejected tag: ${verdict.reason}`,
          );
          continue;
        }

        rows.push({
          entity_type: queueRow.entity_type,
          entity_id: queueRow.entity_id,
          tag: t.tag,
          tag_category: tagCategory,
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
        });
      }

      // Every tag rejected — nothing to write. Route through the failure path
      // rather than marking the queue row 'done', so the item is retried /
      // surfaced instead of silently completing with zero tags written.
      if (rows.length === 0) {
        const msg = `all ${rejected} tag(s) rejected by vocabulary guard`;
        await recordFailure(db, queueRow.id, msg);
        return { kind: "fail", error: msg, rejected };
      }

      const { error: upsertErr } = await db
        .from("entity_tags")
        .upsert(rows, { onConflict: "entity_type,entity_id,tag,tag_category" });
      if (upsertErr) {
        const msg = `entity_tags upsert: ${upsertErr.message}`;
        await recordFailure(db, queueRow.id, msg);
        return { kind: "fail", error: msg, rejected };
      }
      rejectedCount = rejected;
    } else if (queueRow.task_type === "summary") {
      const parsed = parseSummaryResult(r.result);
      if (!parsed) {
        await recordFailure(db, queueRow.id, "invalid summary result payload");
        return { kind: "fail", error: "invalid summary result payload" };
      }
      const model = parsed.model ?? "claude-sonnet-4-6";
      const summaryType = queueRow.entity_type === "proposal" ? "plain_language" : "profile";
      const metadata: Record<string, unknown> = {};
      if (parsed.context_level) metadata["context_level"] = parsed.context_level;

      const { error: upsertErr } = await db.from("ai_summary_cache").upsert(
        {
          entity_type: queueRow.entity_type,
          entity_id: queueRow.entity_id,
          summary_type: summaryType,
          summary_text: parsed.summary_text,
          model,
          tokens_used: parsed.tokens_used ?? null,
          metadata,
        },
        { onConflict: "entity_type,entity_id,summary_type" },
      );
      if (upsertErr) {
        const msg = `ai_summary_cache upsert: ${upsertErr.message}`;
        await recordFailure(db, queueRow.id, msg);
        return { kind: "fail", error: msg };
      }
    } else {
      const msg = `unknown task_type: ${String(queueRow.task_type)}`;
      await recordFailure(db, queueRow.id, msg);
      return { kind: "fail", error: msg };
    }

    // Data landed; mark queue row done. If this update fails the data write
    // already succeeded and the upsert is idempotent — row stays 'processing'
    // and can be reclaimed by a later stale-claim sweep. Benign.
    const { error: doneErr } = await db
      .from("enrichment_queue")
      .update({
        status: "done",
        completed_at: new Date().toISOString(),
        result: r.result as unknown as object,
        last_error: null,
      })
      .eq("id", queueRow.id);
    if (doneErr) {
      console.warn(
        `enrichment_queue update (done) failed for ${queueRow.id}: ${doneErr.message}`,
      );
    }
    return { kind: "ok", rejected: rejectedCount };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await recordFailure(db, queueRow.id, `submit exception: ${msg}`);
    return { kind: "fail", error: msg, rejected: rejectedCount };
  }
}
