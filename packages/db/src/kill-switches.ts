/**
 * DB-backed runtime kill switches with layered env override.
 *
 * Layering (priority order, first match wins):
 *
 *   1. process.env.<X> === "false"  → hard kill, ignore DB. Panic button
 *      that always works even if the DB read fails or the row is missing.
 *      (Inverted for cron: CRON_DISABLED="true" === cron off.)
 *   2. DB switch                     → pipeline_state.kill_switches[name].enabled
 *   3. Default                       → on (true)
 *
 * A DB read miss falls through to "on" rather than blocking — the env var
 * is the safety net. This is intentional: we'd rather over-serve briefly
 * during a transient DB blip than over-block.
 *
 * 30s module cache bounds the staleness window for DB switch flips. The
 * admin POST route calls clearKillSwitchCache() so manual flips take
 * effect immediately on the process that handled the POST; other Vercel
 * function instances pick it up on the next 30s tick.
 *
 * Auto-trip is one-way: PR 3's evaluator (auto-trip-evaluator.ts) flips
 * switches OFF when a tracked metric crosses auto_trip_threshold_pct; it
 * never flips them back on. Re-enable is a manual decision via the admin
 * POST, which re-uses this module's setKillSwitch helper.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

// ── Public types ──────────────────────────────────────────────────────────────

export type KillSwitchName =
  | "ai_summaries"
  | "ai_narrative"
  | "ai_tagger"
  | "connection_graph_live"
  | "cron";

export type KillSwitchState = {
  enabled: boolean;
  auto_trip_threshold_pct: number | null;
  // PR 3 (FIX-286): which platform_usage rows can trigger an auto-trip for
  // this switch. Format: `service.metric` (e.g. "anthropic.monthly_spend_usd").
  // Empty array → switch cannot auto-trip even if a threshold is set.
  metrics?: string[];
};

export type KillSwitchesMap = Record<KillSwitchName, KillSwitchState>;

// PR 3 (FIX-287): metadata for a single switch flip, persisted to
// kill_switch_events. Both auto and manual flips share this shape.
export type KillSwitchEventInput = {
  source: "auto" | "manual";
  trigger_metric: string | null;     // null for manual flips
  trigger_value: number | null;
  threshold_pct: number | null;
};

// ── Env-var mapping ───────────────────────────────────────────────────────────
//
// PR 1 keeps the existing env-var names; the AI trio share a single
// AI_SUMMARIES_ENABLED flag because that's the only AI kill the codebase
// has today. CRON_DISABLED is inverted ("true" = off) to match the
// existing /api/cron/nightly-sync code path.

type EnvRule =
  | { envVar: string; off: "false" }
  | { envVar: string; off: "true" };

const ENV_RULES: Record<KillSwitchName, EnvRule> = {
  ai_summaries:          { envVar: "AI_SUMMARIES_ENABLED",       off: "false" },
  ai_narrative:          { envVar: "AI_SUMMARIES_ENABLED",       off: "false" },
  ai_tagger:             { envVar: "AI_SUMMARIES_ENABLED",       off: "false" },
  connection_graph_live: { envVar: "CONNECTIONS_PIPELINE_ENABLED", off: "false" },
  cron:                  { envVar: "CRON_DISABLED",              off: "true"  },
};

function envKillSwitchIsOff(name: KillSwitchName): boolean {
  const rule = ENV_RULES[name];
  return process.env[rule.envVar] === rule.off;
}

// ── 30s module cache ──────────────────────────────────────────────────────────

const CACHE_TTL_MS = 30_000;

let cachedMap: KillSwitchesMap | null = null;
let cacheExpiresAt = 0;

export function clearKillSwitchCache(): void {
  cachedMap = null;
  cacheExpiresAt = 0;
}

async function loadMap(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
): Promise<KillSwitchesMap | null> {
  if (cachedMap && Date.now() < cacheExpiresAt) return cachedMap;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  try {
    const { data, error } = await anyDb
      .from("pipeline_state")
      .select("value")
      .eq("key", "kill_switches")
      .maybeSingle();
    if (error || !data) return null;
    const value = data.value as Partial<KillSwitchesMap> | null;
    if (!value) return null;
    cachedMap = value as KillSwitchesMap;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return cachedMap;
  } catch {
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function isKillSwitchEnabled(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  name: KillSwitchName,
): Promise<boolean> {
  // Layer 1: env hard kill
  if (envKillSwitchIsOff(name)) return false;

  // Layer 2: DB switch
  const map = await loadMap(db);
  if (map && map[name] && map[name].enabled === false) return false;

  // Layer 3: default on. A missing row, missing key, or DB error all
  // fall through here — the env var is the panic button.
  return true;
}

/**
 * Shared internal flip: updates pipeline_state.kill_switches and inserts a
 * kill_switch_events row in the same call. Used by:
 *   - setKillSwitch (manual flips from admin POST)
 *   - evaluateAutoTrips (auto flips from the snapshot cron)
 *
 * Returns the inserted event id so callers can echo it back in API responses
 * (the admin POST returns event_id; the evaluator includes it in its
 * decision list for cron observability).
 *
 * pipeline_state and kill_switch_events are not transactionally tied — if the
 * event insert fails the switch flip still stands. That's the right tradeoff:
 * the switch flip is the safety action; the event row is audit. Logged event
 * with no flip would be misleading; flip with no event is recoverable.
 */
export async function flipSwitch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  name: KillSwitchName,
  enabled: boolean,
  event: KillSwitchEventInput,
): Promise<{ event_id: number | null; flipped_at: string }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;

  const { data: existing } = await anyDb
    .from("pipeline_state")
    .select("value")
    .eq("key", "kill_switches")
    .maybeSingle();

  const current = (existing?.value as Partial<KillSwitchesMap> | null) ?? {};
  const prev: KillSwitchState = current[name] ?? {
    enabled: true,
    auto_trip_threshold_pct: null,
  };
  const next: KillSwitchesMap = {
    ...(current as KillSwitchesMap),
    [name]: { ...prev, enabled },
  };

  const flipped_at = new Date().toISOString();

  await anyDb.from("pipeline_state").upsert(
    {
      key: "kill_switches",
      value: next,
      updated_at: flipped_at,
    },
    { onConflict: "key" },
  );

  clearKillSwitchCache();

  let event_id: number | null = null;
  try {
    const { data: inserted } = await anyDb
      .from("kill_switch_events")
      .insert({
        switch_name: name,
        trigger_metric: event.trigger_metric,
        trigger_value: event.trigger_value,
        threshold_pct: event.threshold_pct,
        flipped_to: enabled,
        source: event.source,
        flipped_at,
      })
      .select("id")
      .maybeSingle();
    event_id = (inserted?.id as number | undefined) ?? null;
  } catch {
    // Audit-row failure shouldn't surface as an API error — see comment above.
    event_id = null;
  }

  return { event_id, flipped_at };
}

/**
 * Manual flip from admin UI / API. Wraps flipSwitch with source='manual' and
 * no trigger metadata (the operator's intent is the trigger).
 */
export async function setKillSwitch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  name: KillSwitchName,
  enabled: boolean,
): Promise<{ event_id: number | null; flipped_at: string }> {
  return flipSwitch(db, name, enabled, {
    source: "manual",
    trigger_metric: null,
    trigger_value: null,
    threshold_pct: null,
  });
}
