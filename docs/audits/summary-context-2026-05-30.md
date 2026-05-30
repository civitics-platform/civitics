# Summary-context coverage audit

**Run:** 2026-05-30 02:02 UTC (session date 2026-05-29) · **Target:** prod (`xsazcoxinpgttgquwvuf`) · read-only
**Script:** `pnpm --filter @civitics/data data:audit-summary-context:prod`
**Raw JSON:** [`summary-context-2026-05-30.json`](./summary-context-2026-05-30.json) (prod) · [`summary-context-2026-05-30-local.json`](./summary-context-2026-05-30-local.json) (local)

This is a **measurement**, not a target-setting exercise. It establishes ground
truth for how much grounding the enrichment *summary* worker actually receives,
to size the follow-on fetch work (Part C of the spec). No assertions about
what coverage "should" be — just what is.

---

## Headline

**No proposal in prod has a real `summary_plain`.** Of 76,932 proposals,
**0** classify as `full_summary` (`summary_plain.length > 100`). 98.1% are
`title_only`; the rest are `truly_empty` (title under 10 chars). The summary
worker is, for every actionable proposal, inferring from title + agency + type
alone — and the context builder it reads even drops the `latest_action` text
that two of the source pipelines *do* store.

This is the low-value-output root cause the spec suspected, confirmed at the data layer.

---

## Coverage table — prod (76,932 proposals)

### By context level (overall)

| context_level | count | share |
|---|---:|---:|
| `full_summary` (`summary_plain` > 100 chars) | **0** | 0.0% |
| `title_only` (title ≥ 10 chars, no real summary) | 75,451 | 98.1% |
| `truly_empty` (title < 10 chars) | 1,481 | 1.9% |
| **total** | **76,932** | 100% |

Sum check: 0 + 75,451 + 1,481 = 76,932 ✓

### By source × context level

| source | total | full_summary | title_only | truly_empty |
|---|---:|---:|---:|---:|
| legistar | 67,286 (87.5%) | 0 | 67,267 | 19 |
| congress_gov | 4,246 | 0 | 2,795 | 1,451 |
| openstates | 3,359 | 0 | 3,356 | 3 |
| regulations_gov | 1,366 | 0 | 1,366 | 0 |
| courtlistener | 667 | 0 | 667 | 0 |
| unknown (no source) | 8 | 0 | 0 | 8 |

Source attribution is via `external_source_refs` (entity_type='proposal'),
falling back to `proposals.primary_source`. 15,164 proposals had no
`external_source_refs` row and were attributed via `primary_source`.

### `full_summary` integrity

| metric | count |
|---|---:|
| `full_summary` rows | 0 |
| `summary_plain` == `title` (exact) | 0 |
| one contains the other (case-insensitive) | 0 |

There is **no title-as-summary pollution** today — because there is no
`summary_plain` at all. The Part B re-gate of `classifyProposalContext` is
therefore *defensive / future-proofing* (it bites only once a source starts
populating `summary_plain` with a title copy), not a fix for present data.

### Local cross-check (73,027 proposals)

Local snapshot agrees: `full_summary` = 0, `title_only` = 72,066,
`truly_empty` = 961. Same shape, same conclusion.

---

## Per-source verdict: what richer text exists, and is it captured?

Legend: **(a)** stored today · **(b)** available at the source API but not
captured · **(c)** unavailable / not reasonably fetchable.

### congress_gov — bills (`congress/bills.ts`, `congress/votes.ts`)
- `summary_plain`: **never written.** The proposal insert record has no
  `summary_plain` field — [bills.ts:110-125](../../packages/data/src/pipelines/congress/bills.ts#L110-L125)
  (single insert) and [bills.ts:249-265](../../packages/data/src/pipelines/congress/bills.ts#L249-L265)
  (batch `buildProposalInsert`). Confirmed by the 0-`full_summary` count.
- `latest_action`: **(a) stored** in `metadata.latest_action`
  ([bills.ts:123](../../packages/data/src/pipelines/congress/bills.ts#L123),
  [:263](../../packages/data/src/pipelines/congress/bills.ts#L263); fed from
  `bill.latestAction.text` at [votes.ts:410](../../packages/data/src/pipelines/congress/votes.ts#L410))
  — **but dropped by `buildProposalSummaryContext`.** This is the Part B win.
- **CRS bill summaries: (b) available, not captured.** Congress.gov exposes
  `/bill/{congress}/{type}/{number}/summaries` returning official CRS
  plain-language summary prose (often multiple paragraphs). The pipeline never
  calls this endpoint. **Highest-value (b) source** — real prose, not a
  one-line action string. ~2,795 actionable congress proposals.

### openstates — state bills (`openstates/index.ts`, `openstates/writer.ts`)
- `summary_plain`: **never written** —
  [writer.ts:318-329](../../packages/data/src/pipelines/openstates/writer.ts#L318-L329)
  (`buildBillProposalInsert`, no `summary_plain`).
- `latest_action`: **(a) stored** in `metadata.latest_action`, sliced to 200
  chars ([index.ts:331](../../packages/data/src/pipelines/openstates/index.ts#L331)).
  Also dropped by the context builder today → Part B win.
- **Bill abstracts: (b) available, not captured.** OpenStates v3 `/bills`
  supports `include=abstracts` (`abstracts[].abstract`). The request
  ([index.ts:118-132](../../packages/data/src/pipelines/openstates/index.ts#L118-L132))
  omits it and `OSBill`
  ([index.ts:66-76](../../packages/data/src/pipelines/openstates/index.ts#L66-L76))
  has no abstract field. **Cheap to capture** — rides existing `/bills` calls,
  no extra requests. Coverage is partial (not every state bill carries an
  abstract). ~3,356 actionable.

### regulations_gov — proposed rules (`regulations/index.ts`, `regulations/writer.ts`)
- `summary_plain`: **never written** —
  [writer.ts:141-153](../../packages/data/src/pipelines/regulations/writer.ts#L141-L153).
- `full_text_url`: **(a) stored** ([writer.ts:151](../../packages/data/src/pipelines/regulations/writer.ts#L151))
  — but it is a URL to the rule PDF/HTM, not extractable text.
- No `latest_action` captured.
- **Abstract / rule text: (b) with a strong caveat.** The list endpoint
  attributes captured ([index.ts:35-49](../../packages/data/src/pipelines/regulations/index.ts#L35-L49))
  exclude any abstract; the document *detail* endpoint exposes a `summary`
  attribute, but for "Proposed Rule" documents it is frequently null — the
  substantive prose lives in the attached PDF behind `full_text_url`. So a
  short summary is (b) (one extra detail call per doc, sparse yield); the real
  text is effectively **(c)** (needs PDF download + extraction). ~1,366 docs.

### courtlistener (`courtlistener/*`)
- Case metadata, not legislation. `summary_plain` never written; no abstract
  source. The title (case caption) is the content. **(c) no separate summary.**
  667 proposals. (Note: `seed-backlog.ts` already filters `% v. %` case names
  out of the summary queue — [seed-backlog.ts:147-154](../../packages/data/src/pipelines/enrichment/seed-backlog.ts#L147-L154).)

### legistar — municipal matters (`legistar/mappers.ts`)
- `summary_plain`: **never written**; no `latest_action` either —
  [mappers.ts:173-202](../../packages/data/src/pipelines/legistar/mappers.ts#L173-L202)
  (`matterToProposalRow`). The descriptive content is the `MatterTitle` (used
  as `title`). Any matter-body text (`MatterEXText` etc.) is not fetched and is
  inconsistently available across Legistar instances.
- **Verdict: (c) — no separate summary text; the title carries the
  description.** **This matters most:** legistar is **87.5% of all proposals**
  and has *neither* `summary_plain` *nor* `latest_action`. The Part B
  `latest_action` widening does **nothing** for legistar — only the prompt
  hardening (forbid inventing beyond provided fields) improves its output.

### federal_register (`federal-register/index.ts`)
- **Skeleton pipeline — inserts 0 rows** ([index.ts:21-39](../../packages/data/src/pipelines/federal-register/index.ts#L21-L39),
  `skipSync(... "not_implemented")`). 0 proposals from this source today →
  **(c) unavailable** at present. When built, the FR `/documents` API returns a
  genuine `abstract` field (strong (b)), but standing up that pipeline is a
  separate effort, out of scope here.

> Note: AI-generated summaries are written to `ai_summary_cache.summary_text`
> ([ai-summaries/index.ts:106](../../packages/data/src/pipelines/ai-summaries/index.ts#L106)),
> **never back to `proposals.summary_plain`**. So even after AI summaries run,
> `summary_plain` stays null and these context-level counts are unchanged. The
> pre-cutover `summary_generated_at` / `summary_model` columns on `proposals`
> are legacy and unused by the current pipelines.

---

## Recommended fetch plan for the (b) sources (drives Part C)

A source-text fetch step is the *real* fix for the title_only problem — NON-AI
but real ingestion work (extra API calls, rate limits). Quantified, ranked by
value ÷ cost:

| Source | Mechanism | Extra cost | Actionable volume | Yield |
|---|---|---|---|---|
| **OpenStates abstracts** | add `include=abstracts` to existing `/bills` call; parse `abstracts[].abstract` | **none** (rides current calls) | ~3,356 | partial (state-dependent) |
| **Congress CRS summaries** | new `/bill/.../summaries` call per bill (batchable, daily nightly, `CONGRESS_API_KEY`) | 1 call/bill | ~2,795 | high (real prose) |
| **Regulations.gov summary** | detail-endpoint `summary` (1 call/doc) | 1 call/doc | ~1,366 | low (often null; real text is PDF) |
| Federal Register abstract | requires building the skeleton pipeline first | full pipeline | 0 today | n/a (separate effort) |

Recommended Part C ordering: **OpenStates abstracts first** (free), then
**Congress CRS summaries** (highest prose yield), then evaluate
regulations.gov. These are filed as a follow-on FIX; **not** implemented in
this pass.

---

## What this audit does NOT cover

- No backfill / write was performed (read-only).
- It does not measure *how good* existing AI summaries are — only the input
  grounding available to produce them.
- The "actionable volume" figures are `total − truly_empty` per source; they do
  not net out proposals already summarized in `ai_summary_cache`.
