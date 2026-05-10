# packages/data/CLAUDE.md

## Purpose
Data ingestion pipelines. Downloads, parses, and upserts civic data from government sources
into Supabase. Runs as Node.js scripts, not as part of the Next.js build.

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
| FEC bulk | 2GB | Candidate totals (weball24.zip) + PAC contributions (pas224.zip, streamed) + individual contributions (indiv24.zip). FEC's $200 itemization threshold is the only filter — no Civitics-imposed cap (FIX-182). |
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

Step 2b (PAC contributions):
- Parses cm24 into a committee ID → name/type/connected-org lookup map
- Streams pas224, filtering to: 24K/24Z transaction types, $200+ (FEC itemization threshold), and known FEC candidate IDs
- Aggregates total contributions per committee × candidate pair
- Upserts `financial_entities` rows for named PAC donors (keyed on `source_ids->>'fec_committee_id'`)
- Upserts `financial_relationships` rows per PAC × candidate pair (keyed on `official_id + fec_committee_id + cycle_year`)

Step 2c (individual contributions, FIX-181):
- Parses ccl into a `CMTE_ID → CAND_ID` lookup, restricted to principal ('P') and authorized ('A') committees
- Streams indiv line-by-line, filtering to transaction types `15` and `15E`, amount ≥ $200, and recipient CMTE_ID mapping to a candidate in our DB
- Donor identity is `fingerprint = upper(NAME) + "|" + ZIP5` (FEC's standard near-duplicate convention). No donor IDs exist in FEC data
- Aggregates to (donor × candidate × cycle) tuples in memory (~500 MB peak per presidential cycle); bump `NODE_OPTIONS=--max-old-space-size=4096` if OOM
- Upserts donor `financial_entities` rows with `entity_type='individual'`, deduped by `donor_fingerprint` UNIQUE (added by migration `20260502120000_financial_entities_donor_fingerprint.sql`). Multiple NULL fingerprints are allowed, so non-individual entities (PACs etc.) are unaffected.
- Upserts `financial_relationships` rows with `relationship_type='donation'`, source='fec_bulk_indiv'
- Disable per-run with `FEC_INCLUDE_INDIV=false`. Caches FEC bulk files in R2 is a planned follow-up (FIX-192)

- No API key required, no rate limits
- FEC updates bulk files weekly — run on weekly cron (Sunday block of nightly orchestrator)
- Script: `pnpm --filter @civitics/data data:fec-bulk`

### USASpending.gov
- Full FY bulk archive — all agencies in `public.agencies`, all award sizes, no rate limits
- Two categories, run independently:
  - **Contracts** (procurement) — `data:usaspending-bulk`
  - **Assistance** (grants 02/03/04/05/11) — `data:usaspending-bulk-assistance` (FIX-114). Loans/insurance/direct payments are skipped because the `financial_relationships` enum has no row for them.
- First run per category: Full file (`FY{year}_All_{Contracts|Assistance}_Full_{YYYYMMDD}.zip`, 300 MB–1 GB compressed)
- Subsequent runs: Delta files since last processed date (much smaller)
- State tracked in `packages/data/.usaspending-bulk-state.json` per-category (gitignored, not committed). Pre-FIX-114 single-shape state migrates into the `contracts` slot on first read.
- No API key required
- Update schedule: weekly via nightly orchestrator (Sunday-only block); Full file refreshes weekly, Deltas thereafter
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
- `pnpm --filter @civitics/data data:states` — bulk people pipeline (default; runs daily via nightly orchestrator). Calls `link_officials_to_districts()` at the end so the district cross-link survives the wholesale metadata-jsonb rewrite.
- `pnpm --filter @civitics/data data:states-api` — full API pipeline (people + bills, weekly). Use when term dates need refreshing or the bulk CSV is stale.

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
  - `link_officials_to_districts()` — state legislators (matches `metadata.org_classification` to TIGER chamber, with regex stripping of "House District N" / "Senate District N" prefixes)
  - `link_federal_reps_to_districts()` — House Representatives (matches `role_title='Representative'` + state + district_name to congressional districts; handles at-large states with NULL district_name)
- The link is written to `officials.metadata->>'district_jurisdiction_id'` (NOT `officials.jurisdiction_id`, which keeps pointing at the statewide jurisdiction).

---

## Update Schedules

Single source of truth is the nightly orchestrator in `packages/data/src/pipelines/index.ts` (`runNightlySync()`), invoked by GitHub Actions at 02:00 UTC daily. The Sunday-only weekly block fires when `new Date().getDay() === 0`.

- **Daily (every nightly run):** Regulations.gov, Congress.gov officials + votes, OpenStates bulk people, rule-based tags, AI tags (`$0.10` cap, `onlyNew`), AI summaries (incremental), MV refreshes (proposal_trending, proposal_popularity, spending_totals, chord MVs, homepage stats), entity_connections rebuild.
- **Weekly (Sunday block of nightly run):** FEC bulk, USASpending bulk (contracts + assistance), CourtListener, OpenStates API (bills + term dates), agencies hierarchy, OPM FTE, PLUM Book, elections, Congress committees.
- **Annual (manual):** TIGER districts (Census refresh cadence).
- **Manual only:** integrity audit, agency leadership, agency enrichment, Legistar per-metro, votes backfill, PAC industry tagger.

---

## Entity Connections Derivation

After all source pipelines run, derived `entity_connections` rows are produced by the SQL function `rebuild_entity_connections()` (defined in `supabase/migrations/20260422000002…`, finalized in `…000005`). It TRUNCATEs and rebuilds:
- `donation` from `financial_relationships`
- `vote_yes` / `vote_no` from `votes` + `bill_proposals`
- `co_sponsorship` from `proposal_cosponsors`
- `appointment` / `holds_position` from `career_history`
- `oversight` from `agencies`
- `contract_award`, `gift_received`, `lobbying` from `financial_relationships`

The nightly orchestrator (`pnpm --filter @civitics/data data:nightly`) calls it directly via `pg.Client` against the session pooler when `SUPABASE_DB_URL` is set, falling back to PostgREST `admin.rpc()` for local dev. There is no longer a standalone `data:connections` TS pipeline — that path was dead post-cutover and has been removed (FIX-187). Run nightly to refresh derived edges.

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
- Aggregates to (donor × candidate × cycle) tuples in-memory
- Upserts donor entities + donation relationships, then deletes the temp files
- ~500 MB peak heap per cycle; bump `NODE_OPTIONS=--max-old-space-size=4096` if OOM

Pro verified 2026-05-02 (cycles 2024 + 2026): 540,859 distinct individual
donors, 959,010 indiv donation rows, 0 failures across both cycles.

R2 is configured but unused for FEC files — see FIX-192 for the planned
mirror cache. Until then, FEC is hit fresh on each run.
