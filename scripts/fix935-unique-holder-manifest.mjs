#!/usr/bin/env node
// fix935-unique-holder-manifest.mjs — set C of the 2026-09-05 prod data pass.
//
// FIX-935 asks us to WRITE the missing source_ids fec id for the UNIQUE HOLDER
// branch of the FIX-930 audit. This script builds that manifest — and the
// manifest's answer, on the 2026-09-05 prod measurement, is that the write set
// is EMPTY. Every candidate is refused, for one of two independent reasons.
//
// REASON 1 — THE CAND_ID IS NOT DERIVABLE FROM THE ROWS. The plan was to derive
// each official's id from their own fec_bulk donation rows. Those rows do not
// carry one. Measured on prod 2026-09-05, the complete metadata key set across
// the fec_bulk donation population is:
//
//   source, tx_count, aggregated, donor_fingerprint, fec_committee_id
//   (plus naics_code / cfda_number / support_oppose on other sources)
//
// fec_committee_id names a COMMITTEE, not a candidate, and no committee ->
// candidate linkage table exists in the database (financial_entities carries
// fec_committee_id and no cand_id; there is no ccl/cn table). FIX-934's own
// header states the same conclusion independently: "Nothing in
// financial_relationships records which CAND_ID a row was written for... The
// CAND_ID lived only in matchRow's memory at write time." So criterion (i) of
// the plan — "one CAND_ID accounts for >= 95% of the official's fec_bulk rows"
// — has no input to compute from. It is not a threshold that fails; it is
// underivable by construction.
//
// REASON 2 — THE ONLY UNAMBIGUOUS CANDIDATES ARE ROLE-REFUSED. Of the 82
// UNIQUE HOLDERs, 78 are the audit's OWN low-confidence corner: they clear the
// overlap-fraction cut but not the absolute shared-pair floor, and the audit
// files them here as the non-destructive DEFAULT, explicitly flagging them as
// "the ambiguous population, not confident singletons". Their money overlaps a
// same-surname twin who is visibly a different person (John Bush / Cori Bush,
// Alan Armstrong / Kelly Armstrong, Jacqueline Nguyen / Kim Nguyen), so any id
// derived from their rows would be the TWIN's id — writing it would manufacture
// exactly the FIX-934 cross-person binding the pool exclusion exists to prevent.
//
// The remaining 4 are true singletons with no twin at all. All 4 are refused by
// roleMayHoldFecOffice(): three Council Members and one Federal Judge. A
// Council Member or an Article III judge cannot hold an H/S/P CAND_ID, so the
// correct remediation for them is NOT to write an id (FIX-935) but to treat the
// money as another person's (FIX-937).
//
// CONSEQUENCE: FIX-935 does not close on this measurement. This manifest is the
// artifact of that refusal, and the residual list is filed as its own FIX rather
// than left in a session report.
//
// READ-ONLY. Reads the FIX-930 audit TSV; writes only the manifest.
//
// USAGE:
//   node scripts/fix935-unique-holder-manifest.mjs

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = "2026-09-05";
const AUDIT_TSV = join(ROOT, "docs", "audits", `${STAMP}-fec-orphan-attribution.tsv`);
const OUT_TSV = join(ROOT, "docs", "audits", `${STAMP}-fix935-unique-holder-manifest.tsv`);

// FIX-1025 ROLE_TO_OFFICE, mirrored. Kept as data rather than imported so this
// script has no build step; packages/data/src/pipelines/fec-bulk/electable-role.ts
// is the authority and the two must not drift.
const ROLE_TO_OFFICE = new Map([
  ["Senator", "S"], ["Candidate for Senator", "S"],
  ["Representative", "H"], ["Candidate for Representative", "H"],
  ["President", "P"], ["Candidate for President", "P"], ["Vice President", "P"],
]);
const fecOfficePrefixFor = (r) => ROLE_TO_OFFICE.get((r ?? "").trim()) ?? null;

const lines = readFileSync(AUDIT_TSV, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
const head = lines[0].split("\t");
const col = Object.fromEntries(head.map((h, i) => [h, i]));
const rows = lines.slice(1).map((l) => l.split("\t"));

const FRAC_CUT = 0.1667; // the audit's derived boundary for this run

const uniq = rows.filter((r) => r[col.branch] === "UNIQUE HOLDER");

const out = uniq.map((r) => {
  const role = r[col.role_title] ?? "";
  const prefix = fecOfficePrefixFor(role);
  const twin = r[col.twin_name] ?? "";
  const frac = Number(r[col.overlap_frac] || 0);
  const hasTwin = (r[col.twin_id] ?? "") !== "";

  // criterion (i): derive the CAND_ID from the official's own rows
  const derived = "";                       // underivable — see REASON 1
  const rowShare = "n/a (no cand_id on FR rows)";
  // criterion (ii): roleMayHoldFecOffice
  const officeCheck = prefix ? `PASS (role may hold ${prefix}*)` : `FAIL (role '${role || "(none)"}' may hold no FEC id)`;
  // criterion (iii): collision — cannot be evaluated without a derived id
  const collisionCheck = "not evaluated (no derived id)";

  let reason;
  if (!prefix) {
    reason = `role '${role || "(none)"}' is not FEC-electable — roleMayHoldFecOffice() refuses; this is FIX-937's population, not FIX-935's`;
  } else if (hasTwin && frac >= FRAC_CUT) {
    reason = `audit low-confidence corner (overlap_frac ${frac.toFixed(4)} >= cut ${FRAC_CUT} vs surname twin '${twin}', shared under the absolute floor) — any id derived from these rows would be the twin's`;
  } else {
    reason = `no CAND_ID derivable: fec_bulk FR metadata carries fec_committee_id only, never cand_id, and no committee->candidate linkage exists (FIX-934)`;
  }

  return [
    r[col.official_id], r[col.full_name], r[col.tier], r[col.is_active], role,
    r[col.jurisdiction], r[col.donation_rows], r[col.donation_cents],
    twin || "—", r[col.twin_fec_id] || "—", r[col.overlap_frac], r[col.shared_pairs],
    derived || "—", rowShare, officeCheck, collisionCheck, "REFUSED", reason,
  ].join("\t");
});

const HEADER = [
  "official_id", "full_name", "tier", "is_active", "role_title", "jurisdiction",
  "donation_rows", "donation_cents", "twin_name", "twin_fec_id", "overlap_frac",
  "shared_pairs", "derived_cand_id", "row_share", "office_check", "collision_check",
  "action", "refusal_reason",
].join("\t");

const roleRefused = uniq.filter((r) => !fecOfficePrefixFor(r[col.role_title]));
const ambiguous = uniq.filter((r) => fecOfficePrefixFor(r[col.role_title]));
const dollars = (rs) => rs.reduce((s, r) => s + Number(r[col.donation_cents] || 0), 0) / 100;

mkdirSync(dirname(OUT_TSV), { recursive: true });
writeFileSync(OUT_TSV, [
  `# FIX-935 — UNIQUE HOLDER write manifest (prod, ${STAMP})`,
  `# source: ${STAMP}-fec-orphan-attribution.tsv`,
  `#`,
  `# WRITE SET IS EMPTY. ${uniq.length} candidates, 0 accepted, ${uniq.length} refused.`,
  `#   ${ambiguous.length} refused as the audit's low-confidence corner (would bind a surname twin's id) — $${dollars(ambiguous).toLocaleString()}`,
  `#   ${roleRefused.length} refused by roleMayHoldFecOffice() (Council Member / Federal Judge) — $${dollars(roleRefused).toLocaleString()}`,
  `#`,
  `# Criterion (i) of the plan is UNDERIVABLE, not merely unmet: fec_bulk`,
  `# financial_relationships rows carry fec_committee_id and never a cand_id, and`,
  `# no committee->candidate linkage exists in the database. See this script's`,
  `# header and the FIX-934 audit header for the two independent confirmations.`,
  `#`,
  HEADER,
  ...out,
].join("\n") + "\n", "utf8");

console.error(`[fix935] UNIQUE HOLDER candidates: ${uniq.length}`);
console.error(`[fix935]   accepted for write: 0`);
console.error(`[fix935]   refused, low-confidence corner: ${ambiguous.length}  ($${dollars(ambiguous).toLocaleString()})`);
console.error(`[fix935]   refused, role not FEC-electable: ${roleRefused.length}  ($${dollars(roleRefused).toLocaleString()})`);
console.error(`[fix935] manifest written: ${OUT_TSV}`);
for (const r of roleRefused) {
  console.error(`[fix935]   role-refused: ${r[col.full_name]} — ${r[col.role_title]} (${r[col.jurisdiction]}) — $${(Number(r[col.donation_cents]) / 100).toLocaleString()}`);
}
