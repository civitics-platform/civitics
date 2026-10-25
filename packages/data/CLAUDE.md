# packages/data/CLAUDE.md

Data ingestion pipelines: download, parse and upsert civic data from government
sources. They run as Node.js scripts, not as part of the Next.js build. The
command list is `docs/OPERATIONS.md` §Pipeline Operations. A new pipeline meets
the playbook's pipeline contract (`docs/ENGINEERING_PLAYBOOK.md` D9): upsert
with a skip predicate, one `data_sync_log` row per unit, a registry row, the
FIX-950 claim for a prod writer. This file is the per-source writer contracts:
keys, filters and floors. Columns: `packages/db/CLAUDE.md` §Column traps. The
pre-haircut file is `docs/archive/claude-md-data-2026-10-24.md`.

---

## Update Schedules

- **The nightly** is the GHA workflow `nightly.yml` (`runNightlySync()` in
  `src/pipelines/index.ts`), dispatched at 21:00 UTC on the dispatcher's request
  stamp (FIX-1336); its `schedule:` is a fallback. The weekly block keys on the
  run's slot day (FIX-1163). FEC bulk also runs off-Sunday when FEC's indiv
  file is newer than our watermark (FIX-903).
- **The EC rebuild and the derived rollups** are job-registry rows run as
  pg_cron units — `docs/cc/projects/dispatcher.md`, `pnpm board`. The registry
  is the job list.
- `rebuild-entity-connections.yml` is `workflow_dispatch`-only break-glass
  (FIX-688).

## Entity Connections Derivation

`rebuild_entity_connections()` and its chunk functions derive
`entity_connections` from the source tables: `donation` (with `ie_support`),
`opposition` (`ie_oppose`), `contract_award` (FR `contract` + `grant`) and the
other money edges from `financial_relationships`; the vote and nomination-vote
edges from `votes`; `co_sponsorship`; `appointment` / `holds_position` (career
history plus matched `irs990_officers`); `oversight`. The scheduled path is the `ec-crawl` unit
(`run_entity_connections_rebuild`, sync-log pipeline `entity_connections_rebuild`).
`pnpm --filter @civitics/data data:rebuild-connections` refreshes derived edges
against the local Docker DB.

---

## Per-Source Strategy

### FEC Campaign Finance
**Use bulk downloads — NEVER the FEC API.** Per cycle: `weball`, `cm`, `pas2`,
`ccl`, `indiv`, `cn` (pipe-delimited zips) and `independent_expenditure_{cycle}.csv`
(comma-delimited, with a header row). Downloads go through
`downloadWithR2Cache` (`fec-bulk/util.ts`). Script:
`pnpm --filter @civitics/data data:fec-bulk`.

**Step 1b — candidate master `cn{yy}` (FIX-246).** Inserts a new `officials`
row with `tier='candidate'`, keyed on `source_ids->>'fec_candidate_id'`, for
each `CAND_ID` (offices H/S/P) not already present. An existing official —
elected or a prior cycle's — is never overwritten. Dedup is application-layer
(the pre-fetched map plus an in-run set), so a re-run inserts zero rows. Runs
**before** weball matching, which then resolves the new rows by
`fec_candidate_id` rather than the name fallback.

**Step 2b — PAC contributions `pas2`.** Types `24K`/`24Z`, amount > 0, known
FEC candidate ids. Aggregates per committee × candidate, then applies the $200
floor to the AGGREGATE (FIX-1068). pas2 is committee-to-candidate money, which
FEC itemizes in full, so the residual is logged, NOT bracketed. PAC donors are
`financial_entities` keyed on the `fec_committee_id` column (UNIQUE). FR rows
use the arbiter `(relationship_type, from_id, to_id, cycle_year)`, with
`metadata.source = 'fec_bulk_pac'` and `metadata.fec_committee_id`.

**Step 2c — individual contributions `indiv` (FIX-181, FIX-236).**
- Recipients: ccl principal/authorized (`P`/`A`) committees → the candidate,
  plus cm super PACs (`O`), party (`X`/`Y`/`Z`) and other PACs
  (`N`/`Q`/`V`/`W`) not already in ccl → the committee. Joint-fundraising (`J`),
  leadership (`D`) and `B` stay out: their money is re-itemized downstream and
  would double-count.
- Transaction types `15`, `15E` and `10` (super-PAC receipts from a person,
  FIX-677 — before it, ~$3.79B of super-PAC money was dropped), amount > 0.
  Earmark memos (`15I`/`15T`/`24I`/`24T`) and refunds (`20Y`/`22Y`) stay out.
- Donor identity is `fingerprint = upper(NAME) + "|" + ZIP5`; individual donors
  are `financial_entities` (`entity_type='individual'`) deduped on
  `donor_fingerprint` UNIQUE.
- FR rows: `to_type='official'` with `metadata.source = 'fec_bulk_indiv'`, or
  `to_type='financial_entity'` with `'fec_bulk_indiv_to_committee'`.
- A recipient committee's `total_donated_cents` is never overwritten with its
  inflow: that column is the OUTFLOW convention.
- Aggregation is external and the floor is applied at emit — see the FEC indiv
  section below. Disable per run with `FEC_INCLUDE_INDIV=false`.

**Step 2d — independent expenditures, Schedule E (FIX-240).**
- Dates are `DD-MON-YY` (e.g. `27-SEP-24`), not MMDDYYYY (`parseDdMonYy`).
- Aggregates by `(spe_id × cand_id × sup_opp)`. Filters: `spe_id` and `cand_id`
  non-empty, `sup_opp` ∈ {S, O}, `0 < exp_amo ≤ $50M` (FIX-672's junk-filing
  bound). No $200 floor: Schedule E has none.
- A target `cand_id` with no matched official is **not dropped** (FIX-674): it
  is resolved to an existing official carrying that id (inactive rows
  included), or minted as a `tier='candidate'` official keyed on
  `fec_candidate_id` (`fec-bulk/mint-ie-targets.ts`).
- Spending committees no other file surfaced are pre-upserted
  (`total_donated_cents` left at 0).
- FR `relationship_type` is `ie_support` or `ie_oppose` on the same 4-column
  arbiter, with the raw flag in `metadata.support_oppose` and
  `metadata.source = 'fec_bulk_ie'`. In EC, `ie_support` folds into `donation`
  and `ie_oppose` is the `opposition` edge (FIX-747) — never a donation.
- A failed IE stage is tolerated: the cycle keeps its PAC and indiv data.

**After all cycles:** `rebuild_financial_entity_donation_totals()` re-derives
`financial_entities.total_donated_cents` from live donation outflow (FIX-269).

### IRS Form 990 (FIX-250)
**Use IRS-hosted bulk ZIPs — NEVER the historical AWS S3 `irs-form-990` bucket (frozen Dec 2021).**

**Critical scope note: 990s do NOT disclose donors.** Schedule B (the donor
schedule) is redacted from the public e-file distribution. Anywhere this is
implied in code, types, comments, or UI is a bug. The pipeline ingests only
officers/directors/key employees (Part VII-A), grants OUT (Schedule I), and the
financial summary.

- The index CSV is HEAD-checked against `pipeline_state` key
  `irs990:index_watermark` (`{year: lastModified}`); an unchanged year is skipped.
- Scope is the seed EIN set (`src/pipelines/irs990/seed.ts`). Filings are unique
  on `object_id`.
- A resolved grant writes an FR `relationship_type='grant'` row with
  `disclosure_form_id = 'irs990:{object_id}:{to_entity_id}:{amount_cents}'` as
  the re-run dedup key.
- EIN binding: `external_source_refs(source='irs_990', external_id=EIN)`.
- Officer matching is high-precision only: exact canonical name
  (`canonicalizePersonName`). Matching against individual donor rows is
  deferred: false-positive risk on common names is too high.
- Runs weekly, after FEC bulk, so grant recipients see freshly upserted PAC
  entities. `IRS990_TAX_YEARS=2022,2023,2024` overrides the default three years.

### USASpending.gov
- Full FY bulk archive, all agencies in `public.agencies`, all award sizes.
  Contracts (`data:usaspending-bulk`) and assistance — grants 02/03/04/05/11
  (`data:usaspending-bulk-assistance`, FIX-114) — run independently.
- **Every archive, Full or Delta, holds MULTIPLE 1,000,000-row CSV parts.**
  `usaspending-bulk/zip.ts` `openCsvParts` enumerates them all (FIX-766).
  "Exactly 1,000,000 rows read" is the tell of a first-part-only truncation.
  A delta is not small (FIX-1274; playbook A1).
- State lives in `pipeline_state.usaspending_bulk_state` (per category,
  FIX-739). Every run checkpoints per completed part, so a killed run resumes
  the same archive, idempotent on `*_award_unique_key` (FIX-1274). The FR upsert
  skips byte-identical rows.
- **Manual `workflow_dispatch` only** (`usaspending-bulk.yml`; the schedule came
  off in FIX-1291, and both pipelines are held in `rollup_watch_overrides`).
- **Supervised prod run:** `cd packages/data && pnpm run data:usaspending-bulk:prod -- --category contracts --max-minutes 240`.
  It runs under the FIX-950 claim. The CI entry never claims: it writes
  `skipped` while a session is held. The dials (`--category`, `--max-parts`,
  `--max-minutes`, `--gate-wait-s`, `--breather-s`, `--keep-archive`,
  `--local-archive`) are parsed in `usaspending-bulk/flags.ts`.
- When a category completes, the tail vacuums `external_source_refs` only. FR
  and FE belong to their scheduled owners (FIX-1191, FIX-1152; playbook C5).
- `-- --force` re-runs Full. It does NOT claim over live writers: the claim
  refuses (exit 2) until they finish.

### OpenStates
**Bulk-first, API as fallback** (FIX-160). `data:states` is the bulk people
pipeline (no term dates); `data:states-api` is people + bills over the
250-call/day API. Both call `link_officials_to_districts()` at the end
(FIX-915). The API run used not to, and since it runs after the bulk run it
undid that run's repair every week.

**`officials.metadata` is MERGED, not replaced (FIX-915).** Both pipelines share
`openstates/writer.ts`'s `upsertLegislatorsBatch`, whose update path is a
PostgREST `.upsert(…, { onConflict: 'id' })` — that REPLACES the jsonb column,
and destroyed `metadata->>'district_jurisdiction_id'` on every run. The writer
now pre-fetches existing metadata for its update targets and merges client-side
(incoming keys win). If you add a pipeline that writes `officials`, merge
metadata the same way — PostgREST cannot express a server-side jsonb merge, so
this has to be done in the writer.

### Census TIGER districts (FIX-160, FIX-217)
- SLD-U, SLD-L and CD119, **per state** (no nationwide CD bundle), from
  `www2.census.gov/geo/tiger/TIGER2024/`. Persisted as `jurisdictions` rows with
  `metadata.chamber ∈ {upper, lower, congressional}` and a MULTIPOLYGON in
  `boundary_geometry`. DC and the Nebraska SLDL are skipped. Annual, manual:
  `pnpm --filter @civitics/data data:districts`.
- New Hampshire's floterial districts are re-derived after the whole SLD pass
  and **before** `link_officials_to_districts()`, or their representatives stay
  unlinked for a year (FIX-914).
- `link_officials_to_districts()` (state legislators, FIX-913) matches on a
  five-tier ladder **scoped by state and chamber**. An unscoped `district_name`
  join is actively wrong ("10" appears on 99 officials across 50 states). It
  writes only where the strongest tier yields EXACTLY one district: 0 or >1 is
  skipped, never guessed. `link_federal_reps_to_districts()` does House members.
- The link is `officials.metadata->>'district_jurisdiction_id'` — NOT
  `officials.jurisdiction_id`, which keeps pointing at the statewide
  jurisdiction.

---

## FEC individual contributions — memory and the $200 floor

**The indiv stage aggregates externally (FIX-961).** `src/lib/external-sort.ts`
projects each row to a compact record, partial-aggregates in a bounded buffer,
spills gzip'd sorted runs and k-way merges them, so the live set is flat in
cycle size. `FEC_INDIV_SORT_BUFFER` (default 400,000 keys) is the heap knob: if a
cycle is tight, **lower the buffer — never raise the heap** — and lower it WITH
the heap ceiling (400k OOMs under a 512 MB heap). Sort disk, not heap, is the
resource to size. `FEC_INDIV_AGG_MODE` is gone; setting it does nothing.
Acceptance harness:
`pnpm --filter @civitics/data data:fec:indiv-acceptance --txt <indiv.txt> --ccl <ccl.txt> --cm <cm.txt> [--committee C00…] [--buffer N] [--stage-only]`.

**The $200 floor is an AGGREGATE floor, applied at emit (FIX-1068).** `amount > 0`
admits a row; the floor is applied once per `(donor × recipient × cycle)` group:

| aggregate | result |
|---|---|
| ≥ $200 | an FR row, with the **correct (full)** amount |
| < $200 | **no** FR row, **no** `financial_entities` donor row — counted into `small_dollar_bracket_rollup` by size band |

A donor's `total_donated_cents` sums only above-floor groups, so it agrees with
the FR rows the run writes. Receipts (the 90.2% the old per-transaction floor
dropped, the measured heap and disk): playbook E8.

### `small_dollar_bracket_rollup` — the residual substrate (FIX-1068)

Grain `(recipient_type, recipient_id, cycle_year, bracket, source)`;
`recipient_type` mirrors `financial_relationships.to_type` because the residual
spans BOTH recipient routes. `donor_count` counts **(donor × recipient) groups**
— the same unit as an FR row — not distinct donors. Written by the indiv stage
as one delete-then-insert transaction per (cycle, source).

`official_small_dollar_rollup` carries both halves: `small_dollar_cents`
(itemized, aggregate under $500) and `sub_floor_cents` (bracketed, aggregate
under $200). They are kept separate because `officials.total_received_cents` is
FR-derived and contains the first and not the second — `/api/graph/small-dollar`
returns both shares rather than one ambiguous number (FIX-776).
