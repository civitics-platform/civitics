import type { Check, CheckResult } from "../types";

export const officialsChecks: Check = async ({ query }) => {
  const out: CheckResult[] = [];

  // Federal-only scope: officials.source_ids has 'congress_gov' for U.S.
  // congressional officials. State legislators (from OpenStates) carry
  // 'openstates_id' instead.
  const FED_FILTER = `source_ids ? 'congress_gov'`;

  const senators = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%senator%'
        AND ${FED_FILTER}`,
  );
  const senatorCount = Number(senators[0]?.count ?? 0);
  out.push({
    category: "officials.senator_count",
    severity: senatorCount === 100 ? "info" : "error",
    expected: 100,
    actual: senatorCount,
    sample: [],
    detail: "Active U.S. senators (2 per state × 50 states).",
  });

  // Senator metadata is empty {} on federal rows — state info lives via the
  // jurisdictions JOIN (officials.jurisdiction_id -> jurisdictions.name).
  // Pre-FIX-318 used COALESCE(metadata->>'state', metadata->>'state_abbr')
  // which grouped all 100 senators into a single NULL bucket.
  const senatorsByState = await query<{ state: string | null; count: string }>(
    `SELECT j.name AS state, COUNT(*)::text AS count
       FROM officials o
       LEFT JOIN jurisdictions j ON j.id = o.jurisdiction_id
      WHERE o.is_active = true
        AND o.role_title ILIKE '%senator%'
        AND o.source_ids ? 'congress_gov'
      GROUP BY 1`,
  );
  const wrongStates = senatorsByState.filter((row) => Number(row.count) !== 2);
  if (wrongStates.length > 0) {
    out.push({
      category: "officials.senators_per_state",
      severity: "error",
      expected: "every state = 2",
      actual: `${wrongStates.length} states ≠ 2`,
      sample: wrongStates.slice(0, 20),
      detail: "States that don't have exactly two active senators.",
    });
  }

  const reps = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM officials
      WHERE is_active = true
        AND role_title ILIKE '%representative%'
        AND ${FED_FILTER}`,
  );
  const repCount = Number(reps[0]?.count ?? 0);
  out.push({
    category: "officials.rep_count",
    severity: repCount === 441 ? "info" : "error",
    expected: 441,
    actual: repCount,
    sample: [],
    detail: "Active U.S. House: 435 voting + 6 non-voting delegates.",
  });

  // President + VP: pre-FIX-318 used ILIKE '%president%' which swept in the
  // 2603 cn24.zip 'Candidate for President' rows (tier=candidate), USPS
  // "Executive Vice President" titles, and other state-legislature
  // "President of the Senate" / pro-tem roles. Tighten to exact canonical
  // role_title for the sitting POTUS / VPOTUS. Currently returns 0 — the
  // executive branch is not yet ingested (filed as FIX-321).
  const president = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM officials
      WHERE is_active = true
        AND tier = 'elected'
        AND role_title ~ '^President( of the United States)?$'`,
  );
  const presCount = Number(president[0]?.count ?? 0);
  out.push({
    category: "officials.president_count",
    severity: presCount === 1 ? "info" : "error",
    expected: 1,
    actual: presCount,
    sample: [],
    detail: "Sitting U.S. President.",
  });

  const vp = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count
       FROM officials
      WHERE is_active = true
        AND tier = 'elected'
        AND role_title ~ '^Vice President( of the United States)?$'`,
  );
  const vpCount = Number(vp[0]?.count ?? 0);
  out.push({
    category: "officials.vp_count",
    severity: vpCount === 1 ? "info" : "error",
    expected: 1,
    actual: vpCount,
    sample: [],
    detail: "Sitting U.S. Vice President.",
  });

  const dupes = await query<{ congress_gov: string; count: string }>(
    `SELECT source_ids->>'congress_gov' AS congress_gov, COUNT(*)::text AS count
       FROM officials
      WHERE source_ids ? 'congress_gov'
      GROUP BY 1
      HAVING COUNT(*) > 1`,
  );
  out.push({
    category: "officials.duplicate_congress_gov",
    severity: dupes.length === 0 ? "info" : "error",
    expected: 0,
    actual: dupes.length,
    sample: dupes.slice(0, 20),
    detail:
      "Distinct officials sharing the same source_ids->>'congress_gov' (federal congressional ID).",
  });

  const missingParty = await query<{ id: string; full_name: string; role_title: string }>(
    `SELECT id, full_name, role_title
       FROM officials
      WHERE is_active = true
        AND party IS NULL
        AND (role_title ILIKE '%senator%' OR role_title ILIKE '%representative%')
        AND ${FED_FILTER}`,
  );
  out.push({
    category: "officials.missing_party",
    severity: missingParty.length === 0 ? "info" : "error",
    expected: 0,
    actual: missingParty.length,
    sample: missingParty.slice(0, 20),
    detail:
      "Active senators/reps with NULL party. Independents should be 'independent', not NULL.",
  });

  // FIX-322: observational check for tier-mapping drift. Surfaces active
  // officials carrying tier='elected' whose role_title is obviously not an
  // elected role (USPS execs, institutional "President, [Institute]" forms,
  // appointed Special Representative / Special Envoy positions). FED_FILTER
  // is deliberately NOT applied — the USPS rows have no congress_gov
  // source_id. When this trips at volume, file a follow-up to fix the
  // upstream ingest; the check itself is the guardrail.
  // FIX-324: split COUNT from sample. Pre-FIX, the single LIMIT 20 query made
  // `actual` cap at 20, hiding drift trend above that. Now `actual` is the
  // unbounded count; `sample` keeps the first 20 rows for the audit dump.
  const suspiciousFilter = `is_active = true
        AND tier = 'elected'
        AND (
          (role_title ILIKE '%vice president%'
           AND role_title NOT ILIKE 'Vice President of the United States%'
           AND role_title NOT ILIKE 'VPOTUS%')
          OR role_title ILIKE 'President, %'
          OR role_title ILIKE 'Special Representative %'
          OR role_title ILIKE 'Special Envoy %'
        )`;
  const suspiciousCount = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM officials WHERE ${suspiciousFilter}`,
  );
  const suspiciousActual = Number(suspiciousCount[0]?.count ?? 0);
  const suspiciousSample = await query<{
    id: string;
    full_name: string;
    role_title: string;
    tier: string;
  }>(
    `SELECT id, full_name, role_title, tier
       FROM officials
      WHERE ${suspiciousFilter}
      ORDER BY full_name
      LIMIT 20`,
  );
  out.push({
    category: "officials.suspicious_elected_tier",
    severity: suspiciousActual === 0 ? "info" : "error",
    expected: 0,
    actual: suspiciousActual,
    sample: suspiciousSample,
    detail:
      "Active officials with tier='elected' but role_title matches a non-elected pattern (USPS exec, institutional president, special representative/envoy). Surfaces upstream tier-mapping drift; file a follow-up FIX to fix the ingest when this trips at volume.",
  });

  return out;
};
