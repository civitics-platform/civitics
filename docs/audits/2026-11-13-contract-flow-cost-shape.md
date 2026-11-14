# Contract-flow's cost shape — one pass, both rollups derived (FIX-1384, cc-280, 2026-11-14)

**Decision (Craig, Fri 11-13 21:59 PST, "recs good"):** Cowork's design D1–D8.
Read the contract rows once into a stage table and derive both rollups from it.
No chunks, no new index, no skip yet. The registry row, the START gate and the
two SET lines stay as they are. Design of record:
`design-fix1384-contract-flow-one-pass-stage-2026-11-13` (Cowork project),
restated in cc-280's prompt.

**Answer.** Prod's own plan confirms the premise. The agency × sector statement is
a nested loop over `financial_relationships_agency_spend_lateral`, planned on 46
rows, and the CALL reads **4,653,478 shared blocks a call** (the prompt expected
more than 2.96 M). The stage pass alone on prod is **136.7 s and 390,630 reads**:
a HashAggregate in one batch, with no sort and no temp. The one-pass body
(`20261116000000`, md5 `e19b470b…`) was pushed **2026-11-14 23:51:00Z**. Its
receipt is the Thu 11-19 14:00Z dispatched run.

**Prod contact.** Read-only `node scripts/db-query.mjs --prod`. Reads 2–7 took
nine statements, 23:20:43–23:26:04Z. Read 6 was the one heavy statement, run
after its preconditions were read clear. There was one class-P push and its
read-back, plus one `pg_settings` read for the vacuum note. Nothing was
CALLed on prod.

---

## §1 The clone — Cowork's table and this run's reproduction

Cowork, 11-13. `EXPLAIN (ANALYZE, BUFFERS)` on the local clone, at the body's own
settings (work_mem 64MB, parallel 0, hash_mem_multiplier 1, a 128 MB pool):

| clone | shared read | temp pages | wall |
|---|---:|---:|---:|
| recipients statement (through `treemap_recipients_by_contracts_full(500)`) | 309,903 | 16,835 | 4.3 s |
| agency × sector statement | 3,004,711 | 147,000 | 60.3 s |
| both, today | 3,314,614 | 163,835 | |
| one stage pass + both rollups derived from it | 330,538 | 32,990 | 8.8 s |

cc-280, 11-14, whole CALLs on the clone (`--call`, START gate handled as §8 says):

| clone CALL | wall | `stage_seconds` {stage, recipients, agency_sectors} |
|---|---:|---|
| M3 body (`c699dc7d…`), cold | 193.4 s | — |
| one-pass body (`e19b470b…`), first run | 40.0 s | 17.2 / 20.4 / 2.4 |
| one-pass body, second run (warm) | 15.9 s | 13.3 / 1.1 / 1.5 |

The first run's 20.4 s for recipients is cold `financial_entities` lookups
(63,777 index probes). The two derived SELECTs run standalone take
0.94 s (shared read 41,042) and 1.81 s (shared read 28,924). The second is now
planned on 163,501 rows, not 58.

## §2 Read 2 — the body and the row (prod, 23:20:43Z)

- `md5(prosrc)` of `refresh_contract_flow_rollups` = `c699dc7d6acf1cf35a3164b71ec0a3aa`
  (M3, as expected). `to_regclass('public.contract_flow_stage')` NULL.
  `ec_arm_source_fingerprint(text)` present.
- `job_registry` `contract-flow-rollups-refresh`: `by 0 14 * * 4`, budget 9000,
  group `mvs`, cap 64, `atomic`, `cost_class memory`, gates `{prod_session}`.
- The newest three `contract_flow_rollups_rebuild` rows were all `complete`,
  500 / 1,201:

  | started | wall |
  |---|---:|
  | 11-12 14:03:00Z | 3,049.3 s |
  | 11-05 14:03:00Z | 2,995.0 s |
  | 11-01 00:21:00Z | 2,791.6 s |

## §3 Read 3 — today's agency × sector plan (prod, plain `EXPLAIN`, 23:21:01Z)

Run at work_mem 64MB, parallel 0, hash_mem_multiplier 1. The plan's spine:

```
GroupAggregate  (cost=48685.96..48690.33 rows=46 width=123)
  ->  Sort  (rows=46)
        ->  Merge Right Join  (rows=46)   Merge Cond: ("*SELECT* 1".entity_id = fe.id)
              ->  Merge Append  (rows=91534)            -- primary_industry_tag(NULL)
              ->  Sort  (rows=46)   Sort Key: fe.id
                    ->  Nested Loop Left Join  (rows=46)
                          ->  Nested Loop  (rows=46)
                                ->  Seq Scan on agencies a  (rows=137)
                                ->  Index Scan using financial_relationships_agency_spend_lateral on financial_relationships fr  (rows=1)
                                      Index Cond: ((from_id = a.id) AND (amount_cents > 0))
                                      Filter: (relationship_type = 'contract'::financial_relationship_type)
                          ->  Index Only Scan using financial_entities_pkey on financial_entities fe
```

This is the nested loop the design describes. It is planned on **46** rows
(clone: 58), and read 6 counts the real number as **4,332,843**. Every contract
row is fetched through the `(from_id, amount_cents DESC)` index, one heap block
at a time, in amount order.

## §4 Read 4 — the stage's plan (prod, plain `EXPLAIN`, 23:21:02Z)

```
HashAggregate  (cost=1103965.85..1285754.10 rows=2975873 width=130)
  Group Key: from_id, from_type, to_id, to_type, (metadata ->> 'naics_code'::text)
  Planned Partitions: 16
  ->  Bitmap Heap Scan on financial_relationships fr  (rows=4388805)
        Recheck Cond: ((relationship_type = ANY ('{contract,grant}')) AND (relationship_type = 'contract'))
        Filter: (amount_cents > 0)
        ->  BitmapAnd
              ->  Bitmap Index Scan on financial_relationships_contract_grant_updated_at  (rows=5083859)
              ->  Bitmap Index Scan on financial_relationships_type  (rows=4388981)
```

This is a bitmap scan, so it is not a STOP: no index returns rows in key order.
Prod's plan differs from the clone's in two ways:

- It uses a HashAggregate, where the clone sorts and then runs a GroupAggregate.
- The bitmap is a BitmapAnd of the FIX-1118 partial index with `…_type`, not
  `…_type` alone.

## §5 Read 5 — `pg_stat_statements` (prod, 23:21:12Z)

`stats_reset` 2026-10-25 13:25:52Z. `CALL public.refresh_contract_flow_rollups()`
as `postgres`:

| calls | shared read | shared hit | temp written | mean |
|---:|---:|---:|---:|---:|
| 3 | 13,960,433 | 50,607,026 | 583,593 | 2,945.3 s |
| per call | **4,653,478** | 16,869,009 | 194,531 | |

That is 1.57× the 2.96 M a call in the 10-09 census
(`2026-10-09-work-mem-allowance-census.md` §2). It is 1.40× the clone's
3,314,614 for both statements, and prod's contract rows are 1.32× the clone's.
Far above the 1,000,000 STOP bar.

## §6 Read 6 — the pass itself (prod, `EXPLAIN (ANALYZE, BUFFERS)`, 23:22:36.9 → 23:24:53.6Z)

Preconditions, all read clear before the statement:

| precondition | reading | at |
|---|---|---|
| `held` | `held=false` | 23:21:22Z |
| `job startup timeout` in 3 h | 0 | 23:22:04Z |
| ring load1 > 8 in 3 h | 90 samples 20:22–23:20Z, max load1 2.17 | 23:21:35Z |
| `box.io` hold | `throttle_until` null, `busy_streak` 0 | 23:22:04Z |
| contract-flow `running` | 0 (no `running` row of any pipeline in 6 h) | 23:22:04Z |
| clock | Saturday | — |

How the file was sent: `db-query.mjs` reads the `--file` and pipes it on STDIN
to `psql -v ON_ERROR_STOP=1 --single-transaction`. It first sends the prelude
`SET LOCAL max_parallel_workers_per_gather = 0; SET TRANSACTION READ ONLY;`.
The file then ran `SET LOCAL statement_timeout = '1800s';` as its own statement,
then `SET LOCAL work_mem = '64MB';`, then the EXPLAIN.

```
HashAggregate  (cost=1103965.85..1285754.10 rows=2975873 width=130) (actual time=136535.971..136643.208 rows=203314 loops=1)
  Group Key: from_id, from_type, to_id, to_type, (metadata ->> 'naics_code'::text)
  Planned Partitions: 16  Batches: 1  Memory Usage: 59409kB
  Buffers: shared hit=1 read=390630 written=1
  ->  Bitmap Heap Scan on financial_relationships fr  (actual time=10104.450..131163.368 rows=4332843 loops=1)
        Filter: (amount_cents > 0)
        Heap Blocks: exact=375707
        Buffers: shared hit=1 read=390630 written=1
        ->  BitmapAnd  (actual time=9896.750..9896.751 rows=0 loops=1)
              Buffers: shared hit=1 read=14923
              ->  Bitmap Index Scan on financial_relationships_contract_grant_updated_at  (actual rows=5008467)  Buffers: shared read=8002
              ->  Bitmap Index Scan on financial_relationships_type  (actual rows=4332843)  Buffers: shared hit=1 read=6921
Execution Time: 136679.584 ms
```

**136.7 s, 390,630 shared reads (11.9× fewer than a call today), no sort, no
temp.** The aggregate fit in one batch at 59,409 kB, under the 64 MB work_mem.
It returned 203,314 groups (planned 2,975,873) from 4,332,843 rows. The
375,707 heap pages were read in physical order at ~22 MB/s. The 2.96 M-read
call today averages 12.8 MB/s on random reads.

**Headroom.** The hash is at 91 % of work_mem. Past 64 MB it spills to its 16
planned partitions: it gets slower, but it does not fail.

## §7 Read 7 — the source and the totals (prod, 23:25:10.9 → 23:26:04.7Z)

- `ec_arm_source_fingerprint('rebuild_entity_connections_contracts')` =
  **`n=5008467;t=2026-10-11 09:39:05.324534+00`** (contract + grant rows).
- `max(updated_at)` over `relationship_type = 'contract'` =
  2026-10-10 23:59:27.652384Z. A plain `EXPLAIN` showed an Index Scan Backward
  on `…contract_grant_updated_at` with LIMIT 1 answers it. The fingerprint's
  `t` is later because it also covers grants.
- `contract_recipient_rollup`: 500 rows, `SUM(total_cents)`
  **252,560,706,525,410**, `SUM(award_count)` **1,304,540**.
- `contract_agency_sector_rollup`: 1,201 rows, **279,014,647,583,490**,
  **4,332,843**. This award count equals read 6's contract-row count exactly.

**The fingerprint costs ~53 s on prod.** The statement took 54 s, and a plain
`EXPLAIN` shows the fingerprint's `count(*), max(updated_at)` is an Index Only
Scan over all 5,008,467 entries of the FIX-1118 partial index. The body reads it
on every run (D4), inside `stage_seconds.stage`. On the clone it took ~16 s cold
and under 0.4 s warm.

## §8 The equality proof (clone, 11-14 23:27–23:36Z)

**Order.** The M3 body was CALLed first (complete, 500 / 1,136, 193.4 s) and both
rollup tables were copied to two scratch tables. Then the migration was applied:
twice through `db-query --local --file`, then `supabase migration up --local`
(head 20261116000000, 561). Then the one-pass body was CALLed (complete, 500 /
1,136, 40.0 s).

**The START gate on the clone.** The prompt expected a stale stamp. The clone's
`*/1` probe is live: `box_health` was 48 s old and `box_is_saturated()` read
`clear`. Each CALL file still did what `dispatcher-r10.test.ts`'s fixture does.
It re-stamped `box_health.at` at the DB clock, keeping the probe's readings, and
it ran `SET civitics.box_gate_wait_max_s = '0'`, so a saturated reading would
skip in 0 s, not wait 1,800 s. Neither run carried a `gate` key.

**`EXCEPT ALL`, both directions, against the M3 body's tables:**

| table | new − old | old − new | rows | `SUM(total_cents)` | `SUM(award_count)` |
|---|---:|---:|---:|---:|---:|
| `contract_recipient_rollup` | 0 | 0 | 500 = 500 | 240,661,281,139,119 both | 844,070 both |
| `contract_agency_sector_rollup` | 0 | 0 | 1,136 = 1,136 | 258,993,086,037,705 both | 3,277,322 both |

The columns compared exclude the identity `id` and `updated_at`. The new test
file's clone case repeats the proof against the two `_full()` functions, inside
`BEGIN … ROLLBACK`, both directions: 0 / 0 / 0 / 0, equal sums, 60.7 s.

**The stage.** 163,501 rows: 66 agencies, 63,777 recipients, 1,051 NAICS codes,
**1,092** rows with a NULL code (Cowork's note says 1,977), 3,277,322 awards,
258,993,086,037,705 cents.

**The `complete` row's metadata, verbatim:**

```json
{"staged": 163501, "recipients": 500, "stage_seconds": {"stage": 17.2, "recipients": 20.4, "agency_sectors": 2.4}, "agency_sectors": 1136, "source_fingerprint": "n=3859861;t=2026-10-10 20:51:59.768768+00"}
```

The state gained `staged` 163501, `source_fingerprint` (as above) and
`stage_checksum` `1c87f176f27cf5e0c121953ac22f9f3a`. An independent recompute of
the same formula over the stage gave the same md5. A second CALL on the same
fingerprint gave the same checksum (D4's premise, one run deep).

**Cancel.** Connection A CALLed the body. Connection B saw A take the stage's
relation lock at +368 ms and sent `pg_cancel_backend(A)` at +1,926 ms. The CALL
returned at +1,951 ms: the cancel was swallowed, as M3 does. The row closed:

```json
{"status":"failed","error_message":"canceled — contract_flow_stage: canceling statement due to user request","metadata":{"canceled":true,"cancel_detail":"contract_flow_stage: canceling statement due to user request","elapsed_seconds":2,"stage_in_flight":"contract_flow_stage"}}
```

The stage checksum, an md5 of each rollup's rows (with `updated_at`) and the
state value were all identical before and after. A held no advisory lock after.

## §9 Read 1 — the routines that name both `financial_relationships` and `agencies` (clone)

The clone has **ten**, not nine: `get_jurisdiction_page_live` is the tenth. Each
routine, and whether it joins every agency to FR with no LIMIT and no per-agency
bound:

| routine | unbounded? | how it reads |
|---|---|---|
| `agency_staffing_rebuild_agencies` | no | aggregates FR per chunk, `fr.from_id = ANY (p_agencies)`, then joins `agencies` on the same array |
| `chord_contract_flows_full` | **yes** | every agency × every contract row: the break-glass copy of the statement this FIX replaces |
| `ec_arm_source_fingerprint` | no | no join: one `count(*), max(updated_at)` per arm, FR and `agencies` in separate arms |
| `get_agency_page_live` | no | one agency (`from_id = p_id`), `LIMIT 100` on the spend index |
| `get_drift_source_presence` | no | no join: `EXISTS` probes |
| `get_jurisdiction_page_live` (not in Cowork's list) | no | ≤ 300 agency institutions, a per-agency `LATERAL … LIMIT 100`, then `LIMIT 100` |
| `get_official_page` | no | the global top 10 contracts / grants by amount, `LEFT JOIN agencies` per row, `LIMIT 10` |
| `investigation_citation_target_exists` | no | point `EXISTS` by id |
| `refresh_agency_staffing_rollup` | no | chunks of agency ids through `agency_staffing_rebuild_agencies` |
| `refresh_contract_flow_rollups` | **was yes** | the agency × sector statement. Since 20261116000000 it reads the stage instead |

None of these is fixed here; that is out of scope. `chord_contract_flows_full()` is
only the readers' fallback before bootstrap. On prod the readers serve the rollup.

## §10 The bar for Thursday 11-19

The Thu 11-19 14:00Z dispatched run checks:

- **Wall:** at or under max(600 s, 2 × read 6's 136.7 s) = **600 s**.
- **Totals:** if `source_fingerprint` still equals `n=5008467;t=2026-10-11 09:39:05.324534+00`,
  the two rollup tables' counts and sums equal §7's.
- **Reopen:** above **900 s**, or an `io_throttled` hold during the run, reopens
  FIX-1384 for the ctid-range chunks (D3).
- **Vacuum:** the stage's `n_dead_tup` / `last_autovacuum` a day later.

Each run DELETEs about 203 k stage rows. Prod's autovacuum is at the defaults
(`autovacuum_vacuum_scale_factor` 0.2, threshold 50, read 23:52:15Z), so the
trigger is ~40.7 k. Each week's dead rows are ~5× that, so autovacuum takes the
stage after every run, and no vacuum row is needed.
