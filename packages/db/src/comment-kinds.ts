// Shared comment vocabulary for the unified entity_comments substrate (C0, FIX-520).
//
// `kind` is app-layer TEXT (no DB enum) — same pattern as the legacy
// civic_initiative_arguments.comment_type. This module is the single source of
// truth for which kinds are allowed per entity_type and per initiative stage,
// the stance vocabulary, and the C0 rate limits. Server routes validate against
// ALLOWED_KINDS; the UI uses the same lists to build composers.
//
// Framework-agnostic (no React) so both route handlers and client components
// can import it from `@civitics/db`.

// ─── Entity discriminator (mirrors the entity_comments CHECK constraint) ──────
export const ENTITY_COMMENT_TYPES = [
  "proposal",
  "official",
  "jurisdiction",
  "institution",
  "financial_entity",
  "district",
] as const;
export type EntityCommentType = (typeof ENTITY_COMMENT_TYPES)[number];

// ─── Stance (mirrors the entity_comments.stance CHECK; conditional is C1) ─────
export const COMMENT_STANCES = ["support", "oppose", "conditional", "neutral"] as const;
export type CommentStance = (typeof COMMENT_STANCES)[number];

// ─── Status (mirrors the entity_comments.status CHECK) ────────────────────────
export const COMMENT_STATUSES = ["visible", "needs_review", "hidden_by_jury", "withdrawn"] as const;
export type CommentStatus = (typeof COMMENT_STATUSES)[number];

// ─── Initiative lifecycle stages ──────────────────────────────────────────────
export type InitiativeStage = "problem" | "draft" | "deliberate" | "mobilise" | "resolved";

// ─── Kind vocabulary ──────────────────────────────────────────────────────────
export const DEFAULT_KIND = "discussion";

// Human labels (semantic, presentation-neutral). Badge colors live in the UI.
// Lifted verbatim from the legacy ArgumentBoard TYPE_CONFIG labels.
export const KIND_LABELS: Record<string, string> = {
  discussion: "Discussion",
  support: "Support",
  oppose: "Oppose",
  concern: "Concern",
  amendment: "Suggested Change",
  question: "Question",
  evidence: "Evidence / Data",
  precedent: "Precedent",
  tradeoff: "Tradeoff",
  stakeholder_impact: "Who's Affected",
  experience: "My Experience",
  cause: "Root Cause",
  solution: "Proposed Solution",
};

// Full union of every kind any surface can use. Used to validate posts to a
// `proposal` (initiatives ARE proposals, so this must cover every stage kind).
const ALL_KINDS = [
  "discussion",
  "support",
  "oppose",
  "concern",
  "amendment",
  "question",
  "evidence",
  "precedent",
  "tradeoff",
  "stakeholder_impact",
  "experience",
  "cause",
  "solution",
] as const;

// Allowed kinds per entity_type (the API allowlist). The UI may present a
// narrower per-context subset (e.g. initiative stage), but the API accepts any
// kind in this list for the given entity_type.
export const ALLOWED_KINDS: Record<EntityCommentType, readonly string[]> = {
  // Initiatives are proposals — must accept the full union for every stage.
  proposal: ALL_KINDS,
  // Officials get the full typed treatment (decision 4).
  official: ["discussion", "support", "oppose", "concern", "question", "evidence", "stakeholder_impact"],
  jurisdiction: ["discussion", "question", "concern", "evidence", "stakeholder_impact"],
  institution: ["discussion", "question", "concern", "evidence", "stakeholder_impact"],
  // Schema supports these; no UI this PR — keep them minimal but valid.
  financial_entity: ["discussion"],
  district: ["discussion"],
};

// Initiative per-stage vocab, preserved verbatim from the legacy STAGE_TYPES
// (with the implicit `discussion` default made explicit). draft/resolved are
// read-only stages — no composer, hence no kinds.
export const INITIATIVE_STAGE_KINDS: Record<InitiativeStage, readonly string[]> = {
  problem: ["discussion", "experience", "cause", "solution", "question", "evidence", "stakeholder_impact"],
  draft: [],
  deliberate: [
    "discussion", "support", "oppose", "concern", "amendment",
    "question", "evidence", "precedent", "tradeoff", "stakeholder_impact",
  ],
  mobilise: [
    "discussion", "support", "oppose", "concern", "amendment",
    "question", "evidence", "precedent", "tradeoff", "stakeholder_impact",
  ],
  resolved: [],
};

// ─── Flag reasons (mirror the flag_reason enum) ───────────────────────────────
export const FLAG_REASONS = ["spam", "harassment", "off_topic", "misinformation", "other"] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

// ─── C0 rate limits (app-layer, per user per rolling 24h) ─────────────────────
export const RATE_LIMITS = {
  comments: 20,
  ratings: 200,
  flags: 10,
} as const;

// App-enforced maximum reply depth (root = 0).
export const MAX_THREAD_DEPTH = 3;

// Author edit window (minutes) — app-enforced in the PATCH route.
export const EDIT_WINDOW_MINUTES = 15;

// Body length bounds (mirror the entity_comments.body CHECK).
export const BODY_MIN = 10;
export const BODY_MAX = 2000;

// ─── Helpers ──────────────────────────────────────────────────────────────────
export function isEntityCommentType(v: unknown): v is EntityCommentType {
  return typeof v === "string" && (ENTITY_COMMENT_TYPES as readonly string[]).includes(v);
}

export function isAllowedKind(entityType: EntityCommentType, kind: string): boolean {
  return ALLOWED_KINDS[entityType].includes(kind);
}

export function isCommentStance(v: unknown): v is CommentStance {
  return typeof v === "string" && (COMMENT_STANCES as readonly string[]).includes(v);
}

export function allowedKindsForStage(stage: InitiativeStage): readonly string[] {
  return INITIATIVE_STAGE_KINDS[stage] ?? [DEFAULT_KIND];
}

export function kindLabel(kind: string | null): string {
  if (!kind) return KIND_LABELS[DEFAULT_KIND]!;
  return KIND_LABELS[kind] ?? kind;
}
