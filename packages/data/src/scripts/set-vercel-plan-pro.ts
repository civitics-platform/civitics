/**
 * FIX-δ — set pipeline_state.platform_plan.vercel = "pro".
 *
 * The Vercel account is on the Pro plan, but platform_plan only carried
 * {"supabase":"pro"}, so the Platform Costs card rendered Vercel metrics
 * against FREE limits (e.g. origin_transfer_bytes vs. 10 GB instead of 1 TB).
 * This sets the vercel override, MERGING into the existing object so the
 * supabase (and any future) plan is preserved — upgradeServicePlan does the
 * spread-merge.
 *
 * Runtime data action — must run against local AND prod separately
 * (pipeline_state is not propagated by schema migrations).
 *
 * Run local:
 *   pnpm --filter @civitics/data data:set-vercel-plan-pro
 * Run prod (requires the explicit allow flag):
 *   pnpm --filter @civitics/data data:set-vercel-plan-pro:prod
 *
 * Idempotent: re-running with vercel already "pro" is a no-op write.
 */

import { createAdminClient, upgradeServicePlan } from "@civitics/db";

async function main(): Promise<void> {
  const db = createAdminClient();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  const { data: before } = await anyDb
    .from("pipeline_state")
    .select("value")
    .eq("key", "platform_plan")
    .maybeSingle();
  console.log("[set-vercel-plan-pro] before:", JSON.stringify(before?.value ?? null));

  await upgradeServicePlan(db, "vercel", "pro");

  const { data: after } = await anyDb
    .from("pipeline_state")
    .select("value")
    .eq("key", "platform_plan")
    .maybeSingle();
  console.log("[set-vercel-plan-pro] after: ", JSON.stringify(after?.value ?? null));

  const ok = (after?.value as Record<string, string> | null)?.["vercel"] === "pro";
  if (!ok) {
    console.error("[set-vercel-plan-pro] FAILED — vercel is not 'pro' after write");
    process.exit(1);
  }
  console.log("[set-vercel-plan-pro] OK — vercel = pro");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
