# FIX-1231 Pattern B — the first real grant sweep (2026-09-27 02:00 UTC)

cc-163 D5. Three receipts read after 02:20 UTC on 2026-09-27, all on **prod**:
FIX-1231's first real `expire_lapsed_grants` run, FIX-1226's durability after the
09-26 fixed-writer PAC pass, and jobid 55's first scheduled firing. Every figure
names its instrument; every prod read below was read-only (`scripts/db-query.mjs
--prod`, which wraps the SQL in `SET TRANSACTION READ ONLY`) or a Logs API read.

## 1. FIX-1231 — `expire_lapsed_grants` reached the database

FIX-1231 was filed by cc-161: `rpc/expire_lapsed_grants` reached the gateway on
**none** of the seven nights in retention (09-20 → 09-26), because Next 14 served
the empty-body POST from the Data Cache. FIX-1214 (`d958e002`, live 20:53 UTC
09-26) gave nightly-sync `noStoreFetch`. This is the first firing after it.

### (i) The gateway (rule 167: proven per RPC at the gateway, not by the route's own rows)

One `edge_logs` read, Logs API, window `[02:00:00, 02:12:00)` UTC, read at
02:21:19 UTC. Paths matched: `rpc/expire_lapsed_grants`, `rest/v1/pipeline_state`,
`rest/v1/data_sync_log`. The nightly-sync rows:

| UTC | method | status | path | what |
|---|---|---|---|---|
| 02:00:37.336 | POST | 200 | `/rest/v1/pipeline_state?on_conflict=key` | control — the route's `pipeline_state` upsert |
| 02:00:37.473 | POST | 201 | `/rest/v1/data_sync_log` | control — the `nightly-sync` / `dispatched` row (id `edd40f58…`, `started_at` 02:00:37.318) |
| **02:00:37.599** | **POST** | **200** | **`/rest/v1/rpc/expire_lapsed_grants`** | **the sweep** |

So "the route fired" (the two controls) and "the sweep reached the DB" (the RPC
row) are separate facts, and both hold. Exactly one gateway row for the RPC.
The other 20 rows in the window are dashboard/status GETs of `pipeline_state` and
`data_sync_log` (GET, 02:00:02–02:01:24) and one unrelated `data_sync_log` insert
at 02:00:29.773.

### (ii) What it expired

The backlog was read **before** 02:00 (rule 107), at 01:44:13 UTC:

```
SELECT count(*), min(expires_at) FROM entity_grants WHERE status='active' AND expires_at < now();
→ 0
```

`entity_grants` on prod at that reading: 12 `active` (5 carry an `expires_at`, all
`2028-05-29 04:45:34.568` — the five `constituent`/`jurisdiction` grants
auto-approved on 2026-05-29), 12 `revoked`. `grant_events` has never recorded an
`expired` event (events: `auto_approved` ×5, `revoked` ×12). **No grant on prod has
ever lapsed.**

After the sweep, read at 02:20:01 UTC:

| reading | value |
|---|---|
| `grant_events` `event='expired'`, `metadata->>'source'='expire_lapsed_grants'`, `occurred_at >= 02:00` | **0** rows (min/max `expires_at` null) |
| `entity_grants` `status='active' AND expires_at < now()` | **0** |

The count equals the backlog (0 = 0). The sweep ran and had nothing to expire.
(The prompt's query named `grant_events.created_at`; the column is `occurred_at`.)

### (iii) The audit — does every reader of an active grant also check `expires_at`?

**Database (prod `pg_proc`, `pg_policies`, read 01:47 UTC).** Every authorization
reader checks `expires_at IS NULL OR expires_at > now()`: `has_active_answerer_grant`,
`has_active_constituent_grant`, `has_active_official_grant`,
`has_active_platform_admin_grant`, `create_investigation`,
`set_investigation_findings`. The two that filter `status='active'` without it are
write paths: `promote_candidate_to_elected` (it re-points and de-duplicates grants
on promotion) and `revoke_grant`. No RLS policy reads grant activity:
`users_read_own_grants` is `auth.uid() = user_id` and `users_read_own_grant_events`
joins on ownership only.

**Application (repo grep, apps/civitics + packages).** NOT every reader checks it:

| reader | decides | checks `expires_at`? |
|---|---|---|
| `api/constituent-status/route.ts:35-46` | `verified` flag, constituent default lens | yes — `.or(expires_at.is.null,expires_at.gt.<now>)` |
| `api/comments/_lib.ts:240` → `has_active_constituent_grant` | comment constituent badge | yes (SQL) |
| `api/admin/grants/_lib.ts:22` → `has_active_platform_admin_grant` | /admin/grants access | yes (SQL) |
| `api/viewer/engagement/route.ts:82` → `has_active_answerer_grant` | `can_answer` | yes (SQL) |
| `desk/page.tsx:166-168` | "Verified constituent" card + header line | **no** — `g.status === "active"` only |
| `desk/page.tsx:187-189` | elevated-desk placeholder | **no** |
| `desk/page.tsx:176-183` → `VerificationModule.tsx:78` | claim "Verified · expires …" label | **no** |
| `api/officials/claim-status/route.ts:37-46` → `ClaimProfileSection.tsx:73-74` | active/verified claim state | **no** |
| `api/officials/claim/route.ts:95-104` | `claim_exists` 409 | **no** (a lapsed, unswept claim blocks a re-claim until the sweep) |
| `api/admin/grants/[id]/route.ts:97-104, 154-170`, `admin/grants/page.tsx:129-139` | admin revoke count / revoke gate / active list | no — admin display; revoking a lapsed row is harmless |

So a lapsed-but-unswept grant WOULD read as live on the desk and claim surfaces —
for up to ~24 h between a lapse and the next 02:00 sweep, and indefinitely while
the sweep never reached the DB (09-20 → 09-26 and possibly earlier).

**Exposure.** Zero. Since no grant on prod has ever lapsed — the only five with an
expiry lapse on 2028-05-29 — no holder acted after an `expires_at`, on any surface,
checked or not. Per the prompt's rule 106 trigger ("file iff ≥ 1 such action
exists") nothing is filed. The reader gap is recorded here so the day the first
grant lapses has a pointer: the sweep now runs nightly, so the gap is bounded to
one night.

### Verdict

Gateway row present · backlog (0) expired (0) · every **authorization** path checks
`expires_at` in SQL, and the unchecked UI paths had zero exposure. FIX-1231 closes
on this receipt.

## 2. FIX-1226 durability (report only — FIX-1226 is closed, rule 70)

The fixed writer (`200a98c2`) ran for the first time in `fec_bulk_pac` 2026 + 2024,
09-26 21:04–21:07 UTC. Read at 02:21:30–02:21:31 UTC:

| reading | expected | read |
|---|---|---|
| cc-160's population query (`fix1226-rederive-received-totals.mjs --dry-run`, `--out` outside the repo) | 0 ids | **0 ids** (excluded, 0 with no inbound rows: 2,674) |
| RNC `C00003418` `total_received_cents` (cc-160 chunk 83) | 36,469,039,900 | **36,469,039,900** |
| DNC `C00010603` (chunk 82) | 33,415,765,200 | **33,415,765,200** |
| DSCC `C00042366` (chunk 81) | 32,617,811,800 | **32,617,811,800** |
| FE rows `updated_at > 09-26 19:41` | — | 6,612 (2,637 in 21:04–21:08; the rest mostly cc-163's own FIX-1235 landing at 02:18) |
| of cc-160's 5,713 manifest ids: `updated_at` in the PAC window 21:04–21:08 | — | **1,612** — every one of the ids touched between 19:41 and 02:18 |
| of those 5,713: `total_received_cents = 0` now | 0 | **0** |

The PAC pass rewrote 1,612 of the re-derived committees (DNC among them, stamped
21:07:35.8) and the received total survived on every one. 2,891 of the 5,713 are
also in FIX-1235's donated set and were restamped at 02:18 by that landing (which
writes only `total_donated_cents`). No reopen.

## 3. jobid 55 — `fe-inbound-rollup-refresh`, first scheduled firing (report only)

`cron.job` by NAME (rule 7). Read at 02:20:02 UTC.

| source | reading |
|---|---|
| `cron.job_run_details` | jobid 55, runid 71417, **succeeded**, 02:13:00.020 → 02:13:00.780 (**0.760 s**), `CALL` |
| `data_sync_log` `financial_entity_inbound_rollup` | **complete**, `rows_inserted` 0; metadata `mode: watermark`, `units_run: 0`, `recipients: 0`, `dirty_recipients: 0`, `rows_written: 0`, `caught_up: true`, `unit_capped: false`, `canceled: false`, `elapsed_seconds: 1`, `max_recipient_ms: 0.0`, `cursor_after: null` |
| `watermark_after` / `pipeline_state.financial_entity_inbound_rollup_watermark` | **2026-09-27 01:13:00.056568** (from cc-159's 2026-09-26 02:12:34.316) |

Expected `complete`, watermark mode, 0 rows, 0 dirty: all as expected. One premise
miss: the prompt expected `watermark_after` ≈ 02:13. It is 01:13:00.057 = the run's
`target`, because the watermark clamps to `watermark_horizon()` = now − 3,600 s
(`civitics.watermark_lag_seconds`, FIX-983/FIX-1139). That is the designed
behaviour, not a lag. The cost of a watermark run with an empty dirty set: 0.76 s.
cc-163's FIX-1235 claim was taken at 02:18:05 and released 02:18:33, after this
firing, so it did not overlap. Its receipts line reads `missing` until tomorrow's
file (rule 35 — one cadence of grace).
