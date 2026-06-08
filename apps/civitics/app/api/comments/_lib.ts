// Shared server-side helpers for the unified /api/comments surface (C0, FIX-520).
//
// All writes go through the service_role admin client: the constituent-grant
// check reads entity_grants (service-role-only) and the badge/jurisdiction
// lookups + rate-limit counts are cheaper without per-row RLS. Reads use the
// admin client too (server-only routes over public data) but ALWAYS constrain
// status/lens in the query — never lean on RLS for visibility here.

import type { SupabaseClient } from "@supabase/supabase-js";
import { kindLabel, MAX_THREAD_DEPTH, type EntityCommentType } from "@civitics/db";

// Loosely-typed admin client alias — the generated Database type is threaded
// through createAdminClient already; this keeps the helper signatures readable.
type Admin = SupabaseClient<any, "public", any>;

export type CommentPayload = {
  id: string;
  entity_type: string;
  entity_id: string;
  parent_id: string | null;
  thread_root_id: string | null;
  kind: string;
  kind_label: string;
  stance: string | null;
  body: string;
  status: string;
  author_id: string;
  author_name: string;
  is_constituent: boolean;
  rating_summary: {
    agree_up: number;
    agree_down: number;
    valuable_up: number;
    valuable_down: number;
    legacy_upvotes: number;
    deltas: number;
  };
  created_at: string;
  updated_at: string;
  replies: CommentPayload[];
};

type RawComment = {
  id: string;
  entity_type: string;
  entity_id: string;
  parent_id: string | null;
  thread_root_id: string | null;
  kind: string;
  stance: string | null;
  body: string;
  status: string;
  author_id: string;
  constituent_jurisdiction_id: string | null;
  rating_summary: unknown; // jsonb — coerced in normalizeSummary
  created_at: string;
  updated_at: string;
};

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
}

// Pseudonymous identity only — never email (decision 16).
export function displayNameFor(id: string, name: string | null | undefined): string {
  if (name && name.trim()) return name.trim();
  return `citizen-${id.slice(0, 8)}`;
}

function normalizeSummary(raw: unknown) {
  const obj = asRecord(raw);
  const n = (k: string) => {
    const v = obj[k];
    return typeof v === "number" ? v : Number(v ?? 0) || 0;
  };
  return {
    agree_up: n("agree_up"),
    agree_down: n("agree_down"),
    valuable_up: n("valuable_up"),
    valuable_down: n("valuable_down"),
    legacy_upvotes: n("legacy_upvotes"),
    deltas: n("deltas"),
  };
}

// "top" score: (valuable_up − valuable_down) with legacy_upvotes as seed (decision 13).
export function topScore(raw: unknown): number {
  const s = normalizeSummary(raw);
  return s.valuable_up - s.valuable_down + s.legacy_upvotes;
}

// The COLUMN_LIST every read selects.
export const COMMENT_COLUMNS =
  "id,entity_type,entity_id,parent_id,thread_root_id,kind,stance,body,status,author_id,constituent_jurisdiction_id,rating_summary,created_at,updated_at";

// Map an author_id -> display_name (two-step; entity_comments.author_id IS an
// FK to users, but we keep the manual fetch so the payload stays explicit and
// never leaks email).
export async function fetchNameMap(admin: Admin, ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return map;
  const { data } = await admin.from("users").select("id,display_name").in("id", unique);
  for (const u of (data ?? []) as Array<{ id: string; display_name: string | null }>) {
    map.set(u.id, displayNameFor(u.id, u.display_name));
  }
  for (const id of unique) if (!map.has(id)) map.set(id, displayNameFor(id, null));
  return map;
}

export function serialize(row: RawComment, names: Map<string, string>): CommentPayload {
  return {
    id: row.id,
    entity_type: row.entity_type,
    entity_id: row.entity_id,
    parent_id: row.parent_id,
    thread_root_id: row.thread_root_id,
    kind: row.kind,
    kind_label: kindLabel(row.kind),
    stance: row.stance,
    body: row.body,
    status: row.status,
    author_id: row.author_id,
    author_name: names.get(row.author_id) ?? displayNameFor(row.author_id, null),
    is_constituent: row.constituent_jurisdiction_id !== null,
    rating_summary: normalizeSummary(row.rating_summary),
    created_at: row.created_at,
    updated_at: row.updated_at,
    replies: [],
  };
}

// Nest a flat set of thread rows under the given roots (depth-bounded by data).
export function nestReplies(
  roots: CommentPayload[],
  descendants: RawComment[],
  names: Map<string, string>,
): CommentPayload[] {
  const byId = new Map<string, CommentPayload>();
  for (const r of roots) byId.set(r.id, r);
  // Insert descendants in created_at order so parents are present first.
  const ordered = [...descendants].sort((a, b) => a.created_at.localeCompare(b.created_at));
  for (const d of ordered) {
    if (byId.has(d.id)) continue;
    const node = serialize(d, names);
    byId.set(d.id, node);
    const parent = d.parent_id ? byId.get(d.parent_id) : null;
    if (parent) parent.replies.push(node);
  }
  return roots;
}

// Resolve the jurisdiction that governs the comment's target entity.
export async function resolveEntityJurisdiction(
  admin: Admin,
  entityType: EntityCommentType,
  entityId: string,
): Promise<string | null> {
  if (entityType === "jurisdiction") return entityId;
  const table =
    entityType === "proposal" ? "proposals"
    : entityType === "official" ? "officials"
    : entityType === "institution" ? "institutions"
    : null;
  if (!table) return null; // financial_entity / district → no badge
  const { data } = await admin.from(table).select("jurisdiction_id").eq("id", entityId).maybeSingle();
  return (data as { jurisdiction_id: string | null } | null)?.jurisdiction_id ?? null;
}

// Snapshot-at-write constituent badge: stamp the target's jurisdiction iff the
// author holds an active constituent grant there (decision 11).
export async function resolveConstituentBadge(
  admin: Admin,
  authorId: string,
  entityType: EntityCommentType,
  entityId: string,
): Promise<string | null> {
  const juris = await resolveEntityJurisdiction(admin, entityType, entityId);
  if (!juris) return null;
  const { data, error } = await admin.rpc("has_active_constituent_grant", {
    p_user_id: authorId,
    p_jurisdiction_id: juris,
  });
  if (error || data !== true) return null;
  return juris;
}

// Rolling-24h rate-limit count check. Returns true if the user is AT/OVER limit.
export async function isRateLimited(
  admin: Admin,
  table: "entity_comments" | "comment_ratings" | "content_flags",
  userCol: string,
  userId: string,
  limit: number,
  extraEq?: Record<string, string>,
): Promise<boolean> {
  const sinceIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  let q = admin
    .from(table)
    .select("*", { count: "exact", head: true })
    .eq(userCol, userId)
    .gte("created_at", sinceIso);
  for (const [k, v] of Object.entries(extraEq ?? {})) q = q.eq(k, v);
  const { count } = await q;
  return (count ?? 0) >= limit;
}

// Compute the depth of a reply given the parent and the thread's rows.
// root = 0; rejects when it would exceed MAX_THREAD_DEPTH.
export function replyDepthExceeded(
  parentId: string,
  threadRows: Array<{ id: string; parent_id: string | null }>,
): boolean {
  const byId = new Map(threadRows.map((r) => [r.id, r]));
  let depth = 1; // the new reply sits one below its parent
  let cur: string | null = parentId;
  while (cur) {
    const row = byId.get(cur);
    if (!row || row.parent_id === null) break;
    depth += 1;
    cur = row.parent_id;
    if (depth > MAX_THREAD_DEPTH) return true;
  }
  return depth > MAX_THREAD_DEPTH;
}
