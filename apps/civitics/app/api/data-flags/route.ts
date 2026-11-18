import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient, ATTRIBUTION_ENTITY_TABLE } from "@civitics/db";
import { recordAbuseEvent } from "@/lib/abuse-events";
import { submitDataFlag } from "@/lib/data-flags";

export const dynamic = "force-dynamic";

// POST /api/data-flags  (FIX-401)
// Body: { entity_type, entity_id, reason, comment?, source? }
//
// A reader's flag on a data row. 401 without a user; 400 on a bad body; 404 when
// the entity is not in its table; idempotent per (entity, flagger, reason); 429
// past 20 flags in a rolling 24 hours — the table's trigger enforces that, so it
// also holds on the insert-own policy's direct path. The decision lives in
// src/lib/data-flags.ts (tested there); this binds it to the admin client, as
// /api/moderation/flag writes content_flags.
export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Sign in to flag" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  const outcome = await submitDataFlag(body, user.id, {
    entityExists: async (type, id) => {
      const { data, error } = await admin
        .from(ATTRIBUTION_ENTITY_TABLE[type])
        .select("id")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data !== null;
    },
    alreadyFlagged: async (flag, userId) => {
      const { data, error } = await admin
        .from("data_flags")
        .select("id")
        .eq("entity_type", flag.entity_type)
        .eq("entity_id", flag.entity_id)
        .eq("flagger_user_id", userId)
        .eq("reason", flag.reason)
        .maybeSingle();
      if (error) throw error;
      return data !== null;
    },
    insert: async (flag, userId) => {
      const { data, error } = await admin
        .from("data_flags")
        .insert({
          entity_type:     flag.entity_type,
          entity_id:       flag.entity_id,
          reason:          flag.reason,
          comment:         flag.comment,
          source:          flag.source,
          flagger_user_id: userId,
        })
        .select("id")
        .single();
      if (error) return { errorCode: String(error.code ?? "unknown") };
      return { id: data.id as string };
    },
  });

  if (outcome.status === 200 && outcome.created) {
    const { id, flag } = outcome.created;
    await recordAbuseEvent({
      action: "flag_create",
      headers: request.headers,
      userId: user.id,
      targetType: "data_flag",
      targetId: id,
      meta: {
        route: "data_flags",
        entity_type: flag.entity_type,
        entity_id: flag.entity_id,
        reason: flag.reason,
      },
    });
  } else if (outcome.status === 429) {
    await recordAbuseEvent({
      action: "cap_hit",
      headers: request.headers,
      userId: user.id,
      targetType: outcome.capHit.entity_type,
      targetId: outcome.capHit.entity_id,
      meta: { route: "data_flags", cap: "data_flag_daily" },
    });
  }

  return NextResponse.json(outcome.body, { status: outcome.status });
}
