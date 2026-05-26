import type { Check, CheckResult } from "../types";

export const proposalsChecks: Check = async ({ query }) => {
  const out: CheckResult[] = [];

  const proceduralRows = await query<{ id: string; title: string; type: string | null }>(
    `SELECT id, title, type::text AS type
       FROM proposals
      WHERE title ~* '^on '`,
  );
  out.push({
    category: "proposals.procedural_contamination",
    severity: proceduralRows.length === 0 ? "info" : "error",
    expected: 0,
    actual: proceduralRows.length,
    sample: proceduralRows.slice(0, 10),
    detail:
      "Proposals whose title starts with 'On ' (e.g. 'On Passage', 'On the Cloture Motion') — FIX-A regression test. The ' v.' arm was removed by FIX-319 after producing 100% false positives (courtlistener opinions + legistar lawsuit-settlement ordinances).",
  });

  const orphanAgency = await query<{
    id: string;
    title: string;
    agency_id: string | null;
  }>(
    `SELECT p.id, p.title, p.metadata->>'agency_id' AS agency_id
       FROM proposals p
      WHERE p.metadata ? 'agency_id'
        AND p.metadata->>'agency_id' IS NOT NULL
        AND p.metadata->>'agency_id' <> ''
        AND NOT EXISTS (
          SELECT 1 FROM agencies a
           WHERE a.acronym = p.metadata->>'agency_id'
        )`,
  );
  out.push({
    category: "proposals.orphaned_agency_id",
    severity: orphanAgency.length === 0 ? "info" : "error",
    expected: 0,
    actual: orphanAgency.length,
    sample: orphanAgency.slice(0, 10),
    detail:
      "proposals.metadata->>'agency_id' values that don't resolve to any row in agencies.acronym.",
  });

  return out;
};
