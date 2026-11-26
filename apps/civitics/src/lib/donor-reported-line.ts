/**
 * FIX-1450 (cc-325 D6) — an individual donor's reported line: what the FEC
 * filing says about them, from `financial_entities.metadata`.
 *
 *   <Occupation> · <Employer> · <City>, <ST>     — "As reported on an FEC filing"
 *
 * - Individuals only; every other entity type gets nothing.
 * - Never the ZIP: `zip5` is not read here at all. The line is page-only — the
 *   caller keeps it out of <title>, the meta description, OpenGraph and JSON-LD.
 * - A value is dropped when it is empty or a non-answer (N/A, NA, NONE, NULL,
 *   ".", REQUESTED, INFORMATION REQUESTED…), compared trimmed and uppercased.
 *   RETIRED, NOT EMPLOYED, SELF-EMPLOYED, SELF, HOMEMAKER are answers and stay.
 * - Occupation and employer that are the same answer print once.
 * - Printed as stored: the page prints `display_name` as stored, so this does too.
 *
 * Pure and free of next/* so the app test runner discovers it under src/.
 */

export const REPORTED_CAPTION = "As reported on an FEC filing";

const NON_ANSWERS = new Set(["", "N/A", "NA", "NONE", "NULL", ".", "REQUESTED"]);

/** The stored value, trimmed, or null when it is empty or a non-answer. */
export function reportedValue(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  const u = t.toUpperCase();
  if (NON_ANSWERS.has(u) || u.startsWith("INFORMATION REQUESTED")) return null;
  return t;
}

/** "SELF-EMPLOYED" and "self employed" are one answer. */
const same = (a: string, b: string) =>
  a.toUpperCase().replace(/[\s-]+/g, " ") === b.toUpperCase().replace(/[\s-]+/g, " ");

export function donorReportedLine(entity: {
  entity_type: string;
  metadata: Record<string, unknown> | null;
}): string | null {
  if (entity.entity_type !== "individual") return null;
  const m = entity.metadata ?? {};
  const occupation = reportedValue(m["occupation"]);
  const employer = reportedValue(m["employer"]);
  const city = reportedValue(m["city"]);
  const state = reportedValue(m["state"]);
  const work = occupation && employer && same(occupation, employer) ? [occupation] : [occupation, employer];
  const place = city && state ? `${city}, ${state}` : city ?? state;
  const parts = [...work, place].filter((p): p is string => !!p);
  return parts.length > 0 ? parts.join(" · ") : null;
}
