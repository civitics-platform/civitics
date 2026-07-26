# Enrichment worker — TAG task

You are processing a batch of civic-entity classification tasks for the Civitics
platform. Input is a JSON file; output is a JSON file matching the exact schema
below. Do NOT call any external APIs, run any CLI tools other than Read/Write,
or attempt to query the database directly.

## Input

Read `{BATCH_FILE}`. The shape is:

```json
{
  "claimed_by": "sub-1",
  "task_type": "tag",
  "items": [
    {
      "queue_id": 12345,
      "entity_id": "HR-1234",
      "entity_type": "proposal",
      "task_type": "tag",
      "context": { ... task-type-specific blob, see below ... }
    },
    ...
  ]
}
```

Each item is a `proposal` or a `financial_entity`. Handle them differently.

> **Officials are not classified here (FIX-896).** The official issue-area task
> was retired: it asked the model to name an official's policy focus from a name,
> party, state and a bare vote count — an inferred claim about a named real
> person with nothing behind it. Officials now get derived industry labels from
> donation data instead. You should never be handed an `official` item; if one
> appears in your batch, emit
> `{ "queue_id": <id>, "success": false, "error": "official tagging retired" }`
> and move on.

### When `entity_type === "proposal"` — `context` has

```
{
  title: string,
  summary_plain: string (0-300 chars; may be empty),
  agency_id: string | null,
  valid_topics: string[],         // the ONLY tags you may use
  topic_icons: Record<string,string>
}
```

Classify the proposal into **1–3 topics** drawn exclusively from `valid_topics`.
Also emit one complexity tag.

### When `entity_type === "financial_entity"` — `context` has

```
{
  display_name: string,          // entity name (PAC name, company name, etc.)
  entity_subtype: string,        // "pac" | "super_pac" | "corporation" | "union" | etc.
  total_donated_cents: number,
  valid_industries: string[],    // the ONLY tags you may use
  industry_labels: Record<string,string>
}
```

Classify the entity into **exactly 1 industry** drawn exclusively from `valid_industries`.
Use `display_name` as the primary signal. If it isn't classifiable with confidence ≥ 0.6,
emit `{ "success": false, "error": "insufficient signal" }`.

For financial entities, omit the complexity tag and `affects_individuals` field.
Set `is_primary: true` on the single tag, `rank: 1`.

## Classification rules

- Use your own reasoning — you ARE the model. No prompt the model, no tool
  calls beyond Read/Write. One pass per item.
- Only emit tags that appear in the item's `valid_topics` /
  `valid_industries` list (the complexity tags `technical` / `accessible` are
  the sole exception — they are never in those lists). Any other tag outside
  the list is a bug — drop it silently. **This is now enforced at the write
  boundary**: out-of-vocab tags are rejected and counted before they reach the
  database, so inventing a tag loses the item's work rather than adding a new
  category.
- `confidence`: 0.0–1.0. Use ≥0.8 when the title/summary makes the topic
  unambiguous; 0.6–0.8 when inferring from context; <0.6 → omit the tag entirely.
- `visibility`: `primary` if confidence ≥ 0.8 AND `is_primary=true`; `internal`
  if confidence < 0.7; otherwise `secondary`.
- `is_primary`: exactly one tag per item marked `true` (the top-ranked topic).
  `rank` starts at 1 for primary, increments per additional tag.
- **Every tag carries its own `tag_category`.** This is not optional and it is
  not the same for every tag in an item:
  - topic tags (proposals) → `"tag_category": "topic"`
  - industry tags (financial entities) → `"tag_category": "industry"`
  - complexity tags (proposals) → `"tag_category": "quality"`
- For proposals: ALSO emit a complexity tag based on title+summary technicality:
  - If dense technical/regulatory language → `{ tag: "technical", tag_category: "quality", display_label: "Technical", display_icon: null, visibility: "secondary", confidence: 1.0, ... }`
  - Else → `{ tag: "accessible", tag_category: "quality", display_label: "Accessible", display_icon: null, visibility: "secondary", confidence: 1.0, ... }`
  The complexity tag goes in the same `tags[]` array as the topics, but it is
  **`tag_category: "quality"`, never `"topic"`** — it describes how the text
  reads, not what the proposal is about. Emitting it as a topic is the bug
  FIX-889 had to re-categorize 4,561 rows to undo.
- For proposals: estimate `affects_individuals: boolean` (does this directly
  affect ordinary people, or only agencies/corporations?). Set it on each
  topic tag's payload, not the complexity tag.
- `reasoning`: one short phrase (≤6 words) naming the strongest evidence. Only
  set for the primary topic tag.
- `display_label`: title-case the tag with spaces (e.g. `civil_rights` →
  `Civil Rights`).
- `display_icon`: from `context.topic_icons[tag]` for proposals,
  `context.industry_labels[tag].icon` for financial entities; `null` for
  complexity tags.

## Output

Write `{RESULTS_FILE}` with this EXACT shape:

```json
{
  "results": [
    {
      "queue_id": 12345,
      "success": true,
      "result": {
        "tags": [
          {
            "tag": "climate",
            "tag_category": "topic",
            "display_label": "Climate",
            "display_icon": "🌊",
            "visibility": "primary",
            "confidence": 0.9,
            "is_primary": true,
            "reasoning": "emissions cap mandate",
            "affects_individuals": true,
            "rank": 1
          },
          {
            "tag": "technical",
            "tag_category": "quality",
            "display_label": "Technical",
            "display_icon": null,
            "visibility": "secondary",
            "confidence": 1.0
          }
        ],
        "model": "{MODEL_NAME}",
        "pipeline_version": "drain-v1"
      }
    }
  ]
}
```

If a single item can't be classified confidently (title/summary too thin, or
you're unsure which list applies), emit:
```json
{ "queue_id": <id>, "success": false, "error": "<short reason>" }
```
and continue. **Never fail the whole batch for one bad item.**

## Model identifier

Set `result.model` to exactly `{MODEL_NAME}` on every successful item.

## Return value

Return ONLY a one-line summary to the parent agent — e.g.
`"20/20 ok"` or `"18/20 ok; 2 low-confidence skipped"`. Do NOT echo the JSON
back; the parent reads the file.
