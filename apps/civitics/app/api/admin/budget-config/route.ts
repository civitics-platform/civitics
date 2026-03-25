export const dynamic = "force-dynamic";

/**
 * POST /api/admin/budget-config
 *
 * Saves budget threshold overrides to pipeline_state key 'cost_config_overrides'.
 * These are merged with hardcoded defaults in getEffectiveConfig() at runtime.
 *
 * Admin-only — requires authenticated user email to match ADMIN_EMAIL env var.
 *
 * Body: Partial<CostConfig> — any top-level or nested field to override.
 */

import { createServerClient, createAdminClient } from "@civitics/db";
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

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

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adminDb = createAdminClient() as any;

  // Fetch existing overrides to merge
  const { data: existing } = await adminDb
    .from("pipeline_state")
    .select("value")
    .eq("key", "cost_config_overrides")
    .single();

  const current = (existing?.value ?? {}) as Record<string, unknown>;

  // Handle dotted keys like "autonomous.max_auto_approve_usd"
  const merged = { ...current };
  for (const [dotKey, value] of Object.entries(body)) {
    const parts = dotKey.split(".");
    if (parts.length === 1) {
      merged[dotKey] = value;
    } else if (parts.length === 2) {
      const [section, subkey] = parts as [string, string];
      merged[section] = {
        ...((merged[section] as Record<string, unknown>) ?? {}),
        [subkey]: value,
      };
    }
  }

  await adminDb.from("pipeline_state").upsert(
    {
      key:        "cost_config_overrides",
      value:      merged,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );

  return NextResponse.json({ ok: true, saved: body });
}
