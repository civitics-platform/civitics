/**
 * FIX-1182 experiment (1) — what a SECOND complete emit run can prove about
 * the first one's DROPPED-OUT list, and what it cannot.
 *
 * FIX-1106 read a single run's anti-join as "these rows are residue, delete
 * them". FIX-1182 is the objection: a recipient absent from ONE emit set may
 * simply never have been in it, and the apply would have deleted a sitting
 * senator's $6.03M on that reasoning. Two complete runs are the smallest
 * instrument that can tell the two apart, because only a recipient that a run
 * DID emit and a later run did NOT has been retracted by the source.
 *
 * Keyed on `(to_type, to_id)` — the manifest's own identity column pair.
 *
 * The three classes, per set A (earlier) and set B (later):
 *
 *   (i)   DROPPED-OUT in BOTH  → absent from both emit sets → UNPROVEN.
 *         Neither run ever emitted it, so nothing here says the source
 *         retracted anything. This is the class FIX-1182 was filed to protect,
 *         and it is never applied.
 *   (ii)  DROPPED-OUT in B, NOT in A's DROPPED-OUT list → A had it (fully or
 *         partly) in its emit set and B does not → RETRACTION. The only
 *         applicable class.
 *   (iii) DROPPED-OUT in A, not in B's → re-emitted by the later run → not
 *         residue at all. Deleting this class is the FIX-1182 hazard realised.
 *
 * PARTIAL rows are NOT membership of the DROPPED-OUT list. A PARTIAL recipient
 * in A had SOME of its rows emitted, so if it is DROPPED-OUT in B it has been
 * retracted — a partial retraction is still a retraction, and the row belongs
 * in (ii). It is recorded as `wasPartialInA` so a reader can see which (ii)
 * members went PARTIAL → DROPPED-OUT rather than clean → DROPPED-OUT.
 *
 * THE PROVENANCE CHECK. "Not in A's DROPPED-OUT list" has three possible
 * causes, and only two of them are retraction:
 *   (a) A emitted it fully               → retraction,
 *   (b) A emitted it partly (PARTIAL)    → retraction,
 *   (c) the rows did not exist when A was cut → proves nothing.
 * (c) is separated by the row's own `last_write`: if every row predates the
 * moment set A was generated, the rows were there for A to judge and A did not
 * call them residue. A row written after A is demoted to UNPROVEN, because
 * absence from a list cut before it existed is not evidence. Without this a
 * recipient created between the two runs and not yet emitted would be
 * classified as retracted and deleted.
 */

/** One manifest row, as `audit-fec-emit-residue.ts` writes it. */
export interface ManifestRow {
  cls: string;
  to_type: string;
  to_id: string;
  name: string;
  rows: number;
  cents: number;
  /** Max write timestamp across the recipient's residue rows, ISO-ish text. */
  last_write: string;
  emitted_rows: number;
}

export type ExperimentClass = "unproven-both" | "retraction" | "re-emitted";

export interface ClassifiedRow extends ManifestRow {
  klass: ExperimentClass;
  /** (ii) only — did A hold it as PARTIAL rather than absent entirely? */
  wasPartialInA: boolean;
  /**
   * (ii) only — set when the row FAILED the provenance check and was demoted
   * to `unproven-both`: its rows are not older than set A, so A's silence
   * about it is not evidence.
   */
  demotedReason?: string;
}

export interface ClassifyInput {
  setA: readonly ManifestRow[];
  setB: readonly ManifestRow[];
  /** When set A was generated, from its `# … generated <iso>` header. */
  generatedA: Date;
}

export const DROPPED_OUT = "DROPPED-OUT";
export const PARTIAL = "PARTIAL";

const key = (r: ManifestRow): string => `${r.to_type}\t${r.to_id}`;

/**
 * Parse the manifest's `last_write` (`2026-09-01 01:17:41.714183+00`). Returns
 * null when it is absent or unparseable, which the caller must treat as
 * FAILING the provenance check — an unknown age cannot clear a row for
 * deletion.
 */
export function parseLastWrite(s: string): Date | null {
  const t = (s ?? "").trim();
  if (t === "" || t === "null") return null;
  // Postgres renders the zone as `+00`, which Date rejects — ISO 8601 wants
  // `+00:00` (or `Z`). Getting this wrong is not a cosmetic parse failure: an
  // unparseable timestamp fails the provenance check, so EVERY candidate
  // retraction silently demotes to unproven and the apply reads as empty.
  const iso = t.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function classify(input: ClassifyInput): ClassifiedRow[] {
  const droppedA = new Map<string, ManifestRow>();
  const partialA = new Map<string, ManifestRow>();
  for (const r of input.setA) {
    if (r.cls === DROPPED_OUT) droppedA.set(key(r), r);
    else if (r.cls === PARTIAL) partialA.set(key(r), r);
  }

  const out: ClassifiedRow[] = [];

  for (const r of input.setB) {
    if (r.cls !== DROPPED_OUT) continue;
    const k = key(r);
    if (droppedA.has(k)) {
      out.push({ ...r, klass: "unproven-both", wasPartialInA: false });
      continue;
    }
    // Candidate retraction — now the provenance check.
    const lw = parseLastWrite(r.last_write);
    if (lw === null || lw >= input.generatedA) {
      out.push({
        ...r,
        klass: "unproven-both",
        wasPartialInA: partialA.has(k),
        demotedReason:
          lw === null
            ? "last_write unparseable — cannot show the rows predate set A"
            : `last_write ${r.last_write} is not older than set A (${input.generatedA.toISOString()}) — the rows may not have existed when A was cut`,
      });
      continue;
    }
    out.push({ ...r, klass: "retraction", wasPartialInA: partialA.has(k) });
  }

  const droppedBKeys = new Set(input.setB.filter((r) => r.cls === DROPPED_OUT).map(key));
  for (const r of input.setA) {
    if (r.cls !== DROPPED_OUT) continue;
    if (!droppedBKeys.has(key(r))) out.push({ ...r, klass: "re-emitted", wasPartialInA: false });
  }

  return out;
}

export interface ClassTotals {
  recipients: number;
  rows: number;
  cents: number;
}

export function totals(rows: readonly ClassifiedRow[], klass: ExperimentClass): ClassTotals {
  const sel = rows.filter((r) => r.klass === klass);
  return {
    recipients: sel.length,
    rows: sel.reduce((a, r) => a + r.rows, 0),
    cents: sel.reduce((a, r) => a + r.cents, 0),
  };
}
