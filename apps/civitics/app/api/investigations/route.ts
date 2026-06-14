import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { challengeRequiredForWrite, verifyTurnstile } from "@/lib/turnstile";
import { mapRpcError } from "./_lib";

export const dynamic = "force-dynamic";

// ─── GET /api/investigations?status=&scope_type=&scope_id=&limit=&offset= ──────
// Public list (anon-allowed). Featured first, newest next. RLS hides archived
// investigations from everyone but their creator.
export async function GET(request: NextRequest) {
  try {
    const sp = request.nextUrl.searchParams;
    const status = sp.get("status");
    const scopeType = sp.get("scope_type");
    const scopeId = sp.get("scope_id");
    const limit = Math.min(100, Math.max(1, parseInt(sp.get("limit") ?? "", 10) || 50));
    const offset = Math.max(0, parseInt(sp.get("offset") ?? "", 10) || 0);

    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);

    let query = supabase
      .from("investigations")
      .select(
        "id, title, question, scope_type, scope_id, scope_note, status, is_seeded, is_featured, created_by, created_at, updated_at",
      )
      .order("is_featured", { ascending: false })
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (status && ["open", "closed", "archived"].includes(status)) {
      query = query.eq("status", status);
    }
    if (scopeType) query = query.eq("scope_type", scopeType);
    if (scopeId) query = query.eq("scope_id", scopeId);

    const { data, error } = await query;
    if (error) return NextResponse.json({ error: "Failed to load investigations" }, { status: 500 });

    const rows = data ?? [];
    return NextResponse.json({
      investigations: rows,
      nextOffset: rows.length === limit ? offset + limit : null,
    });
  } catch {
    return NextResponse.json({ error: "Failed to load investigations" }, { status: 500 });
  }
}

// ─── POST /api/investigations ─────────────────────────────────────────────────
// Body: { title, question?, scope_type?, scope_id?, scope_note?, captchaToken? }
// ANY authenticated user may create; the per-user open cap + daily cap (enforced
// in create_investigation) are the spam control. New accounts also pass the
// FIX-569 first-writes Turnstile challenge.
export async function POST(request: NextRequest) {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(cookieStore);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json(
        { error: "Sign in to start an investigation", code: "not_authenticated" },
        { status: 401 },
      );
    }

    const json = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (!json) return NextResponse.json({ error: "Invalid request body" }, { status: 400 });

    const { title, question, scope_type, scope_id, scope_note, captchaToken } = json;

    if (typeof title !== "string" || title.trim().length < 3) {
      return NextResponse.json({ error: "Title must be at least 3 characters" }, { status: 400 });
    }
    if (title.trim().length > 200) {
      return NextResponse.json({ error: "Title must be 200 characters or fewer" }, { status: 400 });
    }

    // FIX-569 new-account first-writes challenge (403 at the access layer; the
    // create_investigation caps are the primary control). Established accounts skip it.
    if (await challengeRequiredForWrite(supabase, user)) {
      const ip =
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
        request.headers.get("x-real-ip") ??
        undefined;
      const ok = await verifyTurnstile(typeof captchaToken === "string" ? captchaToken : null, ip);
      if (!ok) {
        return NextResponse.json(
          { error: "Please complete the verification to continue.", code: "challenge_required" },
          { status: 403 },
        );
      }
    }

    const { data, error } = await supabase.rpc("create_investigation", {
      p_title: title.trim(),
      p_question: typeof question === "string" && question.trim() ? question.trim() : undefined,
      p_scope_type: typeof scope_type === "string" && scope_type.trim() ? scope_type.trim() : undefined,
      p_scope_id: typeof scope_id === "string" && scope_id ? scope_id : undefined,
      p_scope_note: typeof scope_note === "string" && scope_note.trim() ? scope_note.trim() : undefined,
    });
    if (error) return mapRpcError(error);

    return NextResponse.json(
      { ok: true, id: (data as { id?: string } | null)?.id ?? null },
      { status: 201 },
    );
  } catch {
    return NextResponse.json({ error: "Failed to create investigation" }, { status: 500 });
  }
}
