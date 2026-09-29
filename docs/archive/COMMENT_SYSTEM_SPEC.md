# Civic Initiatives — Structured Comment System Spec
_Written 2026-04-17. Pick up from here in a new session._

---

## Background & Motivation

The current `ArgumentBoard` component offers only "For / Against" columns. This works for deliberation-stage initiatives but is wrong for problem-stage ones — you can't meaningfully be "for" or "against" a problem statement. The community needs richer, stage-appropriate input types that guide the right kind of thinking at each phase of an initiative's lifecycle.

This spec defines a structured comment type system that replaces the current For/Against approach while remaining backward-compatible with existing data.

---

## Design Decisions (agreed in session)

1. **All comments can be upvoted** — regardless of type. Vote counts surface the most resonant contributions across all categories.

2. **Comment type is optional** — defaults to untyped (displayed as general "Discussion"). Users can optionally tag their comment with a type before posting. The type selector appears before the textarea and sets the placeholder text to guide the response.

3. **`question` and `evidence` are universal** — available at every stage. Evidence/data can be pertinent to specific solutions or problems, and is always valuable for people researching the issue.

4. **Sentiment is its own type** — `support` and `oppose` are explicit comment types in the deliberate/mobilise stage, not just a binary toggle. This keeps sentiment legible and searchable alongside other comment types.

5. **Child comments (replies) do not have types by default** — replies are responses to a specific comment, not necessarily independent contributions. They can simply be free text, with the option to select a type if wanted. (can be implemented with a 'discussion/default/reply' type if necessary)

6. **UX: type selector first** — user picks a type (or leaves default), which sets the placeholder text, then writes. This forces intentionality and makes the board scannable by type.

7. **Additional types from civic domain included**: `precedent`, `tradeoff`, `stakeholder_impact`.

---

## Comment Type Taxonomy

### Problem Stage
Goal: understand the problem space — ground it in reality, diagnose causes, generate solutions.

| Type | Label | Placeholder |
|------|-------|-------------|
| _(none)_ | Discussion | Share your thoughts on this problem… |
| `experience` | My Experience | Describe how this problem has affected you or others you know… |
| `cause` | Root Cause | What do you think is driving this problem? |
| `solution` | Proposed Solution | What approach could address this? Be specific if you can… |
| `question` | Question | What do we need to understand before we can solve this? |
| `evidence` | Evidence / Data | Share research, statistics, or documented examples relevant to this problem… |
| `stakeholder_impact` | Who's Affected | Describe how this problem affects a specific group or community… |

### Deliberate Stage
Goal: evaluate a specific proposal — build a case for/against, surface concerns, improve the text.

| Type | Label | Placeholder |
|------|-------|-------------|
| _(none)_ | Discussion | Share your thoughts on this initiative… |
| `support` | Support | Make the case for this initiative — why should it move forward? |
| `oppose` | Oppose | Explain your objection — what's wrong with this approach? |
| `concern` | Concern | I support the goal, but I'm worried about… (not full opposition) |
| `amendment` | Suggested Change | Propose a specific edit or addition to the initiative text… |
| `question` | Question | What needs clarification before this can move forward? |
| `evidence` | Evidence / Data | Share research, data, or precedent relevant to this proposal… |
| `precedent` | Precedent | Has this been tried elsewhere? What was the outcome? |
| `tradeoff` | Tradeoff | Acknowledge a cost or downside of this approach, even if you support it… |
| `stakeholder_impact` | Who's Affected | Describe how this proposal would affect a specific group or community… |

### Mobilise Stage
Goal: build support and surface implementation concerns as the initiative gains momentum.

_Same types as Deliberate stage._ The mobilise stage is the same deliberative context — the proposal is fixed, community is evaluating and signing. No new types needed.

### Resolved Stage
Read-only. No new submissions. Existing comments remain visible.

---

## Database Changes

### 1. Add `comment_type` column to `civic_initiative_arguments`

```sql
-- Migration: 20260417_add_comment_type_to_arguments.sql

ALTER TABLE public.civic_initiative_arguments
  ADD COLUMN IF NOT EXISTS comment_type text;

-- No NOT NULL constraint — existing rows stay null (treated as 'discussion')
-- Valid values enforced at the application layer, not DB enum
-- (enum would require ALTER TYPE for every new type — avoid)
```

### 2. Existing data
The existing `side` column (`for` | `against`) stays intact. The mapping at display time is:
- `side = 'for'` + no `comment_type` → rendered as `support`
- `side = 'against'` + no `comment_type` → rendered as `oppose`
- New records always have `comment_type` set; `side` becomes vestigial

### 3. Index
```sql
CREATE INDEX IF NOT EXISTS idx_civic_initiative_arguments_comment_type
  ON public.civic_initiative_arguments(initiative_id, comment_type);
```

### 4. `packages/db/src/types/database.ts`
Add `comment_type: string | null` to the `civic_initiative_arguments` row type.

---

## API Changes

### `POST /api/initiatives/[id]/arguments`

**Request body** — add `comment_type`:
```ts
{
  body: string;           // 10–1000 chars, required
  comment_type?: string;  // optional; validated against stage-allowed types
  parent_id?: string;     // reply to existing argument (no type for replies)
}
```

**Remove** the `side` field from new submissions. Replies still require no type.

**Stage-type gate** (replaces current `deliberate | mobilise` check):

```ts
const ALLOWED_TYPES: Record<string, string[]> = {
  problem:    ["experience", "cause", "solution", "question", "evidence", "stakeholder_impact"],
  deliberate: ["support", "oppose", "concern", "amendment", "question", "evidence", "precedent", "tradeoff", "stakeholder_impact"],
  mobilise:   ["support", "oppose", "concern", "amendment", "question", "evidence", "precedent", "tradeoff", "stakeholder_impact"],
};

// null/undefined comment_type is always allowed (generic discussion)
// Validate that if provided, comment_type is in the allowed list for this stage
```

**Insert**:
```ts
await admin.from("civic_initiative_arguments").insert({
  initiative_id: params.id,
  parent_id: parent_id ?? null,
  comment_type: comment_type ?? null,
  side: null,   // deprecated; kept for DB compat
  body: argBody.trim(),
  author_id: user.id,
});
```

### `GET /api/initiatives/[id]/arguments`

Return `comment_type` in each row. The grouping changes from `{ for: [], against: [] }` to either:
- A flat array sorted by vote_count, or
- A map keyed by `comment_type` (simpler for UI to consume by type)

**Recommended response shape:**
```ts
{
  comments: ArgumentRow[];   // flat, sorted by vote_count desc, then created_at asc
  total: number;
}
```
Let the UI do the grouping by type — easier to filter/sort client-side.

---

## UI / Component Changes

### `ArgumentBoard.tsx` — full redesign

**State:**
```ts
const [comments, setComments] = useState<ArgumentRow[]>([]);
const [activeFilter, setActiveFilter] = useState<string | null>(null); // null = show all
```

**Layout:**
- Header: "Community input" (problem stage) or "Argument board" (deliberate+)
- Filter pills: one per comment type that has ≥1 entry, plus "All" — click to filter the list
- Comment list: single column, filtered by type if a pill is active; sorted by vote_count desc
- Submit form: below the list

**Filter pills** (horizontal scroll on mobile):
```
[All] [Support 4] [Concern 2] [Amendment 1] [Evidence 3] ...
```
Only show pills for types that have at least one comment. "All" always shows.

**`SubmitCommentForm`** (replaces `SubmitArgumentForm`):

```
┌─────────────────────────────────────┐
│ Type: [Discussion ▾]                │
│ (type selector — sets placeholder)  │
│                                     │
│ ┌─────────────────────────────────┐ │
│ │ Textarea (placeholder from type)│ │
│ └─────────────────────────────────┘ │
│                              0/1000 │
│ [Post comment]                      │
└─────────────────────────────────────┘
```

Type selector should be a styled `<select>` or segmented button row (if ≤4 types). On mobile, `<select>` is fine. Show types available for this stage only.

**`CommentCard`** (replaces `ArgumentCard`):
- Type badge in upper-left (color-coded per type — see below)
- Vote buttons (up/down or just up, TBD)
- Timestamp, flag button
- Reply button → inline `ReplyForm` (no type on replies)

**Type badge colors:**

| Type | Color |
|------|-------|
| `support` | emerald |
| `oppose` | red |
| `concern` | amber |
| `amendment` | indigo |
| `evidence` / `precedent` | slate |
| `experience` | sky |
| `cause` | orange |
| `solution` | violet |
| `question` | gray |
| `tradeoff` | pink |
| `stakeholder_impact` | teal |
| _(none / discussion)_ | gray-100 |

---

## Files to Create / Modify

| File | Change |
|------|--------|
| `supabase/migrations/20260417_add_comment_type.sql` | Add `comment_type` column + index |
| `packages/db/src/types/database.ts` | Add `comment_type: string \| null` to arg row |
| `apps/civitics/app/api/initiatives/[id]/arguments/route.ts` | Accept `comment_type`, remove `side`, new stage gate |
| `apps/civitics/app/initiatives/[id]/components/ArgumentBoard.tsx` | Full redesign per spec above |

No other files need changes. The initiative detail page passes `stage` and `currentUserId` to `ArgumentBoard` — that interface stays the same.

---

## Open Questions (decide before coding)

1. **Upvote only, or upvote + downvote?** Current system is upvote-only. Downvotes add noise but can surface low-quality content. Lean: **upvote-only for now**, revisit.
Answer: Upvote only

2. **Should `solution` type on a problem eventually be promotable to a full initiative?** This is the Phase 2 "solutions as first-class objects" vision (Option C from design discussion). For now, solutions are just a comment type. Later, a "Turn this into an initiative" button could appear on `solution`-type comments. Keep this in mind when designing the DB row — the `comment_type` column enables this future path.
Answer: yes, lets create this functionality now as well

3. **Should the resolved stage show a "top arguments" summary?** Could show the 2–3 highest-voted comments of each key type as a summary card. Nice for historical record. Not in scope for this sprint.
Answer: yes, great idea

4. **Does `oppose` need a sub-reason?** E.g. "I oppose because: [wrong approach / unconstitutional / unaffordable / other]". Probably too granular for MVP. Leave as free text.
Answer: optional, but not required
---

## Implementation Order

1. Write migration — 5 min
2. Update `database.ts` types — 5 min
3. Update API route (`POST` + `GET`) — 30 min
4. Redesign `ArgumentBoard.tsx` — 1.5–2h (the bulk of the work)
5. Test: problem stage, deliberate stage, filter pills, reply flow, vote flow

**Estimated total: M (2–4h)**

---

## Notes for Next Session

- Run `supabase migration up --local` after writing the migration before testing
- The current `for/against` data (if any exists in local dev) won't break — it'll render without a type badge (generic discussion style)
- Check `apps/civitics/app/api/initiatives/[id]/arguments/vote/route.ts` and `flag/route.ts` — they reference `argument_id`; no changes needed there
- The `ArgumentBoard` receives `stage` from `initiatives/[id]/page.tsx` — that prop stays unchanged
