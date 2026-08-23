export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/platform-limits  — current rows (admin only)
 * POST /api/admin/platform-limits  — retune included_limit / warning_pct / critical_pct
 *
 * FIX-1051. Every threshold on this platform has been changed by writing a
 * migration — FIX-1044 derived the 3,000/hr origin-request limit, FIX-1046 set
 * the $20 credit, FIX-1050 moved R2 to 24 GiB — and each one needed a deploy to
 * land a number that is, by design, meant to be retuned as the platform grows.
 *
 * FIX-1051 gated this on two things, both of which now exist: the card rework
 * (FIX-1091) that the editor lives inside, and a real authenticated-admin
 * boundary for the WRITE. `platform_limits` stays PUBLIC-READ — the whole cost
 * card is public by design — so only the write path is gated here, using the
 * same cookie-session + ADMIN_EMAIL check as /api/admin/budget-config and the
 * `useIsAdmin()` hook that decides whether to render the affordance at all.
 * Deliberately NOT the `x-admin-key` header the legacy POST /api/platform/usage
 * uses: that key lives in localStorage, which is not an authenticated boundary.
 *
 * ── THE PAIR GUARD ───────────────────────────────────────────────────────────
 *
 * FIX-1051 names one specific hazard: `vercel.billable_overage_usd` and
 * `vercel.overage_present` encode ONE behaviour across TWO rows (the second
 * exists only so "$0.01 of a $20 credit" can round to a non-zero INTEGER
 * percentage band and fire the first-cent email), so an editor that lets them
 * drift silently breaks the first-cent guarantee. The guard is structural
 * rather than a special case: rows flagged `is_displayed = false` are
 * wire-format companions, they are not rendered, and they are NOT EDITABLE
 * here. `overage_present` is the only such row today, and any future companion
 * inherits the protection without a code change.
 */

import { createServerClient, createAdminClient } from "@civitics/db";
import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

type LimitUpdate = {
  id: string;
  included_limit?: number;
  warning_pct?: number;
  critical_pct?: number;
};

type LimitRow = {
  id: string;
  service: string;
  metric: string;
  included_limit: number;
  warning_pct: number;
  critical_pct: number;
  is_displayed: boolean | null;
};

const EDITABLE_COLUMNS = ["included_limit", "warning_pct", "critical_pct"] as const;

/** Sanity ceiling. db_size_bytes legitimately runs bands at 500/750 (FIX-1089). */
const MAX_PCT = 100_000;

async function requireAdmin(): Promise<NextResponse | null> {
  const adminEmail = process.env["ADMIN_EMAIL"];
  if (!adminEmail) {
    return NextResponse.json({ error: "ADMIN_EMAIL not configured" }, { status: 503 });
  }
  const supabase = createServerClient(cookies());
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user || user.email !== adminEmail) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  return null;
}

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  if (supabaseUnavailable()) return unavailableResponse();
  const denied = await requireAdmin();
  if (denied) return denied;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const { data, error } = await db
    .from("platform_limits")
    .select("id, service, metric, plan, included_limit, warning_pct, critical_pct, unit, display_label, is_displayed, is_active, notes")
    .eq("is_active", true)
    .order("service")
    .order("sort_order");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ rows: data ?? [] });
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (supabaseUnavailable()) return unavailableResponse();
  const denied = await requireAdmin();
  if (denied) return denied;

  let body: { updates?: unknown };
  try {
    body = (await request.json()) as { updates?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updates = body.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return NextResponse.json({ error: "updates[] required" }, { status: 400 });
  }
  if (updates.length > 50) {
    return NextResponse.json({ error: "at most 50 updates per request" }, { status: 400 });
  }

  const parsed: LimitUpdate[] = [];
  for (const raw of updates) {
    if (typeof raw !== "object" || raw === null) {
      return NextResponse.json({ error: "each update must be an object" }, { status: 400 });
    }
    const u = raw as Record<string, unknown>;
    const id = u["id"];
    if (typeof id !== "string" || id.length === 0) {
      return NextResponse.json({ error: "each update needs an id" }, { status: 400 });
    }
    const next: LimitUpdate = { id };
    for (const col of EDITABLE_COLUMNS) {
      const v = u[col];
      if (v === undefined) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) {
        return NextResponse.json({ error: `${col} must be a finite number` }, { status: 400 });
      }
      next[col] = v;
    }
    if (Object.keys(next).length === 1) {
      return NextResponse.json({ error: `update for ${id} changes nothing` }, { status: 400 });
    }
    parsed.push(next);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const ids = parsed.map((u) => u.id);
  const { data: existing, error: readErr } = await db
    .from("platform_limits")
    .select("id, service, metric, included_limit, warning_pct, critical_pct, is_displayed")
    .in("id", ids);

  if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

  const byId = new Map<string, LimitRow>();
  for (const row of (existing ?? []) as LimitRow[]) byId.set(row.id, row);

  // Validate everything BEFORE writing anything: a half-applied threshold set is
  // worse than a rejected one, because the pair it belongs to may be the half
  // that did not land.
  const resolved: Array<{ update: LimitUpdate; row: LimitRow; merged: LimitRow }> = [];
  for (const update of parsed) {
    const row = byId.get(update.id);
    if (!row) {
      return NextResponse.json({ error: `unknown platform_limits id ${update.id}` }, { status: 404 });
    }
    if (row.is_displayed === false) {
      return NextResponse.json(
        {
          error:
            `${row.service}.${row.metric} is a wire-format companion row (is_displayed = false) ` +
            "and is not editable here. It encodes an alert's shape, not a readable quantity — " +
            "see FIX-1050/FIX-1051 on the first-cent pair.",
        },
        { status: 400 },
      );
    }

    const merged: LimitRow = {
      ...row,
      included_limit: update.included_limit ?? row.included_limit,
      warning_pct: update.warning_pct ?? row.warning_pct,
      critical_pct: update.critical_pct ?? row.critical_pct,
    };

    if (!(merged.included_limit > 0) && merged.included_limit !== -1) {
      return NextResponse.json(
        { error: `${row.service}.${row.metric}: included_limit must be > 0, or -1 for unlimited` },
        { status: 400 },
      );
    }
    if (merged.warning_pct < 0 || merged.critical_pct < 0) {
      return NextResponse.json(
        { error: `${row.service}.${row.metric}: band percentages cannot be negative` },
        { status: 400 },
      );
    }
    if (merged.warning_pct > MAX_PCT || merged.critical_pct > MAX_PCT) {
      return NextResponse.json(
        { error: `${row.service}.${row.metric}: band percentages above ${MAX_PCT} are not plausible` },
        { status: 400 },
      );
    }
    if (merged.warning_pct > merged.critical_pct) {
      // computeMetricStatus checks critical FIRST, so an inverted ladder makes
      // the warning band unreachable — the row would jump healthy → critical.
      return NextResponse.json(
        {
          error:
            `${row.service}.${row.metric}: warning_pct (${merged.warning_pct}) must be ` +
            `at or below critical_pct (${merged.critical_pct}) — the ladder checks critical first, ` +
            "so an inverted pair silently deletes the warning band.",
        },
        { status: 400 },
      );
    }

    resolved.push({ update, row, merged });
  }

  const applied: Array<Record<string, unknown>> = [];
  for (const { update, row, merged } of resolved) {
    const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
    for (const col of EDITABLE_COLUMNS) {
      if (update[col] !== undefined) patch[col] = update[col];
    }
    const { error } = await db.from("platform_limits").update(patch).eq("id", update.id);
    if (error) {
      return NextResponse.json(
        { error: `${row.service}.${row.metric}: ${error.message}`, applied },
        { status: 500 },
      );
    }
    applied.push({
      id: update.id,
      service: row.service,
      metric: row.metric,
      before: {
        included_limit: row.included_limit,
        warning_pct: row.warning_pct,
        critical_pct: row.critical_pct,
      },
      after: {
        included_limit: merged.included_limit,
        warning_pct: merged.warning_pct,
        critical_pct: merged.critical_pct,
      },
    });
  }

  return NextResponse.json({
    ok: true,
    applied,
    // The card renders a PERSISTED snapshot, so a saved threshold is not visible
    // until the next platform-snapshot tick rewrites the payload. Saying so is
    // cheaper than someone re-saving because "it didn't work".
    note: "Takes effect on the next platform-snapshot tick (10 min nominal; GHA cron drift can extend it).",
  });
}
