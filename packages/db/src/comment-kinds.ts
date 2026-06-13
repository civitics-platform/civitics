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
// NOTE (C1 / FIX-526): 'support'/'oppose' were REMOVED as kinds — stance is the
// canonical axis now (see COMMENT_STANCES). The labels are retained only so any
// pre-normalization historical row still renders a friendly label.
export const KIND_LABELS: Record<string, string> = {
  discussion: "Discussion",
  support: "Support",
  oppose: "Oppose",
  concern: "Concern",
  amendment: "Suggested Change",
  question: "Question",
  // C1 Wave D (FIX-536): official answer in the Q&A lane. Never user-selectable
  // — set by the answer action and gated by RLS (decision 11).
  answer: "Official response",
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
// 'support'/'oppose' are NOT kinds (C1 / FIX-526) — they live in stance.
const ALL_KINDS = [
  "discussion",
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
  // Officials get the full typed treatment (decision 4). Support/oppose are a
  // stance now, not a kind (C1 / FIX-526). C1 Wave D (FIX-536): 'answer' is the
  // official Q&A response — API-valid for officials but NEVER offered in any
  // composer's selectable list (set by the answer action, gated by RLS to
  // 'official' grant holders; decision 11).
  official: ["discussion", "concern", "question", "evidence", "stakeholder_impact", "answer"],
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
  // C1 / FIX-526: support/oppose are expressed via stance (stanceEnabled), not kind.
  deliberate: [
    "discussion", "concern", "amendment",
    "question", "evidence", "precedent", "tradeoff", "stakeholder_impact",
  ],
  mobilise: [
    "discussion", "concern", "amendment",
    "question", "evidence", "precedent", "tradeoff", "stakeholder_impact",
  ],
  resolved: [],
};

// ─── Flag reasons (mirror the flag_reason enum) ───────────────────────────────
export const FLAG_REASONS = ["spam", "harassment", "off_topic", "misinformation", "other"] as const;
export type FlagReason = (typeof FLAG_REASONS)[number];

// ─── Per-user daily caps (app-layer, per user per rolling 24h) ────────────────
// comments/answers are enforced in submit_comment (FIX-542 split: the comments
// cap counts only non-answer rows; kind='answer' posts — answer-gate holders
// only — have their own cap). positions/statement_votes (FIX-569) close the two
// formerly-uncapped aggregate-skewing write paths (set_entity_position /
// set_statement_vote): a single account could otherwise set a stance on every
// entity and vote on every statement → direct aggregate skew. All caps are
// MIRRORED into the RPC migrations (20260609000000 / 20260610000100 for
// comments+answers; 20260613000000 for positions+statement_votes) and guarded by
// the FIX-543 drift test.
export const RATE_LIMITS = {
  comments: 20,
  answers: 100,
  ratings: 200,
  flags: 10,
  positions: 60, // plain set_entity_position sets/day (delta attribution keeps DELTA_DAILY_CAP)
  statement_votes: 200, // set_statement_vote ballots/day (cheap one-tap input; matches ratings)
} as const;

// ─── C1 position-spine constants (FIX-523) ────────────────────────────────────
// Mirrored in supabase/migrations/20260607060000_entity_positions_spine.sql.
// Kept here so Wave B (bridge scorer) reads the same values.
// Below this many positions, get_entity_position_rollup() returns NULL aggregates
// (n only) — small-n medians presented as "the community's view" discredit the metric.
export const MIN_POSITIONS_FOR_ROLLUP = 10;
// Max attributed (delta) position-change events per user per rolling 24h.
export const DELTA_DAILY_CAP = 5;
// Minimum account age (days) before a user may attribute a position change to a comment.
export const MIN_ACCOUNT_AGE_DAYS = 7;

// ─── FIX-569 progressive new-account trust (INTERNAL — never shown publicly) ──
// Reuses the MIN_ACCOUNT_AGE_DAYS precedent; this is NOT a karma score or a
// public tier (brand rule #3). A "new" account is younger than
// NEW_ACCOUNT_AGE_HOURS: while new it gets HALVED daily caps (newAccountCap) and
// must pass a Turnstile challenge on its first writes. The challenge tapers once
// the account is no longer new OR has accrued ≥ NEW_ACCOUNT_MIN_ACTIONS actions
// (see requiresChallenge in apps/civitics/src/lib/turnstile.ts). The SQL caps
// (set_entity_position / set_statement_vote, 20260613000000) key the halving on
// ACCOUNT AGE alone — one cheap created_at read on the write path; the
// action-count lower bound is applied only in the app-layer challenge predicate,
// not the hot RPC. Mirrored as literals in that migration.
export const NEW_ACCOUNT_AGE_HOURS = 24;
export const NEW_ACCOUNT_MIN_ACTIONS = 5;

// Halve a daily cap for a new account, flooring at 1 so a cap never hits 0.
export function newAccountCap(cap: number): number {
  return Math.max(1, Math.floor(cap / 2));
}

// App-enforced maximum reply depth (root = 0).
export const MAX_THREAD_DEPTH = 3;

// Author edit window (minutes) — app-enforced in the PATCH route.
export const EDIT_WINDOW_MINUTES = 15;

// Body length bounds (mirror the entity_comments.body CHECK).
export const BODY_MIN = 10;
export const BODY_MAX = 2000;

// ─── C1 Wave C statement-mode + slow-mode constants (FIX-533/534/535) ──────────
// Mirrored in supabase/migrations/<ts>_statement_mode.sql. Straw values — tune in
// code, not in a migration. Statements are the Polis-lite agree/disagree/pass
// primitive; slow mode promotes them when an entity's comment velocity spikes.
//
// Statement body length bounds (mirror the entity_statements.body CHECK 10..200).
export const STATEMENT_MIN_LEN = 10;
export const STATEMENT_MAX_LEN = 200;
// Max statements a user may submit per rolling 24h (enforced in submit_statement).
export const STATEMENT_SUBMIT_DAILY_CAP = 5;
// Comment-creation velocity (rolling 1h counter) that trips slow mode for an entity.
export const SLOW_MODE_COMMENTS_PER_HOUR = 20;
// How long slow mode stays on after a trip (derived expiry: slow_mode_until = now()+this).
export const SLOW_MODE_DURATION_HOURS = 2;

// Statement vote vocabulary: agree / pass / disagree → +1 / 0 / -1.
export const STATEMENT_VOTES = [-1, 0, 1] as const;
export type StatementVote = (typeof STATEMENT_VOTES)[number];
export function isStatementVote(v: unknown): v is StatementVote {
  return v === -1 || v === 0 || v === 1;
}

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
