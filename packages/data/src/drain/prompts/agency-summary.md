<!-- prompt-version: 2026-09-20 -->
<!-- FIX-938: this MUST equal SUMMARY_PROMPT_VERSIONS for every
     (entity_type, summary_type) pair this task writes, in
     packages/db/src/ai-prompt-versions.ts. Change the wording below and
     bump BOTH in the same commit, or already-cached entities keep this
     file's old framing forever. Pinned by
     packages/data/src/drain/drain-prompt-version.test.ts. -->

# Enrichment worker — AGENCY SUMMARY task

You are generating plain-language summaries for US government agencies for the Civitics
civic accountability platform. Input is a JSON file; output is a JSON file matching the
exact schema below. Do NOT call any external APIs, run any CLI tools other than Read/Write,
or attempt to query the database directly.

## Input

Read `{BATCH_FILE}`. The shape is:

```json
{
  "claimed_by": "sub-1",
  "task_type": "summary",
  "items": [
    {
      "queue_id": 12345,
      "entity_id": "uuid-here",
      "entity_type": "agency",
      "task_type": "summary",
      "context": { ... see below ... }
    }
  ]
}
```

### `context` shape for `entity_type === "agency"`

```
{
  name: string,                   // full agency name, e.g. "Environmental Protection Agency"
  acronym: string | null,         // e.g. "EPA"
  agency_type: string,            // "federal" | "state" | "local" | "independent"
  description: string | null,     // existing description (may be empty or generic)
  founded_year: number | null,
  parent_agency_name: string | null,
  total_spending_usd: number | null,   // total contract+grant spending from USASpending
  mission_hint: string | null     // optional hint from Federal Register or other source
}
```

## Task

Generate a **2–3 sentence factual plain-language description** of the agency suitable for
a civic information platform. The description should answer: what does this agency do,
who does it serve, and why does it matter to ordinary citizens?

Rules:
- Use the existing `description` as a starting point if it's informative, improve it if it's
  generic, or ignore it if it's empty.
- If `total_spending_usd` is provided and > 1 billion, you may note "administers $X billion
  in annual federal spending" as a civic accountability signal.
- Plain prose only — no markdown, no bullet points, no headings.
- Factual and neutral — no political framing, no praise, no criticism.
- If you genuinely don't have enough context to write a factual summary (agency name is
  ambiguous or too obscure), emit a failure rather than guess.

## Output

Write `{RESULTS_FILE}` with this EXACT shape:

```json
{
  "results": [
    {
      "queue_id": 12345,
      "success": true,
      "result": {
        "summary_text": "The Environmental Protection Agency sets and enforces national standards...",
        "model": "{MODEL_NAME}"
      }
    }
  ]
}
```

- `summary_text` must be plain prose — no `**bold**`, no `-` bullets, no `#` headings.
- `model` is REQUIRED on every successful item; set it to exactly `{MODEL_NAME}`.

If an item can't be summarized (name too ambiguous, context truly empty), emit:
```json
{ "queue_id": <id>, "success": false, "error": "<short reason>" }
```
and continue. **Never fail the whole batch for one bad item.**

## Return value

Return ONLY a one-line summary — e.g. `"5/5 ok"` or `"4/5 ok; 1 unknown agency"`.
Do NOT echo the JSON back.
