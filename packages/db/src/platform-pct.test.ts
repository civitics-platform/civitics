/**
 * FIX-1089 — the pct misjoin.
 *
 * The bug in one line: `pct` divided by `display_limit ?? included_limit` while
 * the row's label printed `included_limit`, so prod rendered
 * "Database Size 29.6 GB / 8.0 GB" beside a 56% bar. 29.6/8 is 370%.
 *
 * The first test is the exact prod row, with the exact prod numbers, so a
 * regression reads as a failure of a real observation rather than of an
 * abstraction. The rest pin the properties that make the fix safe to ship:
 * over-limit is not clamped, and every OTHER row is bit-for-bit unchanged
 * (only one row in the table sets display_limit, and this is what proves the
 * blast radius really is one row).
 *
 * FIX-1104 retired `capacity_pct`, the second percentage FIX-1089 kept. The
 * assertions that pinned its presence now pin its ABSENCE — it was never
 * rendered, and it divided a subset numerator by the Disk row's own
 * denominator, so it was a quieter duplicate of a signal already on the card.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeMetricPercents, computeMetricStatus } from "./platform-usage";

const GIB = 1024 ** 3;

/** supabase.db_size_bytes @ plan=pro, read off prod 2026-08-22. */
const DB_SIZE_ROW = {
  included_limit: 8 * GIB, //  8 GiB  — the Pro quota, and what the label prints
  display_limit: 56950861824, // 53.03 GiB — the provisioned disk (FIX-353)
};
const DB_SIZE_VALUE = 31813807251; // 29.63 GiB

test("db_size_bytes: pct divides by the quota the label prints, not the disk", () => {
  const result = computeMetricPercents(DB_SIZE_VALUE, DB_SIZE_ROW);

  // The bug: 29.63 / 53.03 = 55.99 → rendered "56%" next to "/ 8.0 GB".
  assert.equal(Math.round((DB_SIZE_VALUE / DB_SIZE_ROW.display_limit) * 100), 56);

  // The fix: 29.63 / 8 = 370.4%. Same row, same label, one denominator.
  assert.equal(Math.round(result.pct), 370);
  assert.ok(result.pct > 100, "an over-quota row must report over-quota");

  // FIX-1104: and the row carries exactly one percentage now.
  assert.deepEqual(Object.keys(result), ["pct"]);
});

test("over-limit pct is never clamped — the UI caps the bar, not the number", () => {
  const { pct } = computeMetricPercents(500, { included_limit: 100 });
  assert.equal(pct, 500);
});

test("FIX-1104: no row carries a capacity_pct, display_limit set or not", () => {
  // Every row in platform_limits except supabase.db_size_bytes(pro) has a NULL
  // display_limit, which is why exactly one row's pct changed in FIX-1089. The
  // one that DOES set it no longer gets a second percentage either.
  const plain = computeMetricPercents(50, { included_limit: 100 });
  assert.equal(plain.pct, 50);
  assert.equal("capacity_pct" in plain, false);

  const withDisplayLimit = computeMetricPercents(DB_SIZE_VALUE, DB_SIZE_ROW);
  assert.equal("capacity_pct" in withDisplayLimit, false);
});

test("rows without display_limit are bit-for-bit unchanged by the fix", () => {
  // The pre-FIX-1089 expression, verbatim.
  const legacy = (value: number, included: number, display: number | null) => {
    const denom = display ?? included;
    return denom > 0 ? (value / denom) * 100 : 0;
  };

  const cases: Array<[number, number]> = [
    [87017826661, 268435456000], // supabase.egress_bytes  → 32.4%
    [17577520507, 25769803776], //  cloudflare.storage_bytes → 68.2%
    [498964, 500000], //             upstash.period_commands → 99.8%
    [26, 60], //                     supabase.db_connections → 43.3%
    [0, 3000], //                    resend.emails_sent (new, empty)
  ];
  for (const [value, included] of cases) {
    assert.equal(
      computeMetricPercents(value, { included_limit: included }).pct,
      legacy(value, included, null),
      `value=${value} limit=${included}`,
    );
  }
});

test("the -1 unlimited sentinel yields 0, not a negative percentage", () => {
  // github.action_minutes, vercel.function_invocations(pro), supabase.api_requests_7d.
  // Dividing by -1 would render 5,134 minutes as "-513,400%".
  assert.equal(computeMetricPercents(5134, { included_limit: -1 }).pct, 0);
  assert.equal(computeMetricPercents(142279, { included_limit: -1 }).pct, 0);
});

test("a null value is 0%, not NaN", () => {
  const row = { included_limit: 100, display_limit: 200 };
  assert.equal(computeMetricPercents(null, row).pct, 0);
  assert.equal("capacity_pct" in computeMetricPercents(null, row), false);
});

/**
 * THE BAND CONSEQUENCE — the thing that had to be verified before shipping.
 *
 * Correcting pct moves db_size_bytes from 56% to 370%, and the row's bands were
 * 80/95. That is a PERMANENT critical: summary.any_critical never clears, the
 * dashboard banner never goes out, and the escalation email fires once and then
 * the band is dead. Same shape as the FIX-1050 `warning_pct: 0` trap.
 *
 * The migration re-bases the bands to 500/750, chosen against the meaning the
 * row now carries — a COST gauge, at $0.125/GB above 8 GiB — rather than the
 * capacity gauge it used to be (which is supabase.disk_used_bytes, still 80/95
 * against the real disk). This test pins both halves so neither the old bands
 * nor the old denominator can come back quietly.
 */
test("db_size_bytes bands: 80/95 would be permanently critical; 500/750 is not", () => {
  const { pct } = computeMetricPercents(DB_SIZE_VALUE, DB_SIZE_ROW);

  assert.equal(
    computeMetricStatus(pct, { warning_pct: 80, critical_pct: 95 }),
    "critical",
    "the old bands on the corrected pct are a permanent critical",
  );
  assert.equal(
    computeMetricStatus(pct, { warning_pct: 500, critical_pct: 750 }),
    "healthy",
    "todays 29.6 GiB is a budgeted $2.70/mo cost, not an incident",
  );

  // And the re-based bands still fire where they should.
  const at = (gib: number) =>
    computeMetricStatus(
      computeMetricPercents(gib * GIB, DB_SIZE_ROW).pct,
      { warning_pct: 500, critical_pct: 750 },
    );
  assert.equal(at(40), "warning", "40 GiB ~ $4.00/mo");
  assert.equal(at(60), "critical", "60 GiB ~ $6.50/mo, and past the 53 GiB disk");
});
