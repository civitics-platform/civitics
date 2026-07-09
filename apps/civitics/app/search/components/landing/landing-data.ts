/**
 * FIX-767 — the browse-landing data reader. Zero-query /search renders from
 * THIS instead of the W1 48-row scoped-browse SSR (which serialized ~140KB of
 * rows + full facet counts). Everything here is cheap and pre-aggregated:
 *
 *   1. one browse_facet_counts read → per-kind totals (tile counts) + a few
 *      sub-facet counts (tile sub-links) + refreshed_at (the honesty kicker),
 *   2. three capped top-N strips reusing existing materialized surfaces —
 *      COMMENT PERIODS CLOSING (the homepage open_comment read), RECENTLY
 *      ACTIVE (entity_search_index.activity_at), MOST CONNECTED
 *      (entity_search_index.connection_count).
 *
 * NO get_browse_page fan-out, NO get_connection_counts, NO exact request-path
 * COUNT — counts come straight from the FIX-748 rollup. Wrapped in
 * unstable_cache (revalidate 60): createAdminClient forces the /search route
 * dynamic, so the data cache is what stops crawler traffic from turning into
 * per-request DB work (the FIX-683 cost concern).
 */

import { unstable_cache } from "next/cache";
import { createAdminClient } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";

const STRIP_LIMIT = 6;
const READ_TIMEOUT_MS = 3000;

/** Sub-facet keys pulled for tile sub-links (kept tiny — a few dozen rows). */
const SUBLINK_FACET_KEYS = [
  "__total__", "chamber", "financial_type", "agency_type", "proposal_type", "initiative_stage", "status",
];

export interface LandingStripRow {
  key: string;
  label: string;
  /** Right-aligned value ("3d left", "vote · 2h", "1.2k links"). */
  meta: string;
  /** Whether the value should render as urgent (amber). */
  urgent: boolean;
  href: string;
}

export interface LandingData {
  /** ISO timestamp the index/rollup was last rebuilt — drives the LIVE INDEX kicker. */
  refreshedAt: string | null;
  /** Sum of every kind's total — the "N records" in the kicker. */
  totalCount: number;
  /** kind → total row count (tile headline number). */
  kindCounts: Record<string, number>;
  /** "kind:facet_key:facet_value" → count (tile sub-link badges). */
  subCounts: Record<string, number>;
  closing: LandingStripRow[];
  recent: LandingStripRow[];
  connected: LandingStripRow[];
}

/** Detail-page href per kind. uuid-param routes link direct; the rest fall back to the explorer. */
function entityHref(kind: string, id: string, name: string): string {
  switch (kind) {
    case "official": return `/officials/${id}`;
    case "proposal": return `/proposals/${id}`;
    case "initiative": return `/initiatives/${id}`;
    case "financial": return `/donors/${id}`;
    case "jurisdiction": return `/jurisdictions/${id}`;
    case "institution": return `/institutions/${id}`;
    case "meeting": return `/meetings/${id}`;
    // agency detail is /agencies/[slug] (no uuid route) — send to the explorer.
    default: return `/search?q=${encodeURIComponent(name)}`;
  }
}

const KIND_LABEL: Record<string, string> = {
  official: "official", proposal: "proposal", initiative: "initiative", agency: "agency",
  financial: "donor", jurisdiction: "place", institution: "institution", meeting: "meeting",
};

/** Coarse relative-time label from an ISO timestamp (server-render only, deterministic). */
function relTime(iso: string | null, nowMs: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.round((nowMs - then) / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs / 24);
  if (days < 14) return `${days}d`;
  return `${Math.round(days / 7)}w`;
}

/** Whole days until an ISO timestamp (negative = past). */
function daysUntil(iso: string | undefined, nowMs: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - nowMs) / 86400000);
}

function compactCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

async function readLanding(): Promise<LandingData> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = createAdminClient() as any;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const kindCounts: Record<string, number> = {};
  const subCounts: Record<string, number> = {};
  let refreshedAt: string | null = null;
  let totalCount = 0;

  // All four reads are independent — fire them concurrently so a cold cache
  // costs one ~READ_TIMEOUT window, not four. Each is withDbTimeout-capped, so
  // a degraded DB degrades the landing to zeros + empty strips (which still
  // render) rather than hanging the render.
  //
  // withDbTimeout over an `any` builder infers T=unknown
  // (project_withdbtimeout_any_infers_unknown) — cast the result array locally
  // rather than adding a type arg the render-timeout CI guard would miss.
  const [{ data: rollup }, { data: closingRows }, { data: recentRows }, { data: connectedRows }] =
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (await Promise.all([
      // 1) Rollup — totals + sub-link counts + the freshest refreshed_at.
      withDbTimeout(
        db.from("browse_facet_counts")
          .select("kind, facet_key, facet_value, count, refreshed_at")
          .in("facet_key", SUBLINK_FACET_KEYS),
        READ_TIMEOUT_MS,
        "landing:rollup",
      ),
      // 2) COMMENT PERIODS CLOSING — the homepage open_comment read (reused shape).
      withDbTimeout(
        db.from("proposals")
          .select("id, title, metadata")
          .eq("status", "open_comment")
          .gt("metadata->>comment_period_end", nowIso)
          .order("metadata->>comment_period_end", { ascending: true })
          .limit(STRIP_LIMIT),
        READ_TIMEOUT_MS,
        "landing:closing",
      ),
      // 3) RECENTLY ACTIVE — top-N by activity_at (real records only; synthetic
      //    Franklin seed is excluded from the highlight strips).
      withDbTimeout(
        db.from("entity_search_index")
          .select("kind, entity_id, display_name, activity_at")
          .eq("is_synthetic", false)
          .not("activity_at", "is", null)
          .order("activity_at", { ascending: false })
          .limit(STRIP_LIMIT),
        READ_TIMEOUT_MS,
        "landing:recent",
      ),
      // 4) MOST CONNECTED — top-N by connection_count.
      withDbTimeout(
        db.from("entity_search_index")
          .select("kind, entity_id, display_name, connection_count")
          .eq("is_synthetic", false)
          .order("connection_count", { ascending: false })
          .limit(STRIP_LIMIT),
        READ_TIMEOUT_MS,
        "landing:connected",
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ])) as [{ data: any }, { data: any }, { data: any }, { data: any }];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (rollup ?? []) as any[]) {
    const count = Number(r.count) || 0;
    if (r.refreshed_at && (!refreshedAt || r.refreshed_at > refreshedAt)) refreshedAt = r.refreshed_at;
    if (r.facet_key === "__total__") {
      kindCounts[r.kind] = count;
      totalCount += count;
    } else {
      subCounts[`${r.kind}:${r.facet_key}:${r.facet_value}`] = count;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const closing: LandingStripRow[] = ((closingRows ?? []) as any[]).map((r) => {
    const d = daysUntil(r.metadata?.comment_period_end, nowMs);
    return {
      key: `closing:${r.id}`,
      label: r.title,
      meta: d == null ? "open" : d <= 0 ? "closing" : `${d}d left`,
      urgent: d != null && d <= 7,
      href: `/proposals/${r.id}`,
    };
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recent: LandingStripRow[] = ((recentRows ?? []) as any[]).map((r) => ({
    key: `recent:${r.entity_id}`,
    label: r.display_name,
    meta: `${KIND_LABEL[r.kind] ?? r.kind} · ${relTime(r.activity_at, nowMs)}`,
    urgent: false,
    href: entityHref(r.kind, r.entity_id, r.display_name),
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const connected: LandingStripRow[] = ((connectedRows ?? []) as any[]).map((r) => ({
    key: `connected:${r.entity_id}`,
    label: r.display_name,
    meta: `${compactCount(r.connection_count ?? 0)} links`,
    urgent: false,
    href: entityHref(r.kind, r.entity_id, r.display_name),
  }));

  return { refreshedAt, totalCount, kindCounts, subCounts, closing, recent, connected };
}

/**
 * Cached landing read (60s). The data cache — not CDN HTML caching — is the
 * cost guard here: the /search route is dynamic (createAdminClient +
 * searchParams), so without this every crawler hit would re-run the four reads.
 */
export const getLandingData = unstable_cache(readLanding, ["browse-landing-v1"], {
  revalidate: 60,
  tags: ["browse-landing"],
});
