/**
 * /api/graph/custom-groups — FIX-126, FIX-763
 *
 * GET    list — own groups + any public groups, newest first
 * POST   create — owned by signed-in user. Two accepted filter shapes:
 *          v2 (FIX-763): { v: 2, scope, facets, q, sort } — a saved BrowseState;
 *            the write path for everything W2+ (both /search and graph mounts).
 *          v1 (legacy):  { entity_type, chamber?, party?, state?, industry? } —
 *            kept for GroupBuilderWidget back-compat; read paths up-compile.
 * DELETE remove by ?id=<uuid> — RLS enforces own-only
 */

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import {
  buildSavedViewPayload,
  parseSavedViewFilter,
  InvalidSavedViewError,
  UnknownIndustryTokenError,
} from "@/lib/browse/graph-compiler";

export const dynamic = "force-dynamic";

const ENTITY_TYPES   = new Set(["official", "pac", "agency"]);
const CHAMBER_VALUES = new Set(["senate", "house"]);
const UUID_RE        = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface GroupFilter {
  entity_type: "official" | "pac" | "agency";
  chamber?: "senate" | "house";
  party?: string;
  state?: string;
  industry?: string;
}

function parseFilter(input: unknown): GroupFilter | { error: string } {
  if (!input || typeof input !== "object") return { error: "filter must be an object" };
  const f = input as Record<string, unknown>;
  if (typeof f["entity_type"] !== "string" || !ENTITY_TYPES.has(f["entity_type"])) {
    return { error: "filter.entity_type must be 'official' | 'pac' | 'agency'" };
  }
  if (f["chamber"] !== undefined && (typeof f["chamber"] !== "string" || !CHAMBER_VALUES.has(f["chamber"]))) {
    return { error: "filter.chamber must be 'senate' | 'house' if present" };
  }
  for (const key of ["party", "state", "industry"] as const) {
    if (f[key] !== undefined && typeof f[key] !== "string") {
      return { error: `filter.${key} must be a string if present` };
    }
  }
  return {
    entity_type: f["entity_type"] as GroupFilter["entity_type"],
    ...(f["chamber"]  !== undefined ? { chamber:  f["chamber"]  as GroupFilter["chamber"]  } : {}),
    ...(f["party"]    !== undefined ? { party:    f["party"]    as string } : {}),
    ...(f["state"]    !== undefined ? { state:    f["state"]    as string } : {}),
    ...(f["industry"] !== undefined ? { industry: f["industry"] as string } : {}),
  };
}

export async function GET() {
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const { data: { user } } = await supabase.auth.getUser();

  // RLS already constrains visibility to (own OR public). For unauthenticated
  // requests we still return public groups.
  let query = supabase
    .from("user_custom_groups")
    .select("id, user_id, name, filter, icon, color, is_public, created_at, updated_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (!user) query = query.eq("is_public", true);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const userId = user?.id ?? null;
  const groups = (data ?? []).map((g: { user_id: string; [k: string]: unknown }) => ({
    ...g,
    is_owner: userId !== null && g.user_id === userId,
  }));

  return NextResponse.json({ groups });
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null) as
    | { name?: unknown; filter?: unknown; icon?: unknown; color?: unknown; is_public?: unknown }
    | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 1 || name.length > 80) {
    return NextResponse.json({ error: "name must be 1-80 chars" }, { status: 400 });
  }

  // v2 saved-view payload (FIX-763) or legacy v1 GroupFilter — v2 is detected
  // by its `v: 2` marker; v1 keeps the original strict parse. Stored v2 rows
  // are re-serialized through buildSavedViewPayload so only the canonical keys
  // ({v, scope, facets, q, sort}) land in the JSONB.
  let filter: unknown;
  const raw = body.filter as Record<string, unknown> | null | undefined;
  if (raw && typeof raw === "object" && raw["v"] === 2) {
    try {
      const parsed = parseSavedViewFilter(raw);
      filter = buildSavedViewPayload(parsed.state);
    } catch (e) {
      const message =
        e instanceof InvalidSavedViewError || e instanceof UnknownIndustryTokenError
          ? e.message
          : "invalid saved-view filter";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  } else {
    const v1 = parseFilter(body.filter);
    if ("error" in v1) return NextResponse.json({ error: v1.error }, { status: 400 });
    filter = v1;
  }

  const icon  = typeof body.icon  === "string" ? body.icon  : null;
  const color = typeof body.color === "string" ? body.color : null;
  const isPublic = body.is_public === true;

  const { data, error } = await supabase
    .from("user_custom_groups")
    .insert({
      user_id:   user.id,
      name,
      filter,
      icon,
      color,
      is_public: isPublic,
    })
    .select("id, user_id, name, filter, icon, color, is_public, created_at, updated_at")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ group: { ...data, is_owner: true } }, { status: 201 });
}

export async function DELETE(request: Request) {
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(request.url).searchParams.get("id");
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "id query param required (uuid)" }, { status: 400 });
  }

  // RLS limits the delete to user_id = auth.uid(). count: 'exact' tells us
  // whether anything actually matched so we can return 404 vs 200.
  const { error, count } = await supabase
    .from("user_custom_groups")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!count) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
