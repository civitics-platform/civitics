/**
 * Daily burn-rate detection (FIX-1044, D2).
 *
 * ── THE GAP THIS FILLS ───────────────────────────────────────────────────────
 *
 * Every cost alert this platform had before today was MONTHLY-CUMULATIVE: a
 * metric crosses 80% / 100% of its included limit and an email goes out. That is
 * a fine LAGGING control and a useless leading one. At the 2026-08-15 burn rate
 * (~$21/day) the Vercel bands would not have tripped for days, and the audit
 * that finally quantified the incident did so by DIFFERENTIATING the cumulative
 * series BY HAND. This automates exactly that hand calculation.
 *
 * ── WHY TWO CONDITIONS, NOT ONE ──────────────────────────────────────────────
 *
 * A pure multiple ("3x the trailing median") fires constantly on a platform
 * whose baseline is $0.33/day — a quiet week drags the median down and then any
 * ordinary deploy day reads as 5x. A pure absolute floor misses a burn that
 * starts from an already-elevated baseline. The rule therefore requires BOTH:
 *
 *     delta_today >= ABSOLUTE_FLOOR_USD   AND   delta_today >= MULTIPLE x median7
 *
 * Checked against the measured series (docs/audits/2026-08-15-traffic-cost-spike.md):
 * the spike day's $1.21 of consumption against a $0.33 trailing median is 3.7x
 * and clears both, so the rule fires. A $0.40 day at 1.2x fails the multiple; a
 * $0.90 day against a $0.10 median is 9x but fails the floor. Both of those are
 * noise and both stay quiet.
 *
 * ── WHAT IS DIFFERENTIATED, AND WHY IT IS NOT THE HEADLINE NUMBER ────────────
 *
 * USAGE dollars, i.e. EffectiveCost minus the `Pro` subscription line. The
 * subscription accrues a flat $20/31 = $0.6452 every single day, so leaving it
 * in adds a constant to every delta and CRUSHES the ratio the rule depends on:
 * the spike day reads 3.7x on consumption and only 1.9x on the gross series.
 * Same correction as FIX-1046, same reason. See vercel-billing.ts.
 *
 * ── RESOLUTION LIMIT, STATED UP FRONT ────────────────────────────────────────
 *
 * Vercel's charges API is cumulative month-to-date and steps ONCE PER DAY at
 * ~07:00 UTC (midnight Pacific). Consecutive 10-minute snapshots are
 * byte-identical. So this layer can only ever detect a burn the DAY AFTER it
 * starts — it is a real improvement over "days later", not a replacement for the
 * Cloudflare hourly signal, which is what actually gives sub-hour detection.
 * Both ship together for that reason.
 *
 * The rule is a pure function so it can be table-tested; the DB reader is
 * separate and thin.
 */

// ── Tunables ──────────────────────────────────────────────────────────────────

/**
 * A day must burn at least this much CONSUMPTION (excl. the $20 subscription)
 * before it can alert, whatever the ratio says.
 *
 * $1.00/day = ~3x the measured $0.33 baseline and ~$30/month if sustained, i.e.
 * enough on its own to blow through the $20 included credit. Below that, the
 * absolute dollars do not justify waking anyone up no matter how large the
 * multiple looks against a quiet week.
 */
export const BURN_ABSOLUTE_FLOOR_USD = 1.0;

/** ...and it must also be this many times the trailing median. */
export const BURN_MULTIPLE = 3;

/** Trailing window for the median. 7 days covers a full weekly cycle. */
export const BURN_TRAILING_DAYS = 7;

/** Fewer complete days than this and there is no trustworthy median yet. */
export const BURN_MIN_HISTORY_DAYS = 4;

// ── Types ─────────────────────────────────────────────────────────────────────

/** One cumulative month-to-date reading, keyed by MTD day index. */
export type BurnRateDay = {
  /** `window_days` from the charges response: 1..31, the MTD day index. */
  mtd_day: number;
  /** Σ EffectiveCost MTD, including the plan-subscription line. */
  gross_usd: number;
  /** Σ EffectiveCost of the plan-subscription line, MTD. */
  base_usd: number;
};

export type BurnRateDelta = {
  mtd_day: number;
  /** Consumption for THIS day alone (gross − base, differentiated). */
  usage_usd: number;
};

export type BurnRateVerdict = {
  /** The most recent complete day's consumption, or null with no history. */
  latest_delta_usd: number | null;
  latest_mtd_day: number | null;
  /** Median of up to BURN_TRAILING_DAYS days BEFORE the latest one. */
  trailing_median_usd: number | null;
  /** latest / median. null when the median is 0 or unknown. */
  multiple: number | null;
  /** Both conditions met. */
  elevated: boolean;
  /** Why it did or did not fire — goes verbatim into the alert body. */
  reason: string;
  /** Days used, for the card. */
  history_days: number;
  /** 30-day run-rate of the latest day's consumption. */
  projected_monthly_usd: number | null;
};

// ── Rule ──────────────────────────────────────────────────────────────────────

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}

/**
 * Differentiate a cumulative MTD series into per-day consumption.
 *
 * The first day of the series is DROPPED: with no prior reading its "delta" is
 * the whole month-to-date total, which would read as a colossal burn on the
 * first tick after any retention prune. That off-by-one is exactly the kind of
 * thing that makes an alarm untrustworthy on its first firing.
 */
export function computeBurnRateDeltas(days: BurnRateDay[]): BurnRateDelta[] {
  const sorted = [...days].sort((a, b) => a.mtd_day - b.mtd_day);
  const out: BurnRateDelta[] = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i]!;
    const prev = sorted[i - 1]!;
    // Non-consecutive days mean a snapshot gap; the delta then spans more than
    // one day and would over-report. Skip rather than divide by a guess.
    if (cur.mtd_day - prev.mtd_day !== 1) continue;
    const curUsage = cur.gross_usd - cur.base_usd;
    const prevUsage = prev.gross_usd - prev.base_usd;
    out.push({ mtd_day: cur.mtd_day, usage_usd: curUsage - prevUsage });
  }
  return out;
}

export function evaluateBurnRate(
  days: BurnRateDay[],
  opts: {
    floorUsd?: number;
    multiple?: number;
    trailingDays?: number;
    minHistoryDays?: number;
  } = {},
): BurnRateVerdict {
  const floor = opts.floorUsd ?? BURN_ABSOLUTE_FLOOR_USD;
  const mult = opts.multiple ?? BURN_MULTIPLE;
  const trailing = opts.trailingDays ?? BURN_TRAILING_DAYS;
  const minHistory = opts.minHistoryDays ?? BURN_MIN_HISTORY_DAYS;

  const deltas = computeBurnRateDeltas(days);
  const quiet = (reason: string): BurnRateVerdict => ({
    latest_delta_usd: null,
    latest_mtd_day: null,
    trailing_median_usd: null,
    multiple: null,
    elevated: false,
    reason,
    history_days: deltas.length,
    projected_monthly_usd: null,
  });

  if (deltas.length < minHistory) {
    return quiet(
      `only ${deltas.length} complete day(s) of history; need ${minHistory} before a ` +
        `median means anything`,
    );
  }

  const latest = deltas[deltas.length - 1]!;
  const priorWindow = deltas.slice(Math.max(0, deltas.length - 1 - trailing), deltas.length - 1);
  const med = median(priorWindow.map((d) => d.usage_usd));

  const multiple = med !== null && med > 0 ? latest.usage_usd / med : null;
  const clearsFloor = latest.usage_usd >= floor;
  const clearsMultiple = multiple !== null && multiple >= mult;
  const elevated = clearsFloor && clearsMultiple;

  const money = (n: number): string => `$${n.toFixed(4)}`;
  const base =
    `day ${latest.mtd_day} consumption ${money(latest.usage_usd)} vs a ` +
    `${priorWindow.length}-day median of ${med === null ? "n/a" : money(med)}` +
    (multiple === null ? "" : ` (${multiple.toFixed(1)}x)`);

  let reason: string;
  if (elevated) {
    reason =
      `${base} — clears BOTH the ${money(floor)} floor and the ${mult}x multiple. ` +
      `At this rate the month costs ${money(latest.usage_usd * 30)} of consumption.`;
  } else if (!clearsFloor && !clearsMultiple) {
    reason = `${base} — below the ${money(floor)} floor and below ${mult}x. Normal.`;
  } else if (!clearsFloor) {
    reason =
      `${base} — ${mult}x multiple met but the absolute burn is under the ` +
      `${money(floor)} floor, so this is a quiet-baseline artefact, not a cost event.`;
  } else {
    reason =
      `${base} — over the ${money(floor)} floor but under ${mult}x, i.e. an ` +
      `expensive-but-typical day.`;
  }

  return {
    latest_delta_usd: latest.usage_usd,
    latest_mtd_day: latest.mtd_day,
    trailing_median_usd: med,
    multiple,
    elevated,
    reason,
    history_days: deltas.length,
    projected_monthly_usd: latest.usage_usd * 30,
  };
}

// ── DB reader ─────────────────────────────────────────────────────────────────

/**
 * Pull the cumulative MTD cost series out of `platform_usage_snapshot`.
 *
 * The extraction runs IN THE DATABASE (`get_platform_daily_cost_deltas`) rather
 * than here: the payloads are large jsonb documents and there are ~150 snapshot
 * rows per day, so shipping them to a Vercel function to pick two numbers out of
 * each would be absurd. The RPC returns one row per MTD day.
 *
 * Never throws — a missing RPC (migration not applied yet) yields an empty
 * series and the verdict degrades to "not enough history".
 */
export async function readBurnRateSeries(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  days = 12,
): Promise<BurnRateDay[]> {
  try {
    const { data, error } = await db.rpc("get_platform_daily_cost_deltas", {
      p_days: days,
    });
    if (error || !Array.isArray(data)) return [];
    return data
      .map((r: { mtd_day?: unknown; gross_usd?: unknown; base_usd?: unknown }) => ({
        mtd_day: Number(r.mtd_day),
        gross_usd: Number(r.gross_usd),
        base_usd: Number(r.base_usd),
      }))
      .filter(
        (r: BurnRateDay) =>
          Number.isFinite(r.mtd_day) &&
          Number.isFinite(r.gross_usd) &&
          Number.isFinite(r.base_usd),
      );
  } catch {
    return [];
  }
}
