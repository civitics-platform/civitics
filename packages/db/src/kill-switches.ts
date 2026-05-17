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
};

export type KillSwitchesMap = Record<KillSwitchName, KillSwitchState>;

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

export async function setKillSwitch(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: SupabaseClient<any>,
  name: KillSwitchName,
  enabled: boolean,
): Promise<void> {
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

  await anyDb.from("pipeline_state").upsert(
    {
      key: "kill_switches",
      value: next,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" },
  );

  clearKillSwitchCache();
}
