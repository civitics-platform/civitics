# 2026-06-22 — Nightly + rebuild weekend-failure root-cause confirmation

Read-only diagnostic confirming the cause, **per failure**, of the two scheduled
jobs that died over the 2026-06-20→22 weekend. Advances **FIX-589** (prod
statement_timeout audit + costed tier memo); no code fixes, migrations, or prod
writes this session — the only writes produced are this doc + two `fix:add`
bullets (FIX-650, FIX-651).

## Method

- **Read-only.** All prod evidence via SELECT-only `psql` against the postgres
  pooler role (`supabase/.temp/pooler-url` + `SUPABASE_DB_PASSWORD` from
  `.env.local.prod`); no `.env.local` mutation. GHA evidence via `gh run view`.
  (Supabase MCP `execute_sql` was not connected this session → used the documented
  `psql`/`--env-file` read-only fallback.)
- **`data_sync_log` columns were validated against `information_schema.columns`
  before querying** (shape: `id, pipeline, started_at, completed_at,
  rows_inserted, rows_updated, rows_failed, estimated_mb, status, error_message,
  created_at, metadata`) — not assumed from `0001_initial_schema.sql`.
- The two failures are classified **independently** (different jobs, code paths,
  18h apart).
- Priors reused, not re-derived: `2026-05-24-iowait-diagnosis.md`,
  `2026-06-09-read-degradation-audit.md`, `2026-06-14-pipeline-timeout-remediation.md`,
  and the FIX-588/589/590/591 bullets.

---

## 1. Timeline (UTC)

GitHub commit timestamps are PDT (UTC−7); converted to UTC below.

| UTC | Event | Source |
|---|---|---|
| 06-20 06:22–06:59 | **nightly OK** — fec 173s + enrichment 2026s, both `complete` | `data_sync_log` |
| 06-21 ~daytime | **Entity-page N+1 crawl active & UNMITIGATED** (FIX-634…647 cluster) | git log / FIXES |
| 06-21 06:52–08:52 | Sunday nightly `fec-phase` hits its 120-min cap → `failed/reaped_orphan`; enrichment stranded (reaped next day) | `data_sync_log`, run 27896466304 |
| **06-21 11:16–15:17** | **rebuild-entity-connections (full) — CANCELLED at 4h cap** (run 27902571414) | GHA, `data_sync_log` |
| 06-21 17:36 | FIX-634/635 N+1 collapse RPCs land (10:36 PDT) | git log |
| 06-21 22:44 | **FIX-637 per-IP SSR rate-limit lands** (15:44 PDT) — primary crawl mitigation | git log |
| 06-22 00:14 | Craig **manual 2b rebuild** (`run-rebuild-chunks-prod.ts`): donations **1,398,864 edges, ~18min, exit 0** | done.log FIX-640 |
| 06-22 04:33 / 05:25 | FIX-646 / FIX-647 N+1 collapse RPCs land | git log |
| 06-22 07:25–09:00 | Monday nightly `fec-phase` `complete` (~95min, under cap) | GHA, `data_sync_log` |
| **06-22 09:00–11:00** | **nightly `enrichment-phase` — CANCELLED at 2h cap** (run 27936517705) | GHA |

**Crawl overlap (the structural-vs-transient discriminator):**
- The **rebuild window (11:16–15:17 UTC) entirely precedes** every crawl-mitigation
  commit (17:36 UTC onward) → the rebuild ran with the crawl **active and
  unmitigated**.
- The **enrichment window (09:00–11:00 UTC, 06-22) ran 4–10h *after*** the
  rate-limit (06-21 22:44) and all N+1 collapses (by 06-22 05:25) → crawl
  **already mitigated**, yet enrichment still failed the same way.

---

## 2. Per-failure root-cause classification

### Failure A — rebuild-entity-connections full (06-21): **transient crawl I/O contention**

Job `run` started 11:16:42, **cancelled 15:17:06 = exactly 4h00m** → SIGTERM at
the `timeout-minutes: 240` cap (not a thrown error; step "Mark killed if no
completion row" then ran clean). FIX-588 keyset windowing **is live** and worked.

**Cited evidence — the windows succeed, they're just 10× too slow:**

```
[donations] window 1/16 [00000000..10000000) — 284092 edges in 2266.4s   (~38 min)
[donations] window 2/16 [10000000..20000000) — 277741 edges in 3273.9s   (~55 min)
[donations] window 3/16 [20000000..30000000) — 280610 edges in 2927.0s   (~49 min)
[donations] window 4/16 [30000000..40000000) — 279282 edges in 2566.6s   (~43 min)
##[error]The operation was canceled.   (mid-window-5, 4h budget hit)
```
(GHA run 27902571414, step 7)

- No `statement timeout` / `canceling statement` line — each window **completes
  and logs its edge count**. Not a per-statement abort, not a code error.
- **Same code path, 10× slower than the no-crawl baseline.** The FIX-590 bullet
  documents the post-fix 06-14 (pre-crawl) run as windows 1–13 at **~4 min each**;
  here every window from #1 runs ~38–55 min. FIX-590 (autovacuum pause) **and**
  FIX-591 (orphan/cancel self-heal) shipped 2026-06-14 — a week before this run —
  so the structural cliff they fixed was not the cause.
- **The same donations chunk completed cleanly in ~18 min once the crawl was
  mitigated.** done.log FIX-640: the manual `run-rebuild-chunks-prod.ts` (which
  calls the identical `rebuild_entity_connections_donations()` chunk) produced the
  full 1,398,864 donation edges in ~18 min, exit 0, at 06-22 00:14 UTC — after the
  FIX-637 rate-limit.

**Verdict: transient I/O contention from the concurrent unmitigated crawl**, now
mitigated (FIX-634/637/646/647). Not a permanent compute ceiling and not the
structural Sunday-fail pattern that FIX-588/590/591 already addressed.

> **Inference flagged:** the crawl→IO link is inferred from (a) the 10× per-window
> regression vs the pre-crawl baseline and (b) the 18-min clean re-run, **not** from
> a direct Disk-IO-% reading — see §3. A residual structural risk remains: even
> absent a crawl, the windowed full rebuild is one heavy-FEC Sunday from the 4h cap
> (tracked by FIX-588/589); this run does not retire that risk, it just was not its
> cause.

### Failure B — nightly enrichment-phase (06-22): **structural gateway/role-cap statement_timeout cascade**

`enrichment-phase` started 09:00:24, **cancelled 11:00:45 = exactly 2h00m** →
SIGTERM at `timeout-minutes: 120`. (`fec-phase` succeeded first.) Crawl already
mitigated → **not** crawl-transient.

**Cited evidence — a cascade of DB timeouts, same class as the pre-crawl 06-14 incident:**

```
09:01:03  [nightly] refresh_spending_totals warning: canceling statement due to statement timeout
09:01:03  === Rule-based tagger ===
10:37:12  Rule-based tagger fatal error: canceling statement due to statement timeout   ← burned ~96 min
10:37:16  === AI tagger ===
10:50:14  [nightly] tag-ai failed: get_official_bipartisan_stats failed after 5 attempts: upstream request timeout
10:50:14  ═══ AI Summaries Pipeline ═══
11:00:37  ##[error]The operation was canceled.   ← 2h cap, AI Summaries never got compute
```
(GHA run 27936517705, enrichment-phase step 6)

- Three distinct callsites hit the **role(8s) / gateway(100s) statement_timeout
  class**: `refresh_spending_totals` (MV refresh, fails-open warning), the
  **rule-based tagger (consumed ~96 min — ~80% of the 2h budget — then died on a
  statement timeout)**, and `get_official_bipartisan_stats` (the ~100s PostgREST
  gateway cap, retried 5×).
- The terminal SIGTERM is at the 2h cap, but the **driver is the rule tagger's
  96-min burn**, which left AI Summaries no budget.
- `entity_tags` grew **20 MB (2026-05-24) → 2,391 MB / 3.39M rows** — the table the
  rule tagger scans; on 256 MB `shared_buffers` it intermittently blows
  `statement_timeout`.

**Verdict: structural.** Same role/gateway-cap timeout class as the 06-14
pre-crawl incident; a compute-tier bump speeds the underlying scans but does **not**
raise the 8s/100s caps. Filed as **FIX-651** (continuation of FIX-586/587 direct-pg
routing).

**`data_sync_log` corroboration (read-only, prod):**

| pipeline | phase | status | started | dur | note |
|---|---|---|---|---|---|
| nightly_cron | enrichment | `running` | 06-22 09:00:44 | — | SIGTERM'd; not yet reaped (next nightly reaps it `reaped_orphan`) |
| nightly_cron | fec | `complete` | 06-22 07:25:40 | 94.6 min | under cap |
| entity_connections_rebuild | — | `failed` | 06-21 11:17:03 | — | hand-annotated: *"cancelled 2026-06-21 11:17 rebuild; superseded by manual 2b rebuild (run-rebuild-chunks-prod.ts, exit 0)"* |

---

## 3. Disk IO % consumed — the one signal not readable programmatically

`platform_usage_snapshot.payload` tracks **billing/usage** metrics (monthly spend,
storage, egress, `db_size_bytes`, `disk_used_bytes` = disk *fullness*, api_requests)
— **not** the real-time **Disk IO % consumed** (IOPS/throughput-budget) metric. Only
3 snapshots even landed in the two windows (the `*/10` cron drifts to ~1–2.5h gaps,
confirming FIX-327), and none carry IO%.

**ACTION — Craig, please pull these two readings to confirm the IO classification:**
> Supabase dashboard → project `xsazcoxinpgttgquwvuf` → **Reports / Database**
> (or Observability) → **Disk IO % consumed**, plus **CPU** and **RAM**, for:
> 1. **Sun 2026-06-21 11:00–15:30 UTC** (rebuild window) — *expected: pegged near
>    100% by the concurrent crawl; that confirms Failure A as IO-budget exhaustion
>    driven by transient crawl load.*
> 2. **Mon 2026-06-22 09:00–11:00 UTC** (enrichment window) — *expected: high but
>    driven by the pipeline's own scans, with statement_timeouts doing the killing;
>    a non-pegged IO% here would reinforce "role/gateway-cap, not raw IO budget."*

The pg-side evidence already classifies both failures with cited artifacts; the
Disk-IO% reading is **confirmatory**, not load-bearing.

---

## 4. Reconciliation with FIX-589 + prior audits

**Working-set / buffer baseline (read-only, prod, 2026-06-22):**

| Setting | Value | vs 2026-05-24 |
|---|---|---|
| shared_buffers | 256 MB | unchanged (Small tier) |
| effective_cache_size | 768 MB | unchanged |
| work_mem | 3.4 MB | unchanged |
| max_connections | 60 | unchanged |
| overall buffer hit ratio | 87.4% (cumulative; 26.9M block-reads ≈ 210 GB off disk) | up from the 53.9% point-reading, but cumulative-since-restart masks cold-scan misses |

**Top tables (total / indexes / rows):**

| Table | Total | vs 05-24 |
|---|---|---|
| financial_relationships | 4875 MB | ~+600 MB (regrew past the Round-2 drops) |
| entity_connections | 4079 MB | similar size, **but now 70% dead tuples** |
| financial_entities | 2495 MB | flat |
| **entity_tags** | **2391 MB** | **was 20 MB — ~120× growth** (enrichment tagging) |
| votes | 1046 MB | up |

**Two NEW structural findings vs the priors:**

1. **`entity_tags` exploded 20 MB → 2.4 GB.** It is a fourth hot-table member the
   05-24 "12.5 GB top-3 working set" figure does not count. Top-3 today
   (FR+EC+FE) = **11.4 GB**; **incl. entity_tags ≈ 13.9 GB**. The working set has
   **grown**, not shrunk — the cache-starvation case behind FIX-589 is *at least as
   strong* as on 05-24. The rule tagger scans this table → Failure B.
2. **`entity_connections` is ~70% dead tuples with autovacuum stranded OFF**
   (`reloptions … autovacuum_enabled=false`, `autovacuum_count=0`, 5.75M dead /
   2.5M live). A live incident (FIX-591 failure mode) — filed as **FIX-650**. The
   bloat inflates every graph-edge read's page count, compounding cache starvation.

**Effect on the FIX-589 tier-bump case:** *strengthens the cache-starvation
premise* (working set grew) **but neither weekend failure is a clean "needs more
RAM" verdict:** Failure A was crawl-transient (already mitigated), and Failure B is
the role/gateway-cap class that a bigger `shared_buffers` does **not** lift. A tier
bump remains a real reliever for the **request-path** cold-cache timeouts (FIX-503
family / FIX-581) and would speed pipeline scans — it is "would help broadly," not
"would have prevented either failure." **FIX-589 stays OPEN; memo advanced below.**

---

## 5. Finding → FIX map

| Finding | Disposition |
|---|---|
| Failure A: rebuild cancelled via transient crawl I/O contention | **Already mitigated** — FIX-634/635/637/646/647 (crawl). Structural residue tracked by FIX-588 (closed) + **FIX-589** (open). No new FIX for the failure itself. |
| `entity_connections` autovacuum stranded OFF, ~70% dead tuples (live prod state) | **NEW → FIX-650** (🔴 S) — re-enable + VACUUM at low traffic; add the FIX-590 tail to the 2b recovery script; investigate the FIX-591 re-enable gap. |
| Failure B: enrichment statement-timeout cascade (rule tagger / refresh_spending_totals / get_official_bipartisan_stats on the 8s/100s caps) | **NEW → FIX-651** (🟠 M) — route the three callsites to direct-pg / window them (continuation of FIX-586/587). |
| Working-set growth (entity_tags 2.4 GB) strengthens cache-starvation premise | Folds into **FIX-589** (memo below). |
| Reconcile list — not touched this session | FIX-507 (contract-flow MVs), FIX-508 (district geometry snapshot), FIX-447 (CRS backfill schedule), FIX-581 (jurisdictions SSG timeout) — named, no duplicates filed. |

---

## 6. FIX-589 costed compute-tier memo (conditional deliverable)

The decisive IO-budget reading (§3) is pending Craig's dashboard pull, so this memo
is drafted **conditionally** on it confirming IO pressure. The working-set numbers
below are re-measured 2026-06-22.

**Measured constraint:** Pro **Small** — 2 GB RAM / **256 MB `shared_buffers`** /
~1,000 baseline IOPS / 22 MB/s — against a hot working set of **~13.9 GB**
(FR 4.9 + EC 4.1 + FE 2.5 + entity_tags 2.4, the four tables the rebuild +
tagger + graph reads touch). `shared_buffers` covers **~1.8%** of it;
`effective_cache_size` (768 MB) ~5.5%.

| Tier | RAM | ~`shared_buffers` (≈RAM/4) | What it unlocks vs the ~13.9 GB set | Effect on the timeout class | ~$ net/mo |
|---|---|---|---|---|---|
| **Small (current)** | 2 GB | ~256 MB | ~1.8% resident — every cold scan hits disk | binding constraint | baseline |
| Medium | 4 GB | ~512 MB | ~3.7% — 2× buffers, still ≪ working set | marginal; pipelines still time out | ~+$50 |
| Large | 8 GB | ~1–2 GB | hot **indexes** mostly resident; far fewer seq-scan re-reads | request-path cold-cache timeouts ease materially; pipelines faster but caps unchanged | ~+$100 |
| XL | 16 GB | ~4 GB | first tier where the **bulk of the 13.9 GB set** can stay warm | the IO-driven slowness class mostly disappears | ~+$210 |

> Confirm exact $ on the dashboard (Settings → Add-ons → Compute; billed hourly).

**Plain reading:** even **Large does not fully cache a ~13.9 GB working set** —
its ~1–2 GB `shared_buffers` holds the hot *indexes*, not the heaps. **XL (~4 GB
`shared_buffers`) is the first tier that keeps the bulk of the set warm.** And a
tier bump **does not raise the 8s/100s role/gateway caps** — so it would *not*
have prevented Failure B; the direct-pg work (FIX-651, FIX-586/587) is the durable
fix there.

**Recommended disposition of FIX-589:** **stay OPEN, partially advanced.** This memo
is its deliverable; the cost decision is Craig's. Recommended ordering of levers,
cheapest-structural-first:
1. **FIX-650** (re-enable autovacuum + VACUUM entity_connections) — free, immediate,
   shrinks the working set and the graph-read IO. Do this regardless.
2. **FIX-651** (direct-pg the three enrichment callsites) — fixes Failure B at the
   cap, no recurring $.
3. **Compute tier** — only after 1+2, and only if the §3 Disk-IO% reading + the
   request-path timeouts (FIX-503/581) still justify it. If chosen, **Large** for the
   request path; **XL** only if the full set must stay warm.

---

## Verification footer

- All prod probes were SELECT-only against `pg_settings`, `pg_class`,
  `pg_stat_database`, `pg_stat_user_tables`, `information_schema.columns`,
  `data_sync_log`, `platform_usage_snapshot`. No INSERT/UPDATE/DELETE/ALTER/
  VACUUM executed. `.env.local` was not mutated.
- `data_sync_log` columns validated against `information_schema` before querying
  (§Method).
- Both windows checked for crawl overlap (§1) so the transient (Failure A) vs
  structural (Failure B) split is grounded in commit timing, not assumed.
- Every root-cause line cites a concrete artifact (GHA log line, `data_sync_log`
  row, `pg_class.reloptions`, or done.log entry). The only inference — the
  crawl→IO link for Failure A — is flagged as inference in §2 and gated on the
  §3 Disk-IO% reading.
