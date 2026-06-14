// Investigations MVP PR2 (FIX-579 / FIX-580) — pure presentation helpers shared
// by the server pages and the client islands (composer / pickers / rating). NO
// server-only imports here (no cookies / admin client) so 'use client' islands
// can import it too. Server-only loaders live in ./load.ts.
//
// Every vocabulary here mirrors the PR1 DB layer
// (supabase/migrations/20260614000100_investigations_foundation.sql) so the UI
// can only offer values the SECURITY DEFINER RPCs accept:
//   * relationship_kind — the 16 human-assertable connection_type values
//   * edge endpoint types — financial_entity / official / agency / governing_body
//   * citation tiers — internal_record (tier 1) / imported_entity (tier 2) only

// ─── Shared row types (match the /api/investigations[/id] read shape) ──────────

export type EvidenceRatingSummary = {
  agree_up: number;
  agree_down: number;
  valuable_up: number;
  valuable_down: number;
};

export type Citation = {
  id: string;
  evidence_card_id: string;
  citation_type: "internal_record" | "imported_entity" | "document_page" | "external_url";
  target_type: string | null;
  target_id: string | null;
  external_url: string | null;
  excerpt: string | null;
  created_at: string;
};

export type EvidenceCard = {
  id: string;
  investigation_id: string;
  author_id: string;
  author_name: string;
  claim_text: string;
  claim_type: "edge" | "context";
  from_type: string | null;
  from_id: string | null;
  to_type: string | null;
  to_id: string | null;
  relationship_kind: string | null;
  status: "proposed" | "corroborated" | "disputed" | "promoted" | "rejected";
  subject_is_private_person: boolean;
  rating_summary: EvidenceRatingSummary;
  created_at: string;
  updated_at: string;
  citations: Citation[];
};

export type Investigation = {
  id: string;
  title: string;
  question: string | null;
  scope_type: string | null;
  scope_id: string | null;
  scope_note: string | null;
  status: "open" | "closed" | "archived";
  findings_md: string | null;
  created_by: string;
  is_seeded: boolean;
  is_featured: boolean;
  created_at: string;
  updated_at: string;
};

export type Contributor = {
  user_id: string;
  name: string;
  card_count: number;
  is_creator: boolean;
};

// ─── Tiers ────────────────────────────────────────────────────────────────────

export function citationTier(citationType: Citation["citation_type"]): 1 | 2 | 3 {
  if (citationType === "internal_record") return 1;
  if (citationType === "imported_entity") return 2;
  return 3; // document_page / external_url — not enabled in MVP
}

export const TIER_BADGE: Record<1 | 2 | 3, { label: string; className: string }> = {
  1: { label: "Tier 1 · internal record", className: "bg-green-ink/10 text-green-ink border-green-ink/25" },
  2: { label: "Tier 2 · imported entity", className: "bg-civic-blue/10 text-civic-blue border-civic-blue/25" },
  3: { label: "Tier 3", className: "bg-ink/5 text-ink-soft border-rule" },
};

// The mandatory tier-2 disclaimer (design §3 / §4 — presence in an imported
// third-party network is not, by itself, evidence of wrongdoing).
export const TIER2_DISCLAIMER =
  "Presence in an imported third-party network (e.g. LittleSis/ICIJ) is not, by itself, evidence of wrongdoing.";

// ─── Relationship kinds (edge cards) — the 16 assertable connection_type values ─

export const RELATIONSHIP_KINDS: { value: string; label: string }[] = [
  { value: "oversight", label: "Oversight" },
  { value: "lobbying", label: "Lobbying" },
  { value: "revolving_door", label: "Revolving door" },
  { value: "appointment", label: "Appointment" },
  { value: "holds_position", label: "Holds position" },
  { value: "gift_received", label: "Gift received" },
  { value: "contract_award", label: "Contract award" },
  { value: "donation", label: "Donation" },
  { value: "family", label: "Family" },
  { value: "business_partner", label: "Business partner" },
  { value: "legal_representation", label: "Legal representation" },
  { value: "endorsement", label: "Endorsement" },
  { value: "member_of", label: "Member of" },
  { value: "owns", label: "Owns" },
  { value: "parent_of", label: "Parent of" },
  { value: "affiliated_with", label: "Affiliated with" },
];

export function relationshipKindLabel(value: string | null): string {
  if (!value) return "";
  return RELATIONSHIP_KINDS.find((k) => k.value === value)?.label ?? value.replace(/_/g, " ");
}

// ─── Card status (presentation) ────────────────────────────────────────────────

export const CARD_STATUS_BADGE: Record<EvidenceCard["status"], { label: string; className: string }> = {
  proposed: { label: "Proposed", className: "bg-ink/5 text-ink-soft border-rule" },
  corroborated: { label: "Corroborated", className: "bg-civic-blue/10 text-civic-blue border-civic-blue/25" },
  disputed: { label: "Disputed", className: "bg-amber/25 text-ink border-amber/60" },
  promoted: { label: "Promoted to graph", className: "bg-green-ink/10 text-green-ink border-green-ink/25" },
  rejected: { label: "Rejected", className: "bg-accent/10 text-accent border-accent/25" },
};

export const CLAIM_TYPE_LABEL: Record<EvidenceCard["claim_type"], string> = {
  edge: "Relationship claims",
  context: "Context",
};

// ─── Out-links for citation targets / edge endpoints ───────────────────────────

const TARGET_HREF_BASE: Record<string, string> = {
  official: "/officials/",
  proposal: "/proposals/",
  agency: "/agencies/",
  financial_entity: "/donors/",
  jurisdiction: "/jurisdictions/",
  governing_body: "/institutions/",
  institution: "/institutions/",
};

// A linkable record gets an href; vote / financial_relationship / entity_connection
// have no standalone detail page → rendered as plain text.
export function targetHref(targetType: string | null, targetId: string | null): string | null {
  if (!targetType || !targetId) return null;
  const base = TARGET_HREF_BASE[targetType];
  return base ? `${base}${targetId}` : null;
}

export const TARGET_TYPE_LABEL: Record<string, string> = {
  official: "Official",
  proposal: "Proposal",
  agency: "Agency",
  financial_entity: "Donor / financial entity",
  jurisdiction: "Jurisdiction",
  governing_body: "Governing body",
  institution: "Institution",
  vote: "Vote record",
  financial_relationship: "Financial relationship",
  entity_connection: "Connection",
};

export function targetTypeLabel(targetType: string | null): string {
  if (!targetType) return "Record";
  return TARGET_TYPE_LABEL[targetType] ?? targetType.replace(/_/g, " ");
}

// ─── Entity-search picker config (drives CitationPicker + EntityPicker) ─────────
// Each kind maps a /api/search result array → a pickable {target_type,id,name,href}.

export type PickKind = {
  /** key of the array in the /api/search response */
  resultsKey: "officials" | "proposals" | "agencies" | "financial_entities" | "jurisdictions" | "institutions";
  /** the citation/edge target_type the RPC expects */
  targetType: string;
  label: string;
  /** field on the result row that holds the display name */
  nameField: "full_name" | "title" | "name";
};

// Tier-1 internal-record citation: everything the search surface can reach AND the
// citation-target validator accepts (official/proposal/agency/financial_entity/
// jurisdiction/governing_body). Votes / donations / financial_relationships are
// valid targets in the DB but have no text-search surface, so they're not offered
// here (PR1 API gap — noted in the report).
export const INTERNAL_RECORD_KINDS: PickKind[] = [
  { resultsKey: "officials", targetType: "official", label: "Official", nameField: "full_name" },
  { resultsKey: "proposals", targetType: "proposal", label: "Proposal", nameField: "title" },
  { resultsKey: "agencies", targetType: "agency", label: "Agency", nameField: "name" },
  { resultsKey: "financial_entities", targetType: "financial_entity", label: "Donor / financial entity", nameField: "name" },
  { resultsKey: "jurisdictions", targetType: "jurisdiction", label: "Jurisdiction", nameField: "name" },
  { resultsKey: "institutions", targetType: "governing_body", label: "Institution / body", nameField: "name" },
];

// Edge endpoints: only the four types the evidence_cards from/to CHECK allows.
export const EDGE_ENDPOINT_KINDS: PickKind[] = [
  { resultsKey: "officials", targetType: "official", label: "Official", nameField: "full_name" },
  { resultsKey: "agencies", targetType: "agency", label: "Agency", nameField: "name" },
  { resultsKey: "financial_entities", targetType: "financial_entity", label: "Donor / financial entity", nameField: "name" },
  { resultsKey: "institutions", targetType: "governing_body", label: "Governing body", nameField: "name" },
];

export type PickedEntity = {
  target_type: string;
  target_id: string;
  name: string;
  kindLabel: string;
};

// ─── Misc ──────────────────────────────────────────────────────────────────────

export function formatCount(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}
