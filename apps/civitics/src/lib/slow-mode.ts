// C1 Wave C (FIX-534): slow-mode flag read.
//
// Slow mode is a per-entity flag driven by comment-creation velocity, maintained
// by the entity_comments INSERT trigger (decision 5). The read is a single PK
// lookup on entity_activity_state — NEVER a request-path COUNT. "On" is derived
// (slow_mode AND slow_mode_until > now()) so expiry needs no clearing job.
//
// Used by the detail-page SSR loaders to pass `slowMode` to the client, and by
// the comments POST path to detect the off→on transition (rescore-on-trip).

import { createAdminClient } from "@civitics/db";
import type { SupabaseClient } from "@supabase/supabase-js";

type AnyClient = SupabaseClient<any, "public", any>;

export async function getSlowMode(
  entityType: string,
  entityId: string,
  client?: AnyClient,
): Promise<boolean> {
  const db = client ?? createAdminClient();
  const { data } = await db
    .from("entity_activity_state")
    .select("slow_mode,slow_mode_until")
    .eq("entity_type", entityType)
    .eq("entity_id", entityId)
    .maybeSingle();
  if (!data?.slow_mode || !data.slow_mode_until) return false;
  return new Date(data.slow_mode_until as string).getTime() > Date.now();
}
