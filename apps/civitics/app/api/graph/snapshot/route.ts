import { createAdminClient } from "@civitics/db";
import type { Json } from "@civitics/db";

export const dynamic = "force-dynamic";

// ── Code generation ────────────────────────────────────────────────────────
const CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous I/O/0/1

function randomSegment(len: number): string {
  let out = "";
  for (let i = 0; i < len; i++) {
    out += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return out;
}

/**
 * CIV-XXXX-YYYY
 * First segment: 4 random chars
 * Second segment: derived from preset name slug (max 4 chars) + random pad
 */
function generateCode(presetSlug?: string): string {
  const seg1 = randomSegment(4);
  const base = presetSlug
    ? presetSlug.replace(/[^a-z]/g, "").toUpperCase().slice(0, 4)
    : "";
  const seg2 = (base + randomSegment(4)).slice(0, 4);
  return `CIV-${seg1}-${seg2}`;
}

// ── POST /api/graph/snapshot — create a new snapshot ──────────────────────
export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      state: Record<string, unknown>;
      title?: string;
      preset?: string;
    };

    if (!body.state || typeof body.state !== "object") {
      return Response.json({ error: "state is required" }, { status: 400 });
    }

    const supabase = createAdminClient();

    // Generate a unique code — retry up to 5 times on collision
    let code = "";
    for (let attempt = 0; attempt < 5; attempt++) {
      code = generateCode(body.preset);
      const { data: existing } = await supabase
        .from("graph_snapshots")
        .select("id")
        .eq("code", code)
        .maybeSingle();
      if (!existing) break;
    }

    if (!code) {
      return Response.json({ error: "Failed to generate unique code" }, { status: 500 });
    }

    const { data, error } = await supabase
      .from("graph_snapshots")
      .insert({
        code,
        state: body.state as Json,
        title: body.title ?? null,
        is_public: true,
      })
      .select("code, id, created_at")
      .single();

    if (error) throw error;

    return Response.json({
      code: data.code,
      url: `${getOrigin(request)}/graph/${data.code}`,
      created_at: data.created_at,
    });
  } catch (err) {
    console.error("[graph/snapshot POST]", err);
    return Response.json({ error: "Failed to save snapshot" }, { status: 500 });
  }
}

// ── GET /api/graph/snapshot?code=CIV-XXXX-YYYY — fetch a snapshot ─────────
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get("code");

    if (!code) {
      return Response.json({ error: "code is required" }, { status: 400 });
    }

    const supabase = createAdminClient();

    const { data, error } = await supabase
      .from("graph_snapshots")
      .select("code, state, title, created_at, view_count")
      .eq("code", code)
      .single();

    if (error || !data) {
      return Response.json({ error: "Snapshot not found" }, { status: 404 });
    }

    // Increment view count asynchronously — don't await, don't fail on error.
    void supabase.rpc("increment_snapshot_view", { p_code: code });

    return Response.json(data);
  } catch (err) {
    console.error("[graph/snapshot GET]", err);
    return Response.json({ error: "Failed to fetch snapshot" }, { status: 500 });
  }
}

function getOrigin(request: Request): string {
  const url = new URL(request.url);
  return `${url.protocol}//${url.host}`;
}
