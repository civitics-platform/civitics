/**
 * FIX-1447 (cc-317 D8) — one label for a proposal's type, used by the detail
 * page, the index page's type filter and ProposalCard. Before this, three
 * copies of a six-key table printed the other six enum values raw
 * ("appointment", "other", …).
 *
 * The six original labels are unchanged. A row can sharpen its label:
 *   appointment → "Nomination" when the number is a PN (a federal nomination),
 *                 else "Appointment" (a Legistar council appointment);
 *   other       → "Court opinion" when metadata.court is set (CourtListener),
 *                 else Legistar's own matter type when set, else "Other".
 */

export const PROPOSAL_TYPE_LABELS: Readonly<Record<string, string>> = {
  regulation:      "Federal Regulation",
  bill:            "Congressional Bill",
  executive_order: "Executive Order",
  treaty:          "Treaty",
  referendum:      "Referendum",
  resolution:      "Resolution",
  appointment:     "Appointment",
  ordinance:       "Ordinance",
  amendment:       "Amendment",
  budget:          "Budget",
  initiative:      "Citizen Initiative",
  other:           "Other",
};

/** The index page's type filter: the six it has always offered, in order. */
export const INDEX_FILTER_TYPES = [
  "regulation",
  "bill",
  "executive_order",
  "treaty",
  "referendum",
  "resolution",
] as const;

export type ProposalLabelContext = {
  billNumber?: string | null;
  metadata?: Record<string, unknown> | null;
};

const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

export function proposalTypeLabel(type: string, ctx: ProposalLabelContext = {}): string {
  if (type === "appointment") {
    return /^PN\s*\d/i.test(ctx.billNumber?.trim() ?? "") ? "Nomination" : "Appointment";
  }
  if (type === "other") {
    if (text(ctx.metadata?.["court"])) return "Court opinion";
    return text(ctx.metadata?.["legistar_matter_type"]) ?? "Other";
  }
  return PROPOSAL_TYPE_LABELS[type] ?? type;
}
