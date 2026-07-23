// Positions API (C1 / FIX-524) — the REST surface over the entity_positions
// spine (FIX-523).
//
// Writes go through set_entity_position() called on the CALLER's server client
// (createServerClient → publishable key + the user's JWT), NOT the admin client:
// the RPC reads auth.uid() and is SECURITY DEFINER, so the user is the actor and
// every anti-collusion delta guard runs server-side. The RPC is the throttle —
// there is no extra app-layer rate limiting this wave.
//
// Responses never include another user's positions or events (own-rows RLS +
// auth.uid()-scoped RPC).

import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { isEntityCommentType } from "@civitics/db";
import { challengeRequiredForWrite, verifyTurnstile } from "@/lib/turnstile";
import { recordAbuseEvent } from "@/lib/abuse-events";

export const dynamic = "force-dynamic";

// Map a Postgres RAISE (SQLSTATE) from set_entity_position() to an HTTP status
// + a stable machine-readable code. Guard violations are 400; the daily-cap is
// 429; unauthenticated is 401.
function mapRpcError(code: string | undefined, message: string): { status: number; code: string; error: string } {
  switch (code) {
    case "28000":
      return { status: 401, code: "unauthenticated", error: "Sign in to set a position" };
    case "53400":
      return { status: 429, code: "delta_daily_cap", error: message };
    case "22023":
      return { status: 400, code: "invalid_input", error: message };
    case "42501":
      return { status: 400, code: "attribution_forbidden", error: message };
    default:
      return { status: 400, code: "position_error", error: message || "Failed to set position" };
  }
}

type SetPayload = {
  entity_type?: unknown;
  entity_id?: unknown;
  stance?: unknown;
  conditions_md?: unknown;
  attributed_comment_id?: unknown;
  note?: unknown;
  captchaToken?: unknown;
};

async function handleSet(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to set a position", code: "unauthenticated" }, { status: 401 });
  }

  const json = (await request.json().catch(() => null)) as SetPayload | null;
  if (!json) {
    return NextResponse.json({ error: "Invalid request body", code: "invalid_input" }, { status: 400 });
  }

  const { entity_type, entity_id, stance, conditions_md, attributed_comment_id, note, captchaToken } = json;

  if (typeof entity_type !== "string" || !isEntityCommentType(entity_type)) {
    return NextResponse.json({ error: "Invalid entity_type", code: "invalid_input" }, { status: 400 });
  }
  if (typeof entity_id !== "string" || !entity_id) {
    return NextResponse.json({ error: "entity_id is required", code: "invalid_input" }, { status: 400 });
  }
  if (typeof stance !== "number" || !Number.isInteger(stance) || stance < -3 || stance > 3) {
    return NextResponse.json({ error: "stance must be an integer between -3 and 3", code: "invalid_input" }, { status: 400 });
  }
  if (conditions_md != null && typeof conditions_md !== "string") {
    return NextResponse.json({ error: "conditions_md must be a string", code: "invalid_input" }, { status: 400 });
  }
  if (attributed_comment_id != null && typeof attributed_comment_id !== "string") {
    return NextResponse.json({ error: "attributed_comment_id must be a string", code: "invalid_input" }, { status: 400 });
  }
  if (note != null && typeof note !== "string") {
    return NextResponse.json({ error: "note must be a string", code: "invalid_input" }, { status: 400 });
  }

  // FIX-569: new-account first-writes challenge — a 403 at the access layer; the
  // per-user position cap inside set_entity_position is the primary control.
  // challengeRequiredForWrite short-circuits on account age (cheap for the common
  // established-account path).
  if (await challengeRequiredForWrite(supabase, user)) {
    const ip =
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
      request.headers.get("x-real-ip") ??
      undefined;
    const ok = await verifyTurnstile(typeof captchaToken === "string" ? captchaToken : null, ip);
    await recordAbuseEvent({
      action: "turnstile_challenge",
      headers: request.headers,
      userId: user.id,
      targetType: entity_type,
      targetId: entity_id,
      meta: { route: "positions", outcome: ok ? "pass" : "fail" },
    });
    if (!ok) {
      return NextResponse.json(
        { error: "Please complete the verification to continue.", code: "challenge_required" },
        { status: 403 },
      );
    }
  }

  // Optional RPC params are typed `string | undefined` (they carry SQL DEFAULT
  // NULL) — pass undefined to let the default apply rather than an explicit null.
  const { data, error } = await supabase.rpc("set_entity_position", {
    p_entity_type: entity_type,
    p_entity_id: entity_id,
    p_stance: stance,
    p_conditions_md: conditions_md ?? undefined,
    p_attributed_comment_id: attributed_comment_id ?? undefined,
    p_note: note ?? undefined,
  });

  if (error) {
    if ((error as { code?: string }).code === "53400") {
      await recordAbuseEvent({
        action: "cap_hit",
        headers: request.headers,
        userId: user.id,
        targetType: entity_type,
        targetId: entity_id,
        meta: { route: "positions", cap: "delta_daily_cap" },
      });
    }
    const mapped = mapRpcError((error as { code?: string }).code, error.message);
    return NextResponse.json({ error: mapped.error, code: mapped.code }, { status: mapped.status });
  }

  await recordAbuseEvent({
    action: "position_set",
    headers: request.headers,
    userId: user.id,
    targetType: entity_type,
    targetId: entity_id,
    meta: { route: "positions" },
  });

  return NextResponse.json({ position: data ?? null }, { status: 200 });
}

// PUT and POST are equivalent — upsert the caller's position on an entity.
export async function PUT(request: NextRequest) {
  try {
    return await handleSet(request);
  } catch {
    return NextResponse.json({ error: "Failed to set position", code: "position_error" }, { status: 500 });
  }
}
export async function POST(request: NextRequest) {
  return PUT(request);
}

// GET /api/positions?entity_type=&entity_id= → the caller's own position, or null.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const entityType = sp.get("entity_type");
    const entityId = sp.get("entity_id");
    if (!entityType || !isEntityCommentType(entityType)) {
      return NextResponse.json({ error: "Invalid entity_type", code: "invalid_input" }, { status: 400 });
    }
    if (!entityId) {
      return NextResponse.json({ error: "entity_id is required", code: "invalid_input" }, { status: 400 });
    }

    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      // No session → no position to return (don't 401 a read the card makes anonymously).
      return NextResponse.json({ position: null }, { status: 200 });
    }

    // Own-rows RLS scopes this to the caller automatically.
    const { data, error } = await supabase
      .from("entity_positions")
      .select("entity_type,entity_id,stance,conditions_md,constituent_jurisdiction_id,updated_at")
      .eq("entity_type", entityType)
      .eq("entity_id", entityId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: "Failed to load position", code: "position_error" }, { status: 500 });
    }
    return NextResponse.json({ position: data ?? null }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "Failed to load position", code: "position_error" }, { status: 500 });
  }
}
