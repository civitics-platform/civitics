# Round 3 incremental-rebuild feasibility — 2026-05-25

Investigation that preceded the Round 3 migration (incrementalize
`rebuild_entity_connections_donations()` and `_votes()` on a watermark
of source-table `updated_at`). Captures the substrate gaps surfaced by
local-side reads of `pg_trigger`, `pg_indexes`, and `\d` against
`financial_relationships` / `votes` / `pipeline_state`.

Active env: local Docker (`http://127.0.0.1:54321`). All probes
read-only.

---

## Gap 1 — `set_updated_at()` triggers missing on FR and votes

The 0001 initial schema defined a `set_updated_at()` BEFORE UPDATE
trigger for every major table, including
`financial_relationships_updated_at` ([supabase/migrations/0001_initial_schema.sql:592](../../supabase/migrations/0001_initial_schema.sql#L592))
and `votes_updated_at` ([supabase/migrations/0001_initial_schema.sql:674](../../supabase/migrations/0001_initial_schema.sql#L674)).

The 2026-04-22 shadow→public promotion DROPped the old public
`financial_relationships` and `votes` tables and replaced them with
the shadow-stage1 versions
([supabase/migrations/20260421000005_stage1_05_financial.sql:53](../../supabase/migrations/20260421000005_stage1_05_financial.sql#L53),
[supabase/migrations/20260421000003_stage1_04_votes_meetings.sql:40](../../supabase/migrations/20260421000003_stage1_04_votes_meetings.sql#L40)),
which declare `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()` but
never add the trigger.

Verified against local 2026-05-25:

```sql
SELECT tgname, pg_get_triggerdef(oid)
FROM pg_trigger
WHERE tgrelid IN ('public.financial_relationships'::regclass, 'public.votes'::regclass)
  AND NOT tgisinternal;
-- (0 rows)
```

Net: today, `updated_at` advances on INSERT (column default) but stays
fixed on UPDATE. Every FEC bulk `ON CONFLICT (relationship_type,
from_id, to_id, cycle_year) DO UPDATE` re-aggregates `amount_cents` /
`evidence_count` for an existing donor row without touching
`updated_at`. An incremental rebuild keyed on `updated_at > watermark`
would silently miss those updates.

## Gap 2 — `updated_at` indexes missing on FR and votes

Same root cause. 0001 added `financial_relationships_updated_at` /
`votes_updated_at` btree indexes ([0001:689](../../supabase/migrations/0001_initial_schema.sql#L689),
[0001:672](../../supabase/migrations/0001_initial_schema.sql#L672));
stage1 migrations did not recreate them on the new shadow-derived
tables.

```sql
SELECT indexname, indexdef FROM pg_indexes
WHERE tablename IN ('financial_relationships','votes')
  AND indexdef ILIKE '%updated_at%';
-- (0 rows)
```

Net: even if the trigger existed, `WHERE updated_at > watermark`
against FR's 5 GB heap would seq-scan every run.

## Gap 3 — `public.pipeline_state` shape

The Round 3 prompt assumed the canonical shape from the shadow stage1
migration ([supabase/migrations/20260421000006_stage1_07_queues.sql:105](../../supabase/migrations/20260421000006_stage1_07_queues.sql#L105):
`PRIMARY KEY (pipeline, key)` with `value_text` / `value_int` /
`value_jsonb`). The promote-shadow migration instead TRUNCATEd the
existing public table (0012 shape: `(key)` PK + `value JSONB`) and
DROPPED the shadow version ([20260422000000:244](../../supabase/migrations/20260422000000_promote_shadow_to_public.sql#L244),
[L278](../../supabase/migrations/20260422000000_promote_shadow_to_public.sql#L278)).

Today's `\d public.pipeline_state` returns the old 0012 shape, and
every active caller — `kill_switches.ts`, `platform-usage.ts`,
`auto-trip-evaluator.ts`, `cost-tracker.ts`, `cost-config.ts` —
uses the `(key)` PK with `value JSONB`. Migrating to the
`(pipeline, key)` shape would be a multi-file rewrite, out of
proportion to the rebuild-watermark need.

## Row counts (sizing baseline)

Local 2026-05-25:

| Source set | Rows |
|---|---:|
| `financial_relationships` (donation + ie_support) | 1,906,053 |
| `financial_relationships` total | 1,958,004 |
| `votes` (vote IN ('yes','no','abstain') AND both FKs NOT NULL) | 575,029 |
| `votes` total | 592,596 |

Prod is roughly 2× per the 2026-05-24 IOWait audit (FR donations ~4.1 M,
votes substantive ~900 K).

## Decisions taken

Both confirmed with user before the migration body was written.

1. **Bundle substrate + incremental in one migration.** Add the
   `set_updated_at` trigger and the `updated_at` btree on both FR and
   votes inside the same SQL file that defines `_donations()` /
   `_donations_full()` / `_votes()` / `_votes_full()`. On first apply,
   the trigger starts firing on subsequent UPDATEs; existing rows
   keep their pre-trigger `updated_at = created_at`. The first
   incremental run sees `last_indexed_at IS NULL` and bootstraps as a
   full rebuild, then advances the watermark — the prompt's documented
   NULL-watermark bootstrap path handles this cleanly.
2. **Use the existing `(key)` PK + `value JSONB` shape of
   `public.pipeline_state`.** One row per chunk, key
   `entity_connections_donations` / `entity_connections_votes`, value
   `{"last_indexed_at": "<ISO>"}`. Matches kill_switches /
   platform_plan convention. No schema change to pipeline_state.

## Out-of-scope risks accepted

- **UPSERTs that don't trigger the trigger.** All inserts from
  pipelines go through `ON CONFLICT DO UPDATE`, which fires
  BEFORE UPDATE triggers normally. The trigger sets
  `NEW.updated_at = NOW()` so unless an UPSERT explicitly writes
  `updated_at = <past>`, the trigger wins. Grep'd FEC bulk writer,
  USASpending writer, IRS990 writer — none write `updated_at`
  explicitly. Verdict: trigger will fire reliably. The weekly
  Sunday `_full()` catches any future regression.
- **DELETEs from FR or votes.** The incremental path can't see
  deleted rows. The weekly `_full()` reconciles by re-deriving the
  whole edge set. Acceptable lag: at most 6 days between Sun
  `_full()` runs.
- **Bootstrap full rebuild on first incremental run.** Expected —
  the watermark starts NULL. Same wall-clock as today's full
  rebuild for that one run; subsequent Wednesday runs become
  cheap.

## What this unblocks

The migration plus the script `--mode` flag plus the workflow split
delivers FIX-372 (donations) and FIX-373 (votes), targeting audit
Finding #1 — donations chunk alone is 17.7% of all prod DB time, votes
chunk another 3.5%. Per the audit, incremental rebuild should cut
those two chunks' IO by ~80-95% on Wednesday runs.
