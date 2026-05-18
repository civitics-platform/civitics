/**
 * FIX-295: flip pipeline_state.platform_plan.supabase to "pro" so the
 * dashboard's Platform Costs section computes Supabase overage against the
 * Pro tier's 8 GB / $0.125/GB DB-size pricing instead of the Free tier's
 * 500 MB hard limit.
 *
 * Idempotent. Reads the current platform_plan JSONB first; if supabase is
 * already "pro" the script no-ops and prints the existing override map.
 * Otherwise it merges {"supabase":"pro"} into whatever is there (preserving
 * other service overrides) and upserts the row. Safe to re-run.
 *
 *   pnpm --filter @civitics/data data:flip-supabase-pro
 *   pnpm --filter @civitics/data data:flip-supabase-pro:ci    # --allow-prod for GHA
 *
 * Targets whichever DB the active .env.local points at. CLAUDE.md requires
 * confirming the active env before invocation against prod — this script
 * does NOT prompt; that's the operator's job.
 */

import { createAdminClient } from "@civitics/db";

async function main(): Promise<void> {
  const url = process.env["NEXT_PUBLIC_SUPABASE_URL"] ?? "<unknown>";
  console.log(`[flip-supabase-pro] target: ${url}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;

  const { data: existing, error: readErr } = await db
    .from("pipeline_state")
    .select("value")
    .eq("key", "platform_plan")
    .maybeSingle();

  if (readErr) {
    console.error("[flip-supabase-pro] read error:", readErr.message ?? readErr);
    process.exit(1);
  }

  const current = (existing?.value as Record<string, string> | null) ?? {};
  console.log("[flip-supabase-pro] current platform_plan:", JSON.stringify(current));

  if (current["supabase"] === "pro") {
    console.log("[flip-supabase-pro] already on pro — no-op");
    return;
  }

  const updated = { ...current, supabase: "pro" };

  const { error: writeErr } = await db
    .from("pipeline_state")
    .upsert({ key: "platform_plan", value: updated }, { onConflict: "key" });

  if (writeErr) {
    console.error("[flip-supabase-pro] upsert error:", writeErr.message ?? writeErr);
    process.exit(1);
  }

  console.log("[flip-supabase-pro] updated platform_plan:", JSON.stringify(updated));
}

main().catch((err) => {
  console.error("[flip-supabase-pro] fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
