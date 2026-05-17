/**
 * GitHub Actions usage metrics — for the Platform Costs card.
 *
 * The civitics repo at github.com/civitics-platform/civitics is owned by a
 * USER account (not an org — the design decision in the FIX-285 prompt was
 * based on an incorrect premise). The org-level endpoints
 * `/orgs/{org}/settings/billing/*` 404 because there is no such org. We use
 * the user-level equivalent instead. If the repo is ever transferred to a
 * real GitHub Organization, swap `ACCOUNT_PATH` to `orgs/<slug>` — the
 * endpoint shape is identical.
 *
 * The legacy `/settings/billing/actions` + `/settings/billing/shared-storage`
 * endpoints returned HTTP 410 ("This endpoint has been moved") as of May
 * 2026 — GitHub sunset them in favor of "Enhanced billing platform" at:
 *
 *   GET /users/{user}/settings/billing/usage[?year=YYYY&month=MM&day=DD]
 *     usageItems: Array<{
 *       date:           "2026-05-17T04:44:48Z",
 *       product:        "actions" | "shared_storage" | "packages" | ...,
 *       sku:            "Actions Linux" | "Actions macOS" | "Actions Windows" | ...,
 *       quantity:       <number>,
 *       unitType:       "Minutes" | "GigabyteHours" | "Gigabytes" | ...,
 *       pricePerUnit:   <USD>,
 *       grossAmount:    <USD>,
 *       discountAmount: <USD>,           // free-tier discount applied
 *       netAmount:      <USD>,           // what was actually billed
 *       repositoryName: "civitics" | ...,
 *     }>
 *
 * We scope to the current calendar month (current billing cycle for personal
 * accounts) and aggregate:
 *   action_minutes    = sum(quantity) where unitType='Minutes'
 *   minutes_breakdown = { sku → sum }  where unitType='Minutes'
 *                       (per-OS rollup — only "Actions Linux" populated today;
 *                        the key includes the "Actions " prefix so the
 *                        dashboard renders the raw SKU label verbatim)
 *   storage_bytes     = sum across storage products, unit-aware (see below)
 *   total_billed_usd  = sum(netAmount) — actual billed dollars this cycle
 *   total_gross_usd   = sum(grossAmount) — what it would cost without free tier
 *
 * Storage unit conversion: civitics-platform currently uses zero billable
 * storage so the actual production unitType is empirical. Storage line items
 * carry `unitType='GigabyteHours'` per GitHub docs — meaning "X GB stored
 * for 1 hour" accumulated over the period. We convert to bytes using:
 *
 *   bytes = (gigabyte_hours / hours_elapsed_this_month) * 1024³
 *
 * This gives an *average bytes stored over the period so far*, which is the
 * closest single-number analog to "current storage" the enhanced billing API
 * offers. Plain `Gigabytes` line items (if any) are treated as a snapshot
 * and converted directly. Unknown storage unitTypes are skipped with a
 * comment-noted no-op.
 *
 * Token: GITHUB_BILLING_TOKEN. The enhanced billing endpoint requires:
 *   - Classic PAT: `user` scope
 *   - Fine-grained PAT (owned by civitics-platform): account permission
 *     "Plan" set to Read-only
 * Existing GITHUB_TOKEN has only `read:org, repo` and returns 403 on this
 * endpoint — confirmed. Kept separate so adding `Plan: Read` doesn't widen
 * the deploy/CI token's blast radius.
 *
 * 5-minute in-memory cache mirrors Cloudflare + Supabase helpers. Failures
 * return `{ error }` — never throws. Snapshot compute path treats missing-
 * token errors as benign (FIX-284 convention).
 */

const ACCOUNT_PATH = "users/civitics-platform";
const GITHUB_API_BASE = "https://api.github.com";
const CACHE_TTL_MS = 5 * 60 * 1000;
const GB_IN_BYTES = 1024 * 1024 * 1024;

// ── Public types ──────────────────────────────────────────────────────────────

export type GitHubUsage = {
  /** Total Actions minutes consumed this calendar month (all runner OSes). */
  action_minutes: number;
  /** Per-SKU breakdown of consumed minutes, e.g. { "Actions Linux": 593 }.
   *  Empty object if no Actions runs in the current month. */
  minutes_breakdown: Record<string, number>;
  /** Average bytes stored across the month so far (GigabyteHours / hours
   *  elapsed → average GB → bytes). 0 if no billable storage line items. */
  storage_bytes: number;
  /** Sum of netAmount across all line items — actual billed dollars after
   *  free-tier discount. 0 on public repos with no overage usage. */
  total_billed_usd: number;
  /** Sum of grossAmount — what billing would be without the free tier. Useful
   *  for "if the repo flipped private tomorrow, this is what we'd owe". */
  total_gross_usd: number;
  fetched_at: string;
};

export type GitHubUsageError = { error: string };

// ── API response shape ───────────────────────────────────────────────────────

type UsageItem = {
  date?: string;
  product?: string;
  sku?: string;
  quantity?: number;
  unitType?: string;
  pricePerUnit?: number;
  grossAmount?: number;
  discountAmount?: number;
  netAmount?: number;
  repositoryName?: string;
};

type BillingUsageResponse = {
  usageItems?: UsageItem[];
};

// ── In-memory cache ───────────────────────────────────────────────────────────

let cached: GitHubUsage | null = null;
let cacheExpiresAt = 0;

export function clearGitHubUsageCache(): void {
  cached = null;
  cacheExpiresAt = 0;
}

// ── Storage byte conversion ──────────────────────────────────────────────────

function gigabyteHoursToAverageBytes(gbh: number, now: Date): number {
  // hours elapsed from the 1st of the month to now, floored at 1 to avoid
  // div-by-zero at month rollover.
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  const hoursElapsed = Math.max(1, (now.getTime() - monthStart.getTime()) / 3_600_000);
  return Math.round((gbh / hoursElapsed) * GB_IN_BYTES);
}

function storageItemToBytes(item: UsageItem, now: Date): number {
  const q = item.quantity ?? 0;
  switch (item.unitType) {
    case "GigabyteHours":
      return gigabyteHoursToAverageBytes(q, now);
    case "Gigabytes":
      return Math.round(q * GB_IN_BYTES);
    default:
      // Unknown unit on a storage product — skip rather than guess. Worth
      // surfacing in logs if it ever appears in real data.
      return 0;
  }
}

function isStorageProduct(item: UsageItem): boolean {
  const p = (item.product ?? "").toLowerCase();
  return p === "shared_storage" || p === "packages";
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function getGitHubUsage(): Promise<GitHubUsage | GitHubUsageError> {
  if (cached && Date.now() < cacheExpiresAt) {
    return cached;
  }

  const token = process.env["GITHUB_BILLING_TOKEN"];
  if (!token) return { error: "GITHUB_BILLING_TOKEN not set" };

  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth() + 1; // 1-12

  try {
    const url = `${GITHUB_API_BASE}/${ACCOUNT_PATH}/settings/billing/usage?year=${year}&month=${month}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
    } as RequestInit & { cache?: RequestCache });

    if (!res.ok) {
      const body = await res.text().catch(() => res.statusText);
      return { error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    }

    const json = (await res.json()) as BillingUsageResponse;
    const items = json.usageItems ?? [];

    let actionMinutes = 0;
    const minutesBreakdown: Record<string, number> = {};
    let storageBytesAccum = 0;
    let totalBilledUsd = 0;
    let totalGrossUsd = 0;

    for (const item of items) {
      const q = item.quantity ?? 0;
      totalBilledUsd += item.netAmount ?? 0;
      totalGrossUsd += item.grossAmount ?? 0;

      if (item.unitType === "Minutes") {
        actionMinutes += q;
        const sku = item.sku || "(unknown)";
        minutesBreakdown[sku] = (minutesBreakdown[sku] ?? 0) + q;
        continue;
      }

      if (isStorageProduct(item)) {
        storageBytesAccum += storageItemToBytes(item, now);
      }
    }

    const result: GitHubUsage = {
      action_minutes: Math.round(actionMinutes * 100) / 100,
      minutes_breakdown: minutesBreakdown,
      storage_bytes: storageBytesAccum,
      total_billed_usd: Math.round(totalBilledUsd * 10000) / 10000,
      total_gross_usd: Math.round(totalGrossUsd * 10000) / 10000,
      fetched_at: new Date().toISOString(),
    };

    cached = result;
    cacheExpiresAt = Date.now() + CACHE_TTL_MS;
    return result;
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}
