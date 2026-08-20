# packages/data/CLAUDE.md

## Purpose
Data ingestion pipelines. Downloads, parses, and upserts civic data from government sources
into Supabase. Runs as Node.js scripts, not as part of the Next.js build.

When a request-path query becomes slow as data grows, the durable fix is
materialization. See `../db/CLAUDE.md` — *Materialization pattern for
slow request-path aggregations* — for shape options (single-row MV,
per-entity MV, rolling-history snapshot table), refresh hook placement,
read-path conventions with live-compute fallback, and the table of existing
materializations to model off.

---

## Pipeline Conventions

- **Always upsert, never bare insert** — pipelines run repeatedly; duplicates must not accumulate
- **Always log to `data_sync_log`** — every pipeline run records: source, rows_processed, rows_upserted, errors, duration, storage_bytes_added
- **Always log storage estimates** before writing — check budget before large downloads
- **Delete after processing** — downloaded files land in OS temp dir and are deleted after each run
- **Smart update detection** — use ETag/Last-Modified headers and hash comparison to skip unchanged records; target 60–80% reduction in redundant API calls

---

## Storage Budget

**Storage Budget - stay under ~6GB for now**

| Source | Budget | Strategy |
|--------|--------|----------|
| Congress.gov | 0.5GB | Full resolution — bills + votes + legislators |
| FEC bulk | 2GB | Candidate totals (weball24.zip) + PAC contributions (pas224.zip, streamed) + individual contributions (indiv24.zip). FEC's $200 itemization threshold is the only filter — no Civitics-imposed cap (FIX-182). **PR 3b / FIX-1068:** that threshold is a per-donor CYCLE-AGGREGATE rule and is now applied at emit, not per transaction at parse. Sub-floor money is bracketed into `small_dollar_bracket_rollup` rather than discarded. |
| USASpending | 1GB | Full FY bulk archive, all agencies in our DB, all award sizes |
| Regulations.gov | 0.5GB | Active proposals only, no archived |
| CourtListener | 1GB | Metadata only — no opinion text |
| OpenStates | 1GB | Current legislative term only |

---

## Per-Source Strategy

### Congress.gov
- Full resolution: bills, votes, vote records, legislator data
- API key required: `CONGRESS_API_KEY`
- Update schedule: daily via nightly orchestrator (officials + votes)
- Script: `pnpm --filter @civitics/data data:congress`

### FEC Campaign Finance
**Use bulk downloads — NEVER the FEC API.**

| File | URL | Contents |
|------|-----|----------|
| `weball24.zip` | `fec.gov/files/bulk-downloads/2024/weball24.zip` | All-candidates summary: total raised, individual/PAC/party/self contributions per candidate |
| `cm24.zip` | `fec.gov/files/bulk-downloads/2024/cm24.zip` | Committee master — maps committee IDs to names, types, and parent organizations |
| `pas224.zip` | `fec.gov/files/bulk-downloads/2024/pas224.zip` | PAC to candidate contributions (~200 MB compressed) — **streamed line-by-line, never fully loaded** |
| `ccl24.zip` | `fec.gov/files/bulk-downloads/2024/ccl24.zip` | Candidate-committee linkage — maps committee IDs to candidate IDs (FIX-181). Tiny (~0.5 MB). |
| `indiv24.zip` | `fec.gov/files/bulk-downloads/2024/indiv24.zip` | Itemized individual contributions (~2 GB compressed, ~10 GB uncompressed) — streamed line-by-line, aggregated in-memory per cycle (FIX-181). Skip with `FEC_INCLUDE_INDIV=false`. |
| `independent_expenditure_2024.csv` | `fec.gov/files/bulk-downloads/2024/independent_expenditure_2024.csv` | FEC Form 3X Schedule E independent expenditures (~19 MB per cycle). CSV with header row, comma-delimited (unlike all the other pipe-delimited bulk files). FIX-240. |
| `cn24.zip` | `fec.gov/files/bulk-downloads/2024/cn24.zip` | Candidate master — one row per FEC candidate (House/Senate/Pres) per cycle (~10k rows, <1 MB). Inserts new `officials` rows with `tier='candidate'`, keyed on `source_ids->>'fec_candidate_id'`. Existing elected officials are never overwritten. FIX-246. |

Step 1b (candidate master, FIX-246):
- Downloads `cn{yy}.zip` per cycle (~kB-MB, ~10k candidate rows for a presidential cycle).
- Streams line-by-line; skips rows with `CAND_OFFICE ∉ {H, S, P}` (rare municipal / blank).
- For each `CAND_ID`, looks it up in `existingByFecCandId` (pre-fetched at pipeline start). If already present (elected or prior cycle), skips — never overwrites elected officials.
- Otherwise inserts a new `officials` row with `tier='candidate'`, `role_title='Candidate for {President/Senator/Representative}'`, party from `CAND_PTY_AFFILIATION`, district from `CAND_OFFICE_DISTRICT` (House only), `source_ids = {fec_candidate_id: CAND_ID}`, `metadata.cand_status/cand_ici/fec_election_yr` preserved for downstream audits.
- Idempotency: dedup happens at the application layer via the pre-fetched map plus an in-run `seenThisRun` set. Re-running the pipeline inserts zero new candidate rows for a stable cn{yy}.zip.
- Newly-inserted (CAND_ID → officials.id) pairs are pushed into the weball match index so weball matching for the same cycle resolves them via fec_candidate_id rather than the name fallback.
- Runs **before** weball matching for the cycle, so the matching path benefits from the new candidate rows on first ingestion.

Step 2b (PAC contributions):
- Parses cm24 into a committee ID → name/type/connected-org lookup map
- Streams pas224, filtering to: 24K/24Z transaction types, amount > 0, and known FEC candidate IDs
- Aggregates total contributions per committee × candidate pair, then applies the $200 floor to the AGGREGATE (FIX-1068). The old per-transaction `>= 200` test was mislabelled "FEC itemization threshold" twice over: itemization is a per-donor cycle-aggregate rule, and it does not apply to this file at all — pas2 is committee-to-candidate money (Schedule A 11(c)), which FEC itemizes in full regardless of amount. The residual is logged, NOT bracketed (brackets are the individual-donor substrate).
- Upserts `financial_entities` rows for named PAC donors (keyed on `source_ids->>'fec_committee_id'`)
- Upserts `financial_relationships` rows per PAC × candidate pair (keyed on `official_id + fec_committee_id + cycle_year`)

Step 2c (individual contributions, FIX-181 + FIX-236):
- Parses ccl into a `CMTE_ID → CAND_ID` lookup, restricted to principal ('P') and authorized ('A') committees
- Parses cm into a second `CMTE_ID → CMTE_TP` lookup, restricted to super PACs (`O`), party committees (`X`/`Y`/`Z`), and other PACs (`N`/`Q`/`V`/`W`) NOT already in ccl P/A — this is the recipient set that captures Form 3X Schedule A flow (Musk → America PAC etc.). Joint-fundraising (`J`), leadership (`D`), and `B` stay excluded — their money is re-itemized via downstream transfers and would double-count.
- Streams indiv line-by-line, filtering to transaction types `15`, `15E`, and `10`, **amount > 0** (FIX-1068 — see "The $200 floor is an aggregate floor" below), and recipient CMTE_ID present in EITHER lookup. `10` is FEC's "contribution to an Independent-Expenditure-Only committee (Super PAC) from a person" — the super-PAC analog of `15`. It was added by FIX-677; before that, super-PAC individual receipts (which are filed as type `10`, not `15`) were systematically dropped (e.g. United Democracy Project showed $0 received despite ~$86M / 1,337 itemized type-10 contributions; ~$3.79B across all super PACs in the 2024 file). Earmark passthrough memos (`15I`/`15T`/`24I`/`24T`) and refunds (`20Y`/`22Y`) stay excluded.
- Donor identity is `fingerprint = upper(NAME) + "|" + ZIP5` (FEC's standard near-duplicate convention). No donor IDs exist in FEC data
- Aggregates two groupings, **externally** (FIX-961):
  - `(donor × candidate × cycle)` tuples for ccl-mapped lines → donor → official donations
  - `(donor × committee × cycle)` tuples for super-PAC/party/PAC lines → donor → financial_entity (committee) donations
  - Both, plus the donor-meta grouping, go through `src/lib/external-sort.ts`: each surviving row is projected to a compact record, partial-aggregated in a bounded buffer, spilled to gzip'd sorted runs, and reduced by a k-way merge. **The stage's live set no longer scales with cycle size.** See "Indiv-stage memory" below.
- Upserts donor `financial_entities` rows with `entity_type='individual'`, deduped by `donor_fingerprint` UNIQUE (added by migration `20260502120000_financial_entities_donor_fingerprint.sql`). Multiple NULL fingerprints are allowed, so non-individual entities (PACs etc.) are unaffected.
- Pre-upserts recipient committee `financial_entities` rows for any super PAC / party / non-cand PAC that received itemized individual contributions, so the donor → committee relationships have a `to_id` to point at. `total_donated_cents` is left at 0 for these (or whatever pas2 set; never overwritten with indiv-inflow — `total_donated_cents` is the outflow convention used elsewhere in the schema).
- Upserts `financial_relationships` rows with `relationship_type='donation'`:
  - `to_type='official'`, `source='fec_bulk_indiv'` for candidate recipients
  - `to_type='financial_entity'`, `source='fec_bulk_indiv_to_committee'` for super PAC / party / other PAC recipients
- Disable per-run with `FEC_INCLUDE_INDIV=false`. Caches FEC bulk files in R2 is a planned follow-up (FIX-192)

Step 2d (independent expenditures, FIX-240):
- Downloads `independent_expenditure_{cycle}.csv` (Schedule E) per cycle — small (~19 MB) plain CSV with header row, comma-delimited (different format from the pipe-delimited TXTs everywhere else).
- Streams via `csv-parse`, aggregating by `(spe_id × cand_id × sup_opp)` where `sup_opp` is FEC's raw 'S' (support) or 'O' (oppose) flag.
- Filters: `spe_id` non-empty, `cand_id` non-empty AND in our matched-officials set, `sup_opp` ∈ {S,O}, `exp_amo` > 0. No itemization threshold — Schedule E has no $200 floor and small IEs are still meaningful.
- Date parsing: Schedule E dates come as `DD-MON-YY` (e.g. `27-SEP-24`) — NOT MMDDYYYY. A local `parseDdMonYy` helper converts to ISO.
- Pre-upserts any new spending committees that pas2/cm/indiv never surfaced (the canonical case: IE-only super PACs whose only money flow is Schedule E spending). `total_donated_cents` left at 0 — pas2 outflow remains the source of truth for that column.
- Upserts `financial_relationships` rows with **two new** `relationship_type` enum values: `ie_support` (for `sup_opp='S'`) and `ie_oppose` (for `sup_opp='O'`). They use the existing 4-col arbiter `(relationship_type, from_id, to_id, cycle_year)` for idempotency — no new column or index — because relationship_type itself distinguishes S from O. Raw `'S'`/`'O'` is also preserved in `metadata.support_oppose` for downstream consumers.
- `source='fec_bulk_ie'` in metadata; `source_url` points at `fec.gov/data/committee/{spe_id}/`.
- Graph derivation: `rebuild_entity_connections()` folds `ie_support` into the existing 'donation' edge case (positive money flow toward a candidate). `ie_oppose` is NOT folded in — opposition spending is anti-candidate; misclassifying it as "donation" would inflate apparent support. Opposition graph edges are a planned follow-up.
- No separate R2 cache watermark — the file is small enough that the R2 freshness check in `downloadWithR2Cache` already short-circuits an unchanged download.
- Stage failure is tolerated — if the IE CSV is unavailable, the cycle still wraps up with PAC + indiv data already landed.

Post-cycle recompute (FIX-269):
- After all cycles process, the pipeline calls `rebuild_financial_entity_donation_totals()` which UPDATEs `financial_entities.total_donated_cents` to live SUM of donation outflow (`from_type='financial_entity'` + `relationship_type='donation'`, covering candidate AND committee recipients). Replaces the lossy per-cycle overwrite that left multi-cycle individuals with only the latest cycle's total. Mirrors `rebuild_official_donation_totals()` shipped for officials. Defined in migration `20260513010000_financial_entity_donation_totals.sql`; full backfill via `SELECT rebuild_financial_entity_donation_totals_full();`.

- No API key required, no rate limits
- FEC updates bulk files weekly — run on weekly cron (Sunday block of nightly orchestrator)
- Script: `pnpm --filter @civitics/data data:fec-bulk`

### IRS Form 990 (FIX-250)
**Use IRS-hosted bulk ZIPs — NEVER the historical AWS S3 `irs-form-990` bucket (frozen Dec 2021).**

| File | URL | Contents |
|------|-----|----------|
| Index CSV | `https://apps.irs.gov/pub/epostcard/990/xml/{YEAR}/index_{YEAR}.csv` | Columns: RETURN_ID, FILING_TYPE, EIN, TAX_PERIOD, SUB_DATE, TAXPAYER_NAME, RETURN_TYPE, DLN, OBJECT_ID, XML_BATCH_ID. Subsection code is NOT in the index — it lives in the XML body. |
| Filing XML | `https://apps.irs.gov/pub/epostcard/990/xml/{YEAR}/{OBJECT_ID}_public.xml` | Per-filing structured data. Typically <1 MB. |

**Critical scope note: 990s do NOT disclose donors.** Schedule B (the donor schedule) is redacted from the public e-file distribution. Anywhere this is implied in code, types, comments, or UI is a bug. The pipeline ingests only:
- **Officers / directors / key employees** (Part VII Section A) — names, titles, compensation
- **Grants OUT** (Schedule I) — recipient name, EIN if disclosed, amount, purpose
- **Financial summary** — total revenue / assets / expenses, subsection code, NTEE code

Per-filing flow:
- HEAD the index CSV with `pipeline_state.irs990.index_watermark` (JSONB `{year: lastModified}`). Skip the year if Last-Modified is unchanged.
- Stream-parse the index. Keep rows where `EIN ∈ SEED_EIN_SET` ([packages/data/src/pipelines/irs990/seed.ts](src/pipelines/irs990/seed.ts), ~35 politically-active 501(c)(3)/(c)(4)/(c)(5)/(c)(6)/527 orgs).
- Pre-filter to OBJECT_IDs not already in `irs990_filings` (UNIQUE on object_id, the IRS DLN — globally stable per filing).
- For each new filing: GET XML (3x exponential backoff), parse via `fast-xml-parser` with `removeNSPrefix`, then tag-name-only DFS for the fields we care about (robust across yearly schema variants 2014-present).

Schema (migration `20260510000008_irs990.sql`):
- `'nonprofit'` added to `financial_entities.entity_type` CHECK.
- `irs990_filings` — one row per filing. UNIQUE(object_id). FK to `financial_entities`. Carries subsection_code, ntee_code, financials, address_state, schema_version.
- `irs990_officers` — one row per (filing, name_canonical, role_title). matched_entity_id resolves to `officials.id` when canonical name matches; otherwise NULL.
- `irs990_grants_out` — one row per (filing, recipient_name_canonical, amount). matched_entity_id resolves to a `financial_entities` row when recipient EIN or canonical name resolves; otherwise NULL.
- When a grant recipient resolves, a `financial_relationships` row with `relationship_type='grant'` is written, with `disclosure_form_id='irs990:{object_id}:{to_entity_id}:{amount_cents}'` as the dedup key for re-runs.
- `rebuild_entity_connections()` block 6 (holds_position) UNIONs in `irs990_officers` rows with `matched_entity_id IS NOT NULL` to emit `(from='official', to='financial_entity'=nonprofit)` edges. Grants-out fold into block 8 (contract_award) via the existing `relationship_type IN ('contract','grant')` path.

EIN binding: `external_source_refs(source='irs_990', external_id=EIN)` — same pattern as Congress.gov bioguide IDs etc.

Officer matching is high-precision only: officials by exact canonical name (canonicalize via `canonicalizePersonName`, which mirrors `canonicalizeEntityName` minus the corporate-suffix strip). Donor-side matching against the 540k individual donor rows is deferred to Phase 2 — false-positive risk on common names is too high without state/employer context.

Update schedule: weekly Sunday (after FEC bulk in the orchestrator so resolveGrantRecipient sees freshly-upserted PAC entities). 990s file annually with ~1-month bulk lag, but HEAD-watermark short-circuits unchanged years cheaply.

ProPublica Nonprofit Explorer API (`https://projects.propublica.org/nonprofits/api/v2/`) is NOT on the orchestrator path. It's reserved for ad-hoc EIN resolution (e.g. adding a new seed org by name) and gated to 1 req/sec defensive backoff. No API key required.

Override default tax years via `IRS990_TAX_YEARS=2022,2023,2024`. Default is `[CURRENT_YEAR-3, CURRENT_YEAR-2, CURRENT_YEAR-1]`.

- No API key required, no rate limits
- Script: `pnpm --filter @civitics/data data:irs990`

### USASpending.gov
- Full FY bulk archive — all agencies in `public.agencies`, all award sizes, no rate limits
- Two categories, run independently:
  - **Contracts** (procurement) — `data:usaspending-bulk`
  - **Assistance** (grants 02/03/04/05/11) — `data:usaspending-bulk-assistance` (FIX-114). Loans/insurance/direct payments are skipped because the `financial_relationships` enum has no row for them.
- First run per category: Full file (`FY{year}_All_{Contracts|Assistance}_Full_{YYYYMMDD}.zip`, 300 MB–1 GB compressed)
- Subsequent runs: Delta files since last completed archive date (much smaller)
- **Each Full zip holds MULTIPLE 1,000,000-row CSV parts** (FY2026 contracts = 3, assistance = 4). `usaspending-bulk/zip.ts` `openCsvParts` enumerates every part via the central directory; the loop extracts → processes → deletes one part at a time (FIX-766). Taking only the first `.csv` was a silent ~1/N truncation latent since inception (the "exactly 1,000,000 rows read" tell). A full run is ~90–105 min / ~3M contracts + ~4M assistance rows.
- State lives in `pipeline_state.usaspending_bulk_state` (DB, JSONB per-category — FIX-739; see `usaspending-bulk/state.ts`). Was a runner-local `.usaspending-bulk-state.json` that died with each ephemeral CI runner, so every dispatch re-ran Full and delta mode was dead in CI. Each DB holds its own state; a one-time lift migrates the legacy file's active-env slice on first run. Full runs checkpoint per completed CSV part, so a killed dispatch resumes the same archive (idempotent on `*_award_unique_key`) instead of restarting at part 1; a different archive date discards the partial.
- No API key required
- Update schedule: **manual `workflow_dispatch` only** (`usaspending-bulk.yml`, FIX-740) — pulled out of the nightly enrichment phase, its own 350-min budget. The now-cheap delta path rejoining the nightly is a possible future call.
- Force full re-run: append `-- --force` (e.g. `pnpm … data:usaspending-bulk -- --force`)
- Underlying script accepts `--category=contracts|assistance --force` directly: `pnpm --filter @civitics/data data:usaspending-bulk -- --category=assistance --force`

### Regulations.gov
- Active proposals only (open for comment + recently closed)
- No archived/historical rulemaking
- API key: `REGULATIONS_GOV_API_KEY`
- Update schedule: daily via nightly orchestrator
- Script: `pnpm --filter @civitics/data data:regulations`

### CourtListener
- Federal judges and case metadata — **not opinion text** (too large)
- Free registration required
- Update schedule: weekly via nightly orchestrator (Sunday-only block)
- Script: `pnpm --filter @civitics/data data:courtlistener`

### OpenStates
**Bulk-first, API as fallback** (FIX-160).

| Source | Access | Cadence | Coverage |
|---|---|---|---|
| `data.openstates.org/people/current/{abbr}.csv` | Public, no auth | Continuous | All 50 states + DC + territories. Basic legislator fields (id, name, party, district, chamber, contact). **No term dates.** |
| OpenStates v3 API (`/people`, `/bills`) | `OPENSTATES_API_KEY`, 250 calls/day | Weekly | Term dates + state bills. People bulk eliminates the per-state `/people` paginated calls, leaving the full quota for `/bills`. |
| `open.pluralpolicy.com/data/session-csv/` | Plural Policy login required | Monthly | Bill CSVs per state per session. Not currently used — gated behind a Django session that the API key doesn't satisfy. |

Scripts:
- `pnpm --filter @civitics/data data:states` — bulk people pipeline (default; runs daily via nightly orchestrator). Calls `link_officials_to_districts()` at the end.
- `pnpm --filter @civitics/data data:states-api` — full API pipeline (people + bills, weekly Sunday block). Use when term dates need refreshing or the bulk CSV is stale. Also calls `link_officials_to_districts()` at the end (FIX-915) — it previously did not, and since it runs AFTER the daily bulk run it silently undid that run's repair every Sunday.

**`officials.metadata` is MERGED, not replaced (FIX-915).** Both pipelines share
`openstates/writer.ts`'s `upsertLegislatorsBatch`, whose update path is a
PostgREST `.upsert(…, { onConflict: 'id' })` — that REPLACES the jsonb column, and
the pipelines only ever supply `{org_classification, state}`. Every run therefore
destroyed `metadata->>'district_jurisdiction_id'` (the SLD choropleth cross-link)
and relied on the linker RPC to re-derive it. The writer now pre-fetches existing
metadata for its update targets and merges client-side (incoming keys win). If you
add a pipeline that writes `officials`, merge metadata the same way — PostgREST
cannot express a server-side jsonb merge, so this has to be done in the writer.

### Census TIGER districts (FIX-160 maps integration, FIX-217 congressional)
- District boundaries for all 50 states across three chambers:
  - **SLD-U** (state senate / upper chamber)
  - **SLD-L** (state house / lower chamber)
  - **CD119** (US Congressional, 119th Congress, 2025-2027) — **per-state** files
- Source URLs (all public, no auth):
  - `https://www2.census.gov/geo/tiger/TIGER2024/SLD{U,L}/tl_2024_{ss}_{sldu,sldl}.zip`
  - `https://www2.census.gov/geo/tiger/TIGER2024/CD/tl_2024_{ss}_cd119.zip` — note: per-state, no nationwide bundle
- ~250 MB downloaded per run (~50 SLD-U + ~50 SLD-L + ~50 CD files, 1–6 MB each).
- Persisted as `jurisdictions` rows with `metadata.chamber ∈ {upper, lower, congressional}` and full MULTIPOLYGON in `boundary_geometry`.
- Skipped: DC (no SLDs), Nebraska SLDL (unicameral — only SLDU published).
- Cadence: annual (Census TIGER refresh). Not in the nightly orchestrator.
- Script: `pnpm --filter @civitics/data data:districts`
- **Two linker RPCs run after each pipeline pass:**
  - `link_officials_to_districts()` — state legislators. Five-tier match ladder (FIX-913, migration `20260727010000`): numeric zero-pad → multi-member `10A`/`10B` → exact normalised core → squashed core → anchored containment. Scoped by state (`governing_bodies.jurisdiction_id` = the district's `parent_id`) and chamber (`HD`/`SD` short_name prefix) — an unscoped `district_name` join is actively wrong, "10" appears on 99 officials across 50 states. Writes only where the strongest matching tier yields EXACTLY one district; 0 or >1 is skipped, never guessed. Links 7,313 of 7,373; the residual 60 is NH floterial (58, needs [[FIX-914]] seeding) + ME tribal (2, non-geographic and correctly unlinkable forever). Returns rows updated, so a no-change run returns 0. Carries a 5-min function-level `statement_timeout` — it is called as `service_role`, whose prod default is 8s.
  - `link_federal_reps_to_districts()` — House Representatives (matches `role_title='Representative'` + state + district_name to congressional districts; handles at-large states with NULL district_name)
- The link is written to `officials.metadata->>'district_jurisdiction_id'` (NOT `officials.jurisdiction_id`, which keeps pointing at the statewide jurisdiction).

---

## Update Schedules

Single source of truth is the nightly orchestrator in `packages/data/src/pipelines/index.ts` (`runNightlySync()`), invoked by GitHub Actions at 02:00 UTC daily. The Sunday-only weekly block fires when `new Date().getDay() === 0`.

- **Daily (every nightly run):** Regulations.gov, Congress.gov officials + votes, OpenStates bulk people, rule-based tags, AI tags (`$0.10` cap, `onlyNew`), AI summaries (incremental), MV refreshes (proposal_trending, proposal_popularity, spending_totals, chord MVs, homepage stats). **Note:** entity_connections rebuild is no longer in the nightly — moved to its own twice-weekly workflow (see below).
- **Weekly (Sunday block of nightly run):** FEC bulk, USASpending bulk (contracts + assistance), CourtListener, OpenStates API (bills + term dates), agencies hierarchy, OPM FTE, PLUM Book, elections, Congress committees, agency leadership, tag-industry.
- **Twice weekly (Sun + Wed 08:00 UTC, separate GHA workflow `rebuild-entity-connections.yml`, FIX-291):** `rebuild_entity_connections` (chunked, FIX-263). Runs 6h after nightly's 02:00 UTC start. Donations chunk runs with a 90-min function-level statement_timeout (FIX-291) — was pushing past the daily nightly's 120-min wall-clock budget. Graph edges go stale up to ~3 days between rebuilds; accepted vs the 4-of-7-nights-fail baseline that came from cramming the rebuild into the nightly. Trigger ad-hoc with `gh workflow run rebuild-entity-connections.yml`.
- **Weekly (Monday 04:00 UTC, separate GHA workflow `audit.yml`, FIX-226):** integrity audit. Report committed to `docs/audits/{YYYY-MM-DD}.md` (+ `.json`) on main; regressions surface as diffs in `git log docs/audits/`.
- **Monthly (first Sunday of month, in nightly run):** agency enrichment (Federal Register descriptions + Wikidata founding dates).
- **Annual (manual):** TIGER districts (Census refresh cadence).
- **Manual only:** Legistar per-metro, votes backfill.

---

## Entity Connections Derivation

After all source pipelines run, derived `entity_connections` rows are produced by the SQL function `rebuild_entity_connections()` (defined in `supabase/migrations/20260422000002…`, finalized in `…000005`). It TRUNCATEs and rebuilds:
- `donation` from `financial_relationships`
- `vote_yes` / `vote_no` from `votes` + `bill_proposals`
- `co_sponsorship` from `proposal_cosponsors`
- `appointment` / `holds_position` from `career_history`
- `oversight` from `agencies`
- `contract_award`, `gift_received`, `lobbying` from `financial_relationships`

The rebuild runs as a standalone GHA workflow on a Sun + Wed 08:00 UTC cadence (FIX-291). Invocation is `pnpm --filter @civitics/data data:rebuild-connections:ci` (defined in [packages/data/src/scripts/rebuild-entity-connections.ts](src/scripts/rebuild-entity-connections.ts)) which calls each chunk directly via `pg.Client` against the session pooler when `SUPABASE_DB_URL` is set, falling back to PostgREST `admin.rpc("rebuild_entity_connections")` (the umbrella function) for local dev. Sync-log rows are written under pipeline name `entity_connections_rebuild` (NOT `nightly_cron` — different cadence, different semantics, and the FIX-234 canary only watches `nightly_cron`). Run `pnpm --filter @civitics/data data:rebuild-connections` locally to refresh derived edges against the local Docker DB.

---

## Bulk vs API for Data Sources

Default to bulk downloads when a source publishes them. Bulk is:
- Faster — one fetch + parse vs. N paginated API calls
- More complete — APIs often miss tail rows due to rate limits, undocumented
  caps, or pagination edge cases
- More reproducible — same input → same output, easier to diff between runs
- More resilient — no mid-pipeline pagination failures

Use APIs for:
- Incremental updates after a bulk seed has landed
- Sources that don't publish bulk
- Live / per-entity hydration triggered by user actions

When writing a new pipeline, check for bulk availability first:
- FEC: https://www.fec.gov/data/browse-data/?tab=bulk-data
- IRS Form 990: IRS bulk e-file XML (verify current canonical URL — moved
  from S3 to IRS-hosted ZIPs around 2022-2023)
- SEC EDGAR: https://www.sec.gov/Archives/edgar/full-index/ + DERA datasets
  at https://www.sec.gov/dera/data
- LittleSis: https://littlesis.org/database
- Most state campaign finance: state portals publish CSV / XLSX exports
- OpenSecrets bulk data: https://www.opensecrets.org/open-data/bulk-data

If a new pipeline ends up API-based anyway, document why bulk wasn't
used (in the pipeline source header comment or migration comment).

---

## Full 2 GB FEC Individual File (FIX-181 — landed)

The individual-level FEC donor file (`indiv{yy}.zip`, ~2 GB) is now ingested
by the FEC bulk pipeline. Each cycle:
- Downloads `indiv{yy}.zip` + `ccl{yy}.zip` to OS temp dir
- Streams line-by-line via readline (never loads full file)
- Aggregates two groupings: (donor × candidate × cycle) for candidate-authorized
  recipients AND (donor × committee × cycle) for non-cand recipients (super
  PACs etc., FIX-236)
- Upserts donor entities + donation relationships, then deletes the temp files

Pro verified 2026-05-02 (cycles 2024 + 2026): 540,859 distinct individual
donors, 959,010 indiv donation rows, 0 failures across both cycles.

R2 is configured but unused for FEC files — see FIX-192 for the planned
mirror cache. Until then, FEC is hit fresh on each run.

### Indiv-stage memory — external sort, not a heap ceiling (FIX-961)

**The heap-size guidance that used to live here was wrong in kind, not just in
value.** It said 8 GB for a normal cycle and 12 GB for a presidential one; 12 GB
then OOM'd at ~53M of ~69M lines of `indiv20` (FIX-961), because the number it
was tuning was O(distinct groups) and the groups keep growing. Raising a ceiling
that tracks the data is not a fix.

Since FIX-961 (PR 3a) the stage aggregates **externally**
(`src/lib/external-sort.ts`): each surviving row is projected to a compact
record, partial-aggregated in a bounded buffer, spilled to gzip'd sorted runs,
and reduced by a k-way merge. The live set is one sort buffer plus the merge
cursors — flat in cycle size.

Measured 2026-08-18 on the full cycle-2026 file — 30,632,248 lines, 5,401 MB
extracted, 2,105,550 rows past the $200 floor → 879,782 donors, 762,891 donor ×
candidate + 553,717 donor × committee pairs:

| config | outcome | stage peak RSS | heap peak | runs (agg+meta) | peak sort disk | stream |
|---|---|---|---|---|---|---|
| `memory`, heap 2048 | **OOM** (exit 134) | — | — | — | — | — |
| `external`, heap 2048, buffer 400k | ✅ | 2,256 MB | 1,604 MB | 5+3 | 111.6 MB | 91 s |
| `external`, heap 1024, buffer 100k | ✅ | 900 MB | 634 MB | 20+17 | 133.8 MB | 86 s |
| `external`, heap 512, buffer 25k | ✅ | 424 MB | 206 MB | 81+74 | 142.9 MB | 93 s |

All three external configs emit identical results — same 762,891 / 553,717 /
879,782 counts, same Σ 407,450,870,500 cents — across a 5.3× range of resident
memory at **flat wall-clock** (86–93 s). On a 5M-line slice with both
accumulators side by side the stage peaks were 1,377 MB (`memory`) vs 711 MB
(`external`), again with zero divergence in every emitted set.

Operational notes:

- **The buffer is the heap knob, and it works.** `FEC_INDIV_SORT_BUFFER`
  (default 400,000 keys per run) trades heap for run count: 16× smaller buffer
  ⇒ 16× the runs ⇒ 5.3× less RSS, at flat wall-clock and ~28% more sort disk.
  Peak memory tracks the buffer, **not the cycle**, which is the whole point —
  a bigger file adds runs, not resident bytes. If a future cycle is tight,
  lower the buffer; do not raise the heap. The sort is deterministic across
  buffer sizes and there is a unit test pinning that.
- Lower the buffer WITH the ceiling, not after it: `external` at the default
  400k buffer OOMs under a 512 MB heap (as does 200k). The stage is bounded,
  not free — the buffer has to fit with GC headroom.
- **Sort disk, not heap, is now the resource to size.** Budget roughly
  `0.02–0.025 × extracted-text size` for run files (112 MB against 5.4 GB
  extracted here), on top of the extracted text. The extracted text is unlinked
  before the merge starts, so the two peaks do not overlap — a presidential
  cycle's ~13 GB extract implies ~300 MB of runs, well inside the GHA runner's
  ~14 GB free disk.
- RSS runs above the live set (2,256 MB at heap 2048) because
  `line.split("|")` allocates ~21 short-lived strings per line across 30M+
  lines and V8 does not collect while it has headroom — at heap 1024 the same
  work fits in 900 MB. Judge this stage by whether it completes at its
  configured buffer, not by its RSS.
- `FEC_INDIV_AGG_MODE` is **gone** (PR 3b / FIX-1068). The `memory` accumulator
  existed only so the PR 3a equivalence harness could diff it against the
  external sort; that diff ran clean and PR 3a shipped on it. Keeping a second
  accumulator alive past that point meant every semantics change had to be made
  twice, in the path that OOMs. Setting the var now does nothing.
- Acceptance harness (replaced the equivalence harness in the same file):
  `pnpm --filter @civitics/data data:fec:indiv-acceptance --txt <indiv.txt>
  --ccl <ccl.txt> --cm <cm.txt> [--committee C00…] [--buffer N] [--stage-only]`.
  Drives the real `streamIndivText` and reports what the stage will EMIT in the
  units the phase-0 audit measured (FR rows, dollars, donor rows, residual by
  bracket), plus self-consistency checks. `--stage-only` retains nothing per
  row, so its peak RSS is the stage's rather than the harness's — that is the
  bounded-heap proof.

### The $200 floor is an AGGREGATE floor, applied at emit (PR 3b / FIX-1068)

FEC itemizes on a per-donor **cycle aggregate**: once a contributor passes $200
cumulative with a committee, every later contribution is itemized however small.
The ingest applied $200 **per transaction at parse time**, which is a different
rule, and it discarded 90.2% of in-scope cycle-2026 rows.

Now: `amount > 0` admits the row; the floor is applied once per
`(donor × recipient × cycle)` group at emit.

| aggregate | result |
|---|---|
| ≥ $200 | an FR row, with the **correct (full)** amount |
| < $200 | **no** FR row, **no** `financial_entities` donor row — counted into `small_dollar_bracket_rollup` by size band |
| donor never reaches $200 with anyone | not in the file at all; unrecoverable under any rule |

Measured on the full cycle-2026 file (identical across sort buffers 25k/100k/400k,
and exact against `docs/audits/2026-08-18-fec-coverage-pr3a-phase0.md`):

| | before | after |
|---|---:|---:|
| FR rows | 1,316,608 | **1,980,786** (+50.4%) |
| dollars | $4,074,508,705 | **$4,556,216,174** (+11.8%) |
| residual (bracketed, not emitted) | silently dropped | 1,002,643 groups / $83,453,297 |

Two consequences to keep in mind:

- **`total_donated_cents` for a donor sums only ABOVE-floor groups**, so it
  agrees with the FR rows the run writes — which is the same convention
  `rebuild_financial_entity_donation_totals()` re-derives from.
- **Sort disk grew ~5×** (142.9 MB → 822.7 MB at buffer 25k on cycle 2026),
  because ~10× more records now reach the sorter. Peak heap did **not** move
  (~254 MB). Budget disk, not RAM, when sizing a presidential cycle.

### `small_dollar_bracket_rollup` — the residual substrate (FIX-1068)

Grain `(recipient_type, recipient_id, cycle_year, bracket, source)`;
`recipient_type` mirrors `financial_relationships.to_type` because the residual
spans BOTH recipient routes. `donor_count` counts **(donor × recipient) groups**
— the same unit as an FR row — not distinct donors. Written by the indiv stage
as one delete-then-insert transaction per (cycle, source).

It also fixes `official_small_dollar_rollup`, which was computed over the floored
population and so meant "$200-and-**up**" under a label that says small-dollar
(FIX-776 §2 of the audit). That table now carries both halves:
`small_dollar_cents` (itemized, aggregate under $500) and `sub_floor_cents`
(bracketed, aggregate under $200). They are kept separate because
`officials.total_received_cents` is FR-derived and contains the first and not the
second — `/api/graph/small-dollar` returns both shares rather than one ambiguous
number.
