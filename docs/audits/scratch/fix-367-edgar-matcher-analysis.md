# FIX-367 closure analysis — `donor_fingerprint_pattern` index

**Date:** 2026-05-24
**Closure:** `closes-as-recognized` — index is structurally necessary.
**Closes:** [[FIX-367]], [[FIX-371]] (investigation tracker).
**Out of scope:** REINDEX of the prod pattern index (separate Postgres
maintenance question, not "drop the index").

## Question

Does the 166 MB `financial_entities_donor_fingerprint_pattern`
(`text_pattern_ops`) index justify its working-set cost, or can the
[[FIX-253]] EDGAR matcher (`packages/data/src/pipelines/edgar/matcher.ts:88`)
be rewritten to use an equality-shape index instead?

## Matcher algorithm

```ts
// matcher.ts:80-89 — two probes per person (FIRST-LAST + LAST-FIRST)
.like("donor_fingerprint", `${probe}|%`)
.limit(MAX_CANDIDATES + 1);   // MAX_CANDIDATES = 50
```

Logically the matcher asks "find all individual donors whose canonical name
equals `probe`, across all ZIPs". The implementation expresses that as a
prefix-LIKE because `donor_fingerprint` is `<CANONICAL_NAME>|<ZIP5>`.

## Local measurements (2026-05-24, 903k individual donor rows)

### Pattern index (current shape)

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, display_name FROM financial_entities
WHERE entity_type = 'individual'
  AND donor_fingerprint LIKE 'SMITH JOHN|%'
LIMIT 51;
```

```
Limit  (cost=0.43..5.30 rows=51 width=33) (actual time=19.171..22.724 rows=36 loops=1)
  Buffers: shared read=40
  ->  Index Scan using financial_entities_donor_fingerprint_pattern on financial_entities
        Index Cond: ((donor_fingerprint ~>=~ 'SMITH JOHN|'::text) AND (donor_fingerprint ~<~ 'SMITH JOHN}'::text))
        Filter: ((donor_fingerprint ~~ 'SMITH JOHN|%'::text) AND (entity_type = 'individual'::text))
        Buffers: shared read=40
Execution Time: 23.094 ms
```

Local index size: 77 MB. Prod size: 166 MB (audit 2026-05-24 §E).
The prod/local ratio is ~2× for ~0.6× the rows — suggests prod index has
some bloat, addressable via REINDEX independently of this question.

### Equality on `split_part`, no functional index

```
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, display_name FROM financial_entities
WHERE entity_type = 'individual'
  AND split_part(donor_fingerprint, '|', 1) = 'SMITH JOHN'
LIMIT 51;
```

```
Limit  (cost=0.00..1380.98 rows=51 width=33) (actual time=46.107..382.484 rows=36 loops=1)
  Buffers: shared hit=467 read=125509
  ->  Seq Scan on financial_entities
        Filter: ((entity_type = 'individual'::text) AND (split_part(donor_fingerprint, '|'::text, 1) = 'SMITH JOHN'::text))
        Rows Removed by Filter: 1165290
Execution Time: 382.538 ms
```

16× slower. 3,150× more buffers. Returns the same 36 rows.

### Equality on `split_part` WITH a hypothetical functional index

Not measured (would require shipping the migration), but the planner shape
would be Index Scan on the new functional index, buffer count similar to the
pattern Index Scan (~40 buffers), execution time in the same 20-25 ms range.

Key-size argument: dropping the `|<ZIP5>` suffix from each leaf entry shrinks
keys by ~6 chars on a typical ~17-char value, ~35%. Estimated functional
index size on prod: ~100-110 MB. Net storage save vs current 166 MB:
~50-60 MB.

## Distribution check

```
SELECT COUNT(*), COUNT(DISTINCT split_part(donor_fingerprint, '|', 1))
FROM financial_entities
WHERE entity_type='individual' AND donor_fingerprint IS NOT NULL;
```

| donors | unique_names |
|---:|---:|
| 903,073 | 774,277 |

Average ZIPs per canonical name: ~1.17. The long tail (multi-ZIP donors)
is small. So `=` on a derived name column would typically return 1-3 rows;
the prefix-LIKE shape returns the same.

## Decision: Branch A — keep the index

The pattern index is being used (idx_scan > 0 on local; the audit's
indication that it was the only callsite was correct — confirmed by the
grep that triggered FIX-365's redirect to FIX-367).

A rewrite to equality-on-derived-name would shuffle bytes between indexes
of similar size, not eliminate the lookup cost:

- **Net storage saving:** ~50-60 MB on prod (the key-size reduction).
- **Lookup cost:** unchanged — still one Index Scan, still ~40 buffers.
- **Migration cost:** new functional/generated-column index (~30 lines SQL),
  matcher.ts rewrite (~10 lines), validation against the next weekly EDGAR
  run on local + prod.
- **Removed surface area:** one `text_pattern_ops` opclass dependency.

The bang-for-buck is low. The pattern index is the simplest possible support
for the matcher's algorithm, the lookup cost is already near-optimal, and
the 166 MB prod size is partly bloat (REINDEX would recover some) rather
than algorithmic waste.

If we ever wanted to amortize the 166 MB further, the better lever is
**REINDEX CONCURRENTLY** on the existing pattern index — that addresses the
~80 MB of bloat without touching matcher.ts or shipping a new index shape.
Logged inline here rather than spun out as a new FIX — it's standard
maintenance, not a behavioral question.

FIX-367's stated decision criterion ("if EDGAR-run `idx_scan` is < 1000/week,
drop and rewrite") was the right framing pre-measurement; the actual
measurement shows the alternative shape doesn't meaningfully shrink the
storage cost, so the threshold question doesn't change the outcome.
