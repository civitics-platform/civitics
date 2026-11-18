// FIX-401 — a reader's flag on a data row. The validation, the entity map, the
// cap's numbers and the decision core of POST /api/data-flags, kept free of
// next/* so `tsx --test` runs them (data-flags.test.ts).
//
// The cap is ENFORCED by the table's BEFORE INSERT trigger
// (supabase/migrations/20261120000000_fix401_data_flags.sql), because the
// insert-own policy is a write path that never passes the route. The route maps
// its 53400 to 429. The literals below are mirrored from that migration and
// pinned against it by the test.

import {
  ATTRIBUTION_ENTITY_TYPES,
  isAttributionEntityType,
  type AttributionEntityType,
} from "@civitics/db";
import { entityPath, type EntityKind } from "./canonical";

export const DATA_FLAG_REASONS = ["wrong", "outdated", "missing_source", "misspelled", "other"] as const;
export type DataFlagReason = (typeof DATA_FLAG_REASONS)[number];

/** The picker's words, in the order the picker shows them. */
export const DATA_FLAG_REASON_LABELS: Record<DataFlagReason, string> = {
  wrong:          "Something here is wrong",
  outdated:       "Out of date",
  missing_source: "No source shown",
  misspelled:     "Name is misspelled",
  other:          "Something else",
};

export const DATA_FLAG_RESOLUTIONS = ["valid", "invalid", "duplicate", "no_action"] as const;
export type DataFlagResolution = (typeof DATA_FLAG_RESOLUTIONS)[number];

export const DATA_FLAG_COMMENT_MAX = 500;
export const DATA_FLAG_SOURCE_MAX = 64;

/** Flags per flagger per rolling window. The trigger's `v_recent >= 20`. */
export const DATA_FLAG_DAILY_CAP = 20;
export const DATA_FLAG_WINDOW_HOURS = 24;
export const DATA_FLAG_CAP_MESSAGE =
  "You can flag up to 20 things in 24 hours, and you have reached that. Please try again tomorrow.";

/**
 * The admin queue's pending rule: unresolved by an admin AND not confidently
 * classified by the (future, unbuilt) auto-moderator.
 */
export const DATA_FLAG_AUTO_CONFIDENCE = 0.8;
export const DATA_FLAG_PENDING_OR_FILTER =
  `classification.is.null,classification_confidence.lt.${DATA_FLAG_AUTO_CONFIDENCE}`;

export function isPendingDataFlag(row: {
  admin_resolved_at: string | null;
  classification: string | null;
  classification_confidence: number | null;
}): boolean {
  if (row.admin_resolved_at !== null) return false;
  if (row.classification === null) return true;
  return row.classification_confidence !== null && row.classification_confidence < DATA_FLAG_AUTO_CONFIDENCE;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_KEY_RE = /^[A-Za-z0-9_:.-]+$/;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export interface DataFlagInput {
  entity_type: AttributionEntityType;
  entity_id: string;
  reason: DataFlagReason;
  comment: string | null;
  source: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Body of POST /api/data-flags → a flag, or the 400's sentence. */
export function parseDataFlagBody(body: unknown): Parsed<DataFlagInput> {
  if (!isRecord(body)) return { ok: false, error: "Body must be a JSON object" };

  const { entity_type, entity_id, reason, comment, source } = body;

  if (typeof entity_type !== "string" || !isAttributionEntityType(entity_type)) {
    return { ok: false, error: `entity_type must be one of ${ATTRIBUTION_ENTITY_TYPES.join(", ")}` };
  }
  if (typeof entity_id !== "string" || !UUID_RE.test(entity_id)) {
    return { ok: false, error: "entity_id must be a UUID" };
  }
  if (typeof reason !== "string" || !(DATA_FLAG_REASONS as readonly string[]).includes(reason)) {
    return { ok: false, error: `reason must be one of ${DATA_FLAG_REASONS.join(", ")}` };
  }

  let cleanComment: string | null = null;
  if (comment !== undefined && comment !== null) {
    if (typeof comment !== "string") return { ok: false, error: "comment must be text" };
    const trimmed = comment.trim();
    if (trimmed.length > DATA_FLAG_COMMENT_MAX) {
      return { ok: false, error: `Comment too long (max ${DATA_FLAG_COMMENT_MAX} characters)` };
    }
    cleanComment = trimmed === "" ? null : trimmed;
  }

  let cleanSource: string | null = null;
  if (source !== undefined && source !== null && source !== "") {
    if (typeof source !== "string" || source.length > DATA_FLAG_SOURCE_MAX || !SOURCE_KEY_RE.test(source)) {
      return { ok: false, error: "source must be a source key" };
    }
    cleanSource = source;
  }

  return {
    ok: true,
    value: {
      entity_type,
      entity_id: entity_id.toLowerCase(),
      reason: reason as DataFlagReason,
      comment: cleanComment,
      source: cleanSource,
    },
  };
}

/** The reads and the write the decision needs; the route binds them to the admin client. */
export interface DataFlagDeps {
  /** One primary-key lookup in the entity's table. Throws on a DB error. */
  entityExists(type: AttributionEntityType, id: string): Promise<boolean>;
  /** The same (entity, flagger, reason) already flagged. Throws on a DB error. */
  alreadyFlagged(flag: DataFlagInput, userId: string): Promise<boolean>;
  /** The insert: the new row's id, or the SQLSTATE it failed with. */
  insert(flag: DataFlagInput, userId: string): Promise<{ id: string } | { errorCode: string }>;
}

export type DataFlagOutcome =
  | { status: 200; body: { flagged: true }; created: { id: string; flag: DataFlagInput } | null }
  | { status: 400 | 404 | 500; body: { error: string } }
  | { status: 429; body: { error: string }; capHit: DataFlagInput };

/**
 * The route after its 401: validate → the entity exists → a repeat is a no-op →
 * insert. The table's trigger owns the cap (53400 → 429); a unique-key race
 * (23505) is the repeat it is.
 */
export async function submitDataFlag(
  body: unknown,
  userId: string,
  deps: DataFlagDeps,
): Promise<DataFlagOutcome> {
  const parsed = parseDataFlagBody(body);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const flag = parsed.value;

  try {
    if (!(await deps.entityExists(flag.entity_type, flag.entity_id))) {
      return { status: 404, body: { error: "Nothing to flag: that record was not found" } };
    }
    if (await deps.alreadyFlagged(flag, userId)) {
      return { status: 200, body: { flagged: true }, created: null };
    }
    const res = await deps.insert(flag, userId);
    if ("id" in res) return { status: 200, body: { flagged: true }, created: { id: res.id, flag } };
    if (res.errorCode === "23505") return { status: 200, body: { flagged: true }, created: null };
    if (res.errorCode === "53400") return { status: 429, body: { error: DATA_FLAG_CAP_MESSAGE }, capHit: flag };
    return { status: 500, body: { error: "Failed to flag" } };
  } catch {
    return { status: 500, body: { error: "Failed to flag" } };
  }
}

/** POST /api/admin/moderation `{ action: "resolve_data_flag", flag_id, resolution }`. */
export function parseResolveDataFlag(
  body: unknown,
): Parsed<{ flag_id: string; resolution: DataFlagResolution }> {
  if (!isRecord(body)) return { ok: false, error: "Body must be a JSON object" };
  const { flag_id, resolution } = body;
  if (typeof flag_id !== "string" || !UUID_RE.test(flag_id)) {
    return { ok: false, error: "flag_id must be a UUID" };
  }
  if (typeof resolution !== "string" || !(DATA_FLAG_RESOLUTIONS as readonly string[]).includes(resolution)) {
    return { ok: false, error: `resolution must be one of ${DATA_FLAG_RESOLUTIONS.join("|")}` };
  }
  return { ok: true, value: { flag_id: flag_id.toLowerCase(), resolution: resolution as DataFlagResolution } };
}

/** The column the admin queue shows as each entity's name. */
export const DATA_FLAG_NAME_COLUMN: Record<AttributionEntityType, string> = {
  official:         "full_name",
  proposal:         "title",
  agency:           "name",
  governing_body:   "name",
  financial_entity: "display_name",
};

const ENTITY_KIND: Record<AttributionEntityType, EntityKind> = {
  official:         "official",
  proposal:         "proposal",
  agency:           "agency",
  governing_body:   "institution",
  financial_entity: "donor",
};

/** The flagged entity's page. */
export function dataFlagEntityPath(type: AttributionEntityType, id: string): string {
  return entityPath(ENTITY_KIND[type], id);
}
