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
  // SF-P2 (FIX-599): author's users.is_synthetic, for the persistent SYNTHETIC
  // per-utterance mark. Resolved alongside the display name in fetchAuthorMeta.
  author_is_synthetic: boolean;
  is_constituent: boolean;
  rating_summary: {
    agree_up: number;
    agree_down: number;
    valuable_up: number;
    valuable_down: number;
    legacy_upvotes: number;
    deltas: number;
  };
  // C1 Wave B (FIX-528): nightly bridge scorer output; NULL until scored.
  bridge_score: number | null;
  map_x: number | null;
  map_y: number | null;
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
  bridge_score: number | string | null; // numeric — PostgREST may serialize as string
  map_x: number | string | null;
  map_y: number | string | null;
  created_at: string;
  updated_at: string;
};

// numeric columns arrive as string (or number) over PostgREST; coerce to number|null.
function num(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

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

// Q&A v2 PR-1 (FIX-626): community-context citation soft-validation. A community_note
// body must contain ≥1 link — an absolute http(s):// URL OR an in-app record path.
// Mirrors submit_comment's SQL check (the RPC is the HARD enforcement; this is the
// route's friendly early-400). Keep the two regexes in lockstep with the SQL.
const RECORD_LINK_RE = /https?:\/\/|\/(proposals|officials|votes|jurisdictions|institutions|investigations)\//i;
export function hasRecordLink(body: string): boolean {
  return RECORD_LINK_RE.test(body);
}

// "top" score: (valuable_up − valuable_down) with legacy_upvotes as seed (decision 13).
export function topScore(raw: unknown): number {
  const s = normalizeSummary(raw);
  return s.valuable_up - s.valuable_down + s.legacy_upvotes;
}

// The COLUMN_LIST every read selects.
export const COMMENT_COLUMNS =
  "id,entity_type,entity_id,parent_id,thread_root_id,kind,stance,body,status,author_id,constituent_jurisdiction_id,rating_summary,bridge_score,map_x,map_y,created_at,updated_at";

// Author display name + SF-P2 synthetic flag, resolved together.
export type AuthorMeta = { name: string; isSynthetic: boolean };

// Map an author_id -> { name, isSynthetic } (two-step; entity_comments.author_id
// IS an FK to users, but we keep the manual fetch so the payload stays explicit
// and never leaks email). is_synthetic (FIX-572) drives the persistent SYNTHETIC
// mark — throw on query error rather than silently dropping labels (the
// dangerous direction: unlabeled fiction would render as real).
export async function fetchAuthorMeta(admin: Admin, ids: string[]): Promise<Map<string, AuthorMeta>> {
  const map = new Map<string, AuthorMeta>();
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return map;
  const { data, error } = await admin
    .from("users")
    .select("id,display_name,is_synthetic")
    .in("id", unique);
  if (error) throw error;
  for (const u of (data ?? []) as Array<{ id: string; display_name: string | null; is_synthetic: boolean | null }>) {
    map.set(u.id, { name: displayNameFor(u.id, u.display_name), isSynthetic: u.is_synthetic === true });
  }
  for (const id of unique)
    if (!map.has(id)) map.set(id, { name: displayNameFor(id, null), isSynthetic: false });
  return map;
}

// Back-compat name-only view over fetchAuthorMeta (one query, no extra round-trip).
export async function fetchNameMap(admin: Admin, ids: string[]): Promise<Map<string, string>> {
  const meta = await fetchAuthorMeta(admin, ids);
  const names = new Map<string, string>();
  for (const [id, m] of meta) names.set(id, m.name);
  return names;
}

export function serialize(row: RawComment, names: Map<string, AuthorMeta>): CommentPayload {
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
    author_name: names.get(row.author_id)?.name ?? displayNameFor(row.author_id, null),
    author_is_synthetic: names.get(row.author_id)?.isSynthetic ?? false,
    is_constituent: row.constituent_jurisdiction_id !== null,
    rating_summary: normalizeSummary(row.rating_summary),
    bridge_score: num(row.bridge_score),
    map_x: num(row.map_x),
    map_y: num(row.map_y),
    created_at: row.created_at,
    updated_at: row.updated_at,
    replies: [],
  };
}

// Nest a flat set of thread rows under the given roots (depth-bounded by data).
export function nestReplies(
  roots: CommentPayload[],
  descendants: RawComment[],
  names: Map<string, AuthorMeta>,
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
