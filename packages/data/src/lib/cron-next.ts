/**
 * FIX-1251 — pg_cron's five fields (UTC): parse a schedule, say whether it
 * restricts day-of-month or month, and find the next occurrence.
 *
 * The receipts verdict needs this to tell a monthly job that simply has not
 * come round yet (`scheduled · next <date>`) from one that should have fired
 * inside the 14-day lookback and did not (`missing`). Five jobs read `missing`
 * ~16 days of every month before this — a lookback artefact, not a fault.
 *
 * DUPLICATION, stated: `scripts/board.mjs` carries its own `parseCron` /
 * `cronEvents` with the same field grammar and the same Vixie day rule.
 * `packages/data` cannot import root `scripts/lib`, and the board is plain
 * dependency-free Node that does not load TypeScript, so the rule has two
 * homes across that package boundary. `cron-next.test.ts` pins this side; the
 * board's own suite pins that one. Change both or neither.
 */

export interface CronSpec {
  raw: string;
  minutes: number[];
  hours: number[];
  dom: Set<number> | null; // null = `*`
  months: Set<number> | null;
  dow: Set<number> | null;
}

function field(f: string, lo: number, hi: number): Set<number> | null | undefined {
  if (f === "*") return null;
  const out = new Set<number>();
  for (const part of f.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return undefined;
    let a: number;
    let b: number;
    if (m[1] === "*") [a, b] = [lo, hi];
    else if (m[1]!.includes("-")) [a, b] = m[1]!.split("-").map(Number) as [number, number];
    else [a, b] = [Number(m[1]), m[2] ? hi : Number(m[1])];
    const step = m[2] ? Number(m[2]) : 1;
    if (!(step > 0) || a < lo || b > hi || a > b) return undefined;
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

const range = (lo: number, hi: number): number[] => Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);

/** Parse a 5-field schedule; null when it is not one this grammar reads. */
export function parseCronSchedule(schedule: string | null | undefined): CronSpec | null {
  const f = String(schedule ?? "").trim().split(/\s+/);
  if (f.length !== 5) return null;
  const mi = field(f[0]!, 0, 59);
  const ho = field(f[1]!, 0, 23);
  const dom = field(f[2]!, 1, 31);
  const mon = field(f[3]!, 1, 12);
  const dow = field(f[4]!, 0, 7);
  if (mi === undefined || ho === undefined || dom === undefined || mon === undefined || dow === undefined) return null;
  if (dow?.has(7)) dow.add(0);
  return {
    raw: f.join(" "),
    minutes: mi === null ? range(0, 59) : [...mi].sort((a, b) => a - b),
    hours: ho === null ? range(0, 23) : [...ho].sort((a, b) => a - b),
    dom,
    months: mon,
    dow,
  };
}

/** True when the schedule restricts day-of-month or month — "monthly" for the receipts. */
export function restrictsDayOfMonthOrMonth(schedule: string | null | undefined): boolean {
  const c = parseCronSchedule(schedule);
  return c !== null && (c.dom !== null || c.months !== null);
}

function dayMatches(c: CronSpec, d: Date): boolean {
  if (c.months && !c.months.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom !== null && c.dom.has(d.getUTCDate());
  const dowOk = c.dow !== null && c.dow.has(d.getUTCDay());
  if (c.dom !== null && c.dow !== null) return domOk || dowOk; // Vixie cron: either restriction fires
  if (c.dom !== null) return domOk;
  if (c.dow !== null) return dowOk;
  return true;
}

const DAY_MS = 86_400_000;

/**
 * The first occurrence STRICTLY after `after` (UTC), or null when the schedule
 * does not parse or never fires (e.g. `0 0 31 2 *`). Walks days, then the
 * sorted hour × minute grid — at most ~5 years of days, for a Feb-29-only job.
 */
export function nextCronOccurrence(schedule: string | null | undefined, after: Date): Date | null {
  const c = parseCronSchedule(schedule);
  if (!c) return null;
  const t = after.getTime();
  const day0 = Math.floor(t / DAY_MS) * DAY_MS;
  for (let i = 0; i < 366 * 5; i++) {
    const dayMs = day0 + i * DAY_MS;
    if (!dayMatches(c, new Date(dayMs))) continue;
    for (const h of c.hours) {
      for (const m of c.minutes) {
        const at = dayMs + h * 3_600_000 + m * 60_000;
        if (at > t) return new Date(at);
      }
    }
  }
  return null;
}
