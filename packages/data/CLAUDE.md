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

**Phase 1 target: 270MB total**

| Source | Budget | Strategy |
|--------|--------|----------|
| Congress.gov | 80MB | Full resolution — bills + votes + legislators |
| FEC bulk | 50MB | Candidate totals (weball24.zip) + PAC contributions (pas224.zip, streamed) |
| USASpending | 60MB | Current FY, contracts >$1M, top 20 agencies |
| Regulations.gov | 40MB | Active proposals only, no archived |
| CourtListener | 20MB | Metadata only — no opinion text |
| OpenStates | 20MB | Current legislative term only |

---

## Per-Source Strategy

### Congress.gov
- Full resolution: bills, votes, vote records, legislator data
- API key required: `CONGRESS_GOV_API_KEY`
- Update schedule: daily at 2am
- Script: `pnpm --filter @civitics/data data:congress`

### FEC Campaign Finance
**Use bulk downloads — NEVER the FEC API.**

| File | URL | Contents |
|------|-----|----------|
| `weball24.zip` | `fec.gov/files/bulk-downloads/2024/weball24.zip` | All-candidates summary: total raised, individual/PAC/party/self contributions per candidate |
| `cm24.zip` | `fec.gov/files/bulk-downloads/2024/cm24.zip` | Committee master — maps committee IDs to names, types, and parent organizations |
| `pas224.zip` | `fec.gov/files/bulk-downloads/2024/pas224.zip` | PAC to candidate contributions (~200 MB compressed) — **streamed line-by-line, never fully loaded** |

Step 2b (PAC contributions):
- Parses cm24 into a committee ID → name/type/connected-org lookup map
- Streams pas224, filtering to: 24K/24Z transaction types, $5 000+, and known FEC candidate IDs
- Aggregates total contributions per committee × candidate pair
- Upserts `financial_entities` rows for named PAC donors (keyed on `source_ids->>'fec_committee_id'`)
- Upserts `financial_relationships` rows per PAC × candidate pair (keyed on `official_id + fec_committee_id + cycle_year`)

- No API key required, no rate limits
- FEC updates bulk files weekly — run on weekly cron
- Script: `pnpm --filter @civitics/data data:fec-bulk`
- The API-based pipeline (`data:fec`) is retained for reference only — **do not use it** (hits rate limits)

### USASpending.gov
- Current fiscal year only
- Contracts over $1M only
- Top 20 federal agencies by spending volume
- API key: `USASPENDING_API_KEY` (free registration)
- Update schedule: daily at 2am
- Script: `pnpm --filter @civitics/data data:usaspending`

### Regulations.gov
- Active proposals only (open for comment + recently closed)
- No archived/historical rulemaking
- API key: `REGULATIONS_GOV_API_KEY`
- Update schedule: hourly for active periods
- Script: `pnpm --filter @civitics/data data:regulations`

### CourtListener
- Federal judges and case metadata — **not opinion text** (too large)
- Free registration required
- Update schedule: daily at 2am
- Script: `pnpm --filter @civitics/data data:courtlistener`

### OpenStates
- Current legislative term only
- All 50 state legislators + votes
- Free API
- Update schedule: daily at 2am
- Script: `pnpm --filter @civitics/data data:openstates`

---

## Update Schedules

- **Hourly:** Active proposal status, comment period deadlines
- **Daily (2am):** Spending data, voting records, new bills, court metadata
- **Weekly:** FEC bulk download, full reconciliation, AI summary regeneration, search index rebuild

---

## Entity Connections Pipeline

After all source pipelines run, the connections pipeline derives `entity_connections` rows from the ingested data:
- `donation` connections: from financial_relationships
- `vote_yes` / `vote_no` connections: from votes + proposals
- `oversight` connections: from agency–proposal relationships
- `appointment` connections: from career_history

Script: `pnpm --filter @civitics/data data:connections`

This must run AFTER all source pipelines. The master orchestrator handles ordering.

---

## Two Pending Data Sources

These require a privacy.com virtual card to set up accounts:
- **Cloudflare R2** — storage migration from Supabase Storage
- **Mapbox** — map tiles and geocoding API key

Pipeline code is ready; waiting on account/payment method.

---

## Full 2GB FEC Individual File

The individual-level FEC donor file (`indiv24.zip`, ~2GB) is pending Cloudflare R2 setup.
Too large to process through Supabase Storage. Once R2 is available:
- Download to temp dir
- Process in streaming chunks
- Match individuals to `financial_entities`
- Delete immediately after processing
