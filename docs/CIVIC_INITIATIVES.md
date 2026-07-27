# Civic Initiatives — Feature Tracker

Living status doc for the Civic Initiatives feature. Update as sprints complete.
Full design spec: see `Civic_Initiatives_Design.docx` in the civitics outputs folder.

**Last updated:** 2026-04-11
**Current sprint:** All sprints complete — feature complete

---

## What This Feature Is

A lifecycle-based community platform: citizens draft proposals (Stage 1 — Deliberate),
gather signatures with geographic weighting (Stage 2 — Mobilise), and hold officials
publicly accountable with a mandatory response window (Stage 3 — Hold Accountable).

The core object is a `civic_initiative`. It passes through three stages. Officials
who don't respond within 30 days of hitting constituent thresholds get a permanent
"No Response" on their profile. Silence is data.

---

## Sprint Status

| Sprint | Scope | Status |
|--------|-------|--------|
| 1 | DB migration + core API routes | ✅ Done (2026-04-11) |
| 2 | Create & deliberate UI | ✅ Done (2026-04-11) |
| 3 | Argument board | ✅ Done (2026-04-11) |
| 4 | Quality gate v1 | ✅ Done (2026-04-11) |
| 5 | Mobilise & signatures UI | ✅ Done (2026-04-11) |
| 6 | Official notifications + response window | ✅ Done (2026-04-11) |
| 7 | Responsiveness score on official profiles | ✅ Done (2026-04-11) |
| 8 | Platform integration (graph, follow, proposals) | ✅ Done (2026-04-11) |
| 9 | Quality gate v2 (population-normalised) | ✅ Done (2026-04-11) |
| 10 | Comment submission (regulations.gov integration) | ✅ Done (2026-04-11) |

---

## Tables

Three new tables, created in `supabase/migrations/0033_civic_initiatives.sql`:

- **`civic_initiatives`** — the initiative object (title, body_md, stage, authorship_type, scope, etc.)
- **`civic_initiative_signatures`** — one row per user per initiative; verification_tier: unverified/email/district
- **`civic_initiative_responses`** — one row per official per initiative; response_type: support/oppose/pledge/refer/no_response

Full column definitions: see TASK-11 in `docs/QWEN_PROMPTS.md`.

---

## API Routes (Sprint 1)

| Method | Route | Purpose |
|--------|-------|---------|
| GET | `/api/initiatives` | Paginated list, filterable by stage/scope/tag |
| POST | `/api/initiatives` | Create new initiative (auth required) |
| GET | `/api/initiatives/[id]` | Full detail + signature counts + official responses |
| POST | `/api/initiatives/[id]/sign` | Toggle signature (auth required, mobilise stage only) |
| GET | `/api/initiatives/[id]/signature-count` | Lightweight count for client polling |

---

## Open Design Questions

| Question | Status |
|----------|--------|
| Quality gate normalisation formula (rural vs. urban threshold) | ✅ Resolved (Sprint 9) — step-function tiers by population; scope-level defaults when no jurisdiction linked |
| Moderation: who reviews flagged proposals/arguments? | 🟡 Unresolved — defer to Sprint 4 |
| Official verification (how to confirm staff identity) | 🟡 Unresolved — .gov email domain matching is v1 approach |
| Engagement incentives for responsive officials | 🟡 Unresolved |
| Duplicate initiative detection | 🟡 Unresolved — AI-assist in Sprint 4+ |
| COMMONS token rewards for successful initiatives | 🟡 Deferred to Phase 3 |

---

## Key Design Decisions (Locked)

- **Proposal text is frozen at Stage 2** — once mobilising, only cosmetic/clarifying edits allowed; version history always visible
- **No Response is automatic** — after 30-day window expires, `no_response` is written automatically; not waiting for official acknowledgement
- **Geography coarsened** — `target_district` and `district` on signatures are always district/zip level, never precise coordinates (consistent with platform privacy rule)
- **Signing requires mobilise stage** — can't sign a draft; advances to deliberate then mobilise via quality gate
- **Authorship: individual + community both supported** — community proposals carry higher credibility signal in UI

---

## Sprint 10 — Delivered (2026-04-11)

### Threshold transparency (bonus, Craig request)

Updated `QualityGate.tsx`:
- `ThresholdExplainer` internal component — "How thresholds are set ↓" expandable below signal list.
- Shows the full `TIER_TABLE` (6 tiers, population range → upvotes required → example) when expanded.
- The row matching the current initiative's tier is highlighted in indigo.
- Scope-default note explains the fallback behaviour when no jurisdiction is linked.
- Decision: transparent contextual display on the initiative page beats a separate admin dashboard — makes the rules legible to any visitor without implying they're configurable.

### Comment submission (regulations.gov integration)

New component: `apps/civitics/app/initiatives/[id]/components/InitiativeCommentPanel.tsx`
- `"use client"`, accepts `{ initiativeTitle, initiativeSummary, proposals: CommentableProposal[] }`.
- `isCommentable()` filter: proposal must have `regulations_gov_id` or `congress_gov_url`, and `comment_period_end` must be null or in the future.
- Renders null when no eligible proposals — zero render cost on non-federal initiatives.
- Multi-proposal selector: if multiple linked proposals with open dockets, user picks which to comment on.
- Template pre-populates with initiative title + summary for context; user overwrites as desired.
- Calls `/api/proposals/${proposalId}/comment` (existing Qwen route, reused unchanged).
- Success state: confirmation number (if API key present) or copy+redirect fallback.
- Days-remaining pill on proposals with known deadlines.
- `CommentableProposal` type exported for use in page.tsx.

Updated `apps/civitics/app/initiatives/[id]/page.tsx`:
- `linkedProposalsRes` query extended to include `regulations_gov_id, congress_gov_url, comment_period_end`.
- `linkedProposals` cast to `CommentableProposal[]`.
- `<InitiativeCommentPanel>` rendered in main column when `stage === "mobilise"`, between `ResponseWindowStatus` and `ArgumentBoard`.

---

## Sprint 9 — Delivered (2026-04-11)

New migration: `supabase/migrations/20260411090000_civic_initiatives_sprint9.sql`
- `civic_initiatives.jurisdiction_id UUID REFERENCES jurisdictions(id) ON DELETE SET NULL` — nullable FK for population lookup.

Updated `apps/civitics/app/api/initiatives/_lib/gate.ts`:
- `GATE_CONFIG.UPVOTE_MINIMUM = 10` — floor (no district ever requires fewer).
- `POPULATION_TIERS` — step-function: < 100K → 10, < 500K → 25, < 2M → 50, < 10M → 100, < 50M → 200, 50M+ → 500.
- `SCOPE_DEFAULT_POPULATION` — fallbacks when jurisdiction_id is NULL: local 75K, state 6.5M, federal 335M.
- `computeGate(supabase, id, mobiliseStartedAt, context?)` — added optional `{ jurisdictionId?, scope? }` context param. When jurisdictionId set, fetches actual population from `jurisdictions` table; otherwise uses scope default. Upvote signal's `required` and `description` now reflect the normalised threshold.
- `PopulationContext` type exported: `{ source, population, tier_label }`.
- `GateResult` now includes optional `population_context`.

Updated `gate/route.ts` + `advance/route.ts`:
- Both select `jurisdiction_id,scope` from initiative and pass as context to `computeGate()`.

Updated `QualityGate.tsx`:
- Added `PopulationContext` type.
- Population tier badge shown in gate header: `Small district (< 100K) · estimated` (or actual if jurisdiction linked).
- The upvote signal row already reflects the dynamic threshold via `signal.required` — no further changes needed.

Open design question resolved:
- **Quality gate normalisation formula** → ✅ Step-function tiers, seeded with scope-level defaults; calibrate thresholds with data once live.

---

## Sprint 8 — Delivered (2026-04-11)

New migration: `supabase/migrations/20260411080000_civic_initiatives_sprint8.sql`
- `civic_initiative_follows(id, initiative_id, user_id, created_at)` — UNIQUE(initiative_id, user_id). RLS: select all, insert/delete own.
- `civic_initiative_proposal_links(id, initiative_id, proposal_id, linked_by, created_at)` — UNIQUE(initiative_id, proposal_id). RLS: select all, insert/delete own (author check at API layer).

Graph package (`packages/graph/src`):
- `types.ts` — `initiative` added to NodeType union (ForceGraph v1)
- `index.ts` — `initiative` added to NodeType union + NODE_COLORS (`{ fill: "#ecfdf5", stroke: "#059669" }` — emerald)
- `apps/civitics/app/api/graph/connections/route.ts` — `case "initiative": return "initiative"` added to mapNodeType; initiatives now render correctly when they appear as graph nodes

New API routes:
- `GET/POST /api/initiatives/[id]/follow` — toggle follow; GET returns `{ following, count }` for unauthenticated users (follows: false). Same toggle pattern as upvote/sign.
- `GET/POST /api/initiatives/[id]/link-proposal` — GET returns linked proposals; POST creates or unlinks (`{ proposal_id, unlink?: true }`). Author-only via primary_author_id check. Idempotent insert.

New components:
- `FollowButton.tsx` — star/unstar button with live count; checks state on mount, 401 redirects to sign-in
- `proposals/components/RelatedInitiatives.tsx` — server component showing citizen initiatives linked to a proposal (stage badge, scope, tags, link to initiative)

Updated pages:
- `initiatives/[id]/page.tsx` — follow + linked proposals added to parallel Promise.all; FollowButton added to support card; "Linked legislation" sidebar card shows linked proposal bills
- `proposals/[id]/page.tsx` — related initiatives query added to Promise.all; `<RelatedInitiatives>` rendered above related proposals section

## Sprint 7 — Delivered (2026-04-11)

No migration needed — reads from `civic_initiative_responses` (Sprint 1 table).

New API route:
- `GET /api/officials/[id]/responsiveness` — returns `ResponsivenessData`: responded / no_response / open / total_closed / recent (last 10 windows with initiative title + scope). Exports the `ResponsivenessData` type for reuse.

> **FIX-905 (C2 Wave 1) superseded the grading below.** The A-F letter grade and
> the `response_rate` percentage were removed from the type, the route, the card,
> and the profile: both were public scores on a public profile (which the
> platform is committed against) with no minimum-sample floor, so one unanswered
> window rendered a public "F". The window ledger is unchanged — it is the
> receipts content, and the record was never the problem. Tiered, small-n-
> disciplined responsiveness now comes from `app/lib/engagement.ts` +
> `EngagementBadges`, mounted on the detail page by FIX-906. The grade tiers
> (A ≥90%, B ≥70%, C ≥50%, D ≥30%, F <30%) are recorded here as history only.

New component:
- `officials/components/ResponsivenessCard.tsx` — server component (no `"use client"`):
  - ~~Grade badge (colored ring, A=emerald → F=red)~~ *(removed, FIX-905)*
  - ~~Response rate % + label ("Highly responsive" etc.)~~ *(removed, FIX-905 — now `N of M` closed windows answered)*
  - Progress bar (green = responded, gray = no-response)
  - Stat pills: N responded / N no-response / N open
  - Recent window list: initiative title linked, scope, days remaining or responded date, response type badge
  - "Silence is data" permanence note when no_response > 0
  - Returns null if no windows at all (invisible until relevant)

Updated `officials/[id]/page.tsx`:
- Added `civic_initiative_responses` join query to existing `Promise.all`
- Computed grade/rate/counts server-side using `gradeFromRate()` from route module *(grade/rate removed by FIX-905 — counts only)*
- Quick stats row: `sm:grid-cols-4 → sm:grid-cols-5`, added "Civic responsiveness" StatCell showing ~~`Grade · Rate%`~~ `responded/total_closed` (FIX-905) or open count
- Added `<ResponsivenessCard>` to overview tab (below CareerHistory)

## Sprint 6 — Delivered (2026-04-11)

New migration: `supabase/migrations/20260411060000_civic_initiatives_sprint6.sql`
- `civic_initiative_milestone_events(id, initiative_id, milestone, constituent_count, total_count, fired_at)` — UNIQUE(initiative_id, milestone). Public read, system-only write.

New shared lib:
- `apps/civitics/app/api/initiatives/_lib/milestones.ts`
  - `checkAndFireMilestones(adminClient, initiativeId, totalCount, constituentCount)` — checks thresholds, inserts event rows (idempotent via unique constraint), triggers `openResponseWindows()` for the `response_window` milestone
  - `openResponseWindows()` — creates `civic_initiative_responses` rows for matched officials (scope+state matching, capped at 50), 30-day window, `ignoreDuplicates: true`

Updated `sign/route.ts` (POST only):
- After a toggle, fetches updated counts via `createAdminClient()` and calls `checkAndFireMilestones()` as fire-and-forget (never delays the sign response)

New API route:
- `POST /api/initiatives/[id]/respond` — official response submission. Validates: auth required, initiative is mobilise, official_id exists, window exists + is open + not already responded. `is_verified_staff = email.endsWith('.gov')`. Returns `{ success, official_name, response_type, is_verified_staff }`.

New component:
- `ResponseWindowStatus.tsx` — client component replacing the old inline official responses. Shows:
  - Summary chips: N responded / N open / N no-response
  - Amber notice banner with countdown when windows are open, with "Submit your response →" link for officials
  - Per-row WindowRow: response badge, verified staff tag, open/expired status, days remaining or elapsed, expandable body, permanent record footer note

Updated `[id]/page.tsx`:
- Imports `ResponseWindowStatus` + `ResponseRow` type; replaced old inline response rendering
- Removed now-unused `OfficialResponse` type and `RESPONSE_STYLES` constant (moved into component)

## Sprint 5 — Delivered (2026-04-11)

No new migration or API routes — reuses Sprint 1 infra.

Updated API route:
- `GET /api/initiatives/[id]/sign` — added GET handler; returns `{ signed: boolean }` for the current user (false if unauthenticated). POST toggle unchanged.

New component:
- `SignaturePanel.tsx` — sidebar panel for mobilise-stage initiatives. Replaces the basic stats card.
  - Checks sign state on mount via GET `/sign`
  - Sign/Unsign button (green outline when signed, indigo filled when not)
  - Count grid: total signed + district-verified, updated optimistically then confirmed via polling
  - Polls `signature-count` every 30s for live count updates
  - Milestone ladder (4 steps): 100 total → Listed publicly, 250 constituent → Officials notified, 1000 constituent → 30-day response window, 5000 constituent → Featured on homepage
  - Each milestone shows icon, label, description, value/required, progress bar (hidden when hit, replaced by green ✓)
  - Days mobilising counter in header
  - 401 response redirects to sign-in with `?next=` return path

Updated `[id]/page.tsx`:
- Imports and renders `<SignaturePanel>` in place of the old inline signature stats card

## Qwen Task References

- **TASK-11** — DB migration → `docs/QWEN_PROMPTS.md` ✅
- **TASK-12** — Core API routes → `docs/QWEN_PROMPTS.md` ✅

## Sprint 3 — Delivered (2026-04-11)

New migration: `supabase/migrations/20260411030000_civic_initiatives_sprint3.sql`
- `civic_initiative_arguments` — top-level For/Against args + threaded replies (parent_id)
- `civic_initiative_argument_votes` — one vote per user per argument (toggle pattern)
- `civic_initiative_argument_flags` — one flag per user per argument, with flag_type enum

New API routes:
- `GET /api/initiatives/[id]/arguments` — all args structured as { for: [], against: [] }, with vote_count and replies nested. Top-level sorted by vote_count desc.
- `POST /api/initiatives/[id]/arguments` — create top-level arg or reply; only on deliberate/mobilise initiatives; replies max 1 level deep
- `GET/POST /api/initiatives/[id]/arguments/[argId]/vote` — check/toggle vote on argument
- `POST /api/initiatives/[id]/arguments/[argId]/flag` — flag argument (idempotent)

New component:
- `ArgumentBoard.tsx` — two-column For/Against layout, per-argument vote buttons, reply forms, flag dropdown, SubmitArgumentForm with side toggle. Wired into `/initiatives/[id]` detail page.

## Sprint 2 — Delivered (2026-04-11)

New migration: `supabase/migrations/20260411020000_civic_initiatives_sprint2.sql`
- `civic_initiative_versions` — snapshot of body_md + title before each edit
- `civic_initiative_upvotes` — one row per user per initiative (toggle pattern)

New API routes:
- `PATCH /api/initiatives/[id]` — update title/body/etc (draft/deliberate only; auto-snapshots version)
- `GET/POST /api/initiatives/[id]/upvote` — check/toggle upvote
- `GET /api/initiatives/[id]/versions` — version history list

New pages:
- `/initiatives` — list with stage tabs, scope filter, pagination
- `/initiatives/new` — create form (title, summary, body_md editor, scope, tags)
- `/initiatives/[id]` — detail page: proposal body, upvote, official responses, version history
  - Author inline editor (shown when stage = draft or deliberate)
  - Signature stats sidebar (shown when stage = mobilise)
