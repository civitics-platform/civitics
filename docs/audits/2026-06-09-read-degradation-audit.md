# Data-layer read-degradation audit — 2026-06-09 (FIX-545 / FIX-546)

Surfaced by the FIX-294 LittleSis local rerun: a dead local Kong gateway made
`preloadKnownLittleSisIds` return an **empty Map** instead of erroring (bare
`const { data }` destructure, no error check), and the pipeline re-matched all
440,170 entities from scratch while looking like a clean run. Same class as
FIX-422. This audit enumerates every PostgREST `.from().select()` read in
`packages/data/src/**` + `packages/db/src/**`, classifies it, and records what
was fixed in the FIX-545 PR.

**Intended behavior change:** after this PR, a preload that hits a transient
gateway/PostgREST error THROWS — the pipeline fails, the canary/reaper records
it, and the next run retries — instead of silently degrading to
"everything unmatched". Fail-loud is the point; do not soften these back to
log-and-continue.

## Headline

| Metric | Count |
|---|---|
| Destructured PostgREST reads scanned by the guard (`pnpm check:reads`, post-fix) | 158 |
| Silent-zero offenders found at audit start (pre-fix, guard output) | 41 |
| Reads fixed in this PR (silent-zero / log-and-continue / truncation / `.in()`-cap) | 43 sites across 22 files |
| `reads-ok` annotated (report/sanity reads where empty output is visibly wrong) | 20 |
| Deferred to follow-up FIXes | FIX-547 (3 stats-aggregation blocks) + app read-path surface (below) |

The four failure modes this audit hunted:

1. **Silent-zero** — `const { data }` with no `error` check; a gateway error
   reads as an empty table.
2. **Log-and-continue** — `error` checked but the function proceeds with a
   partial/empty result (the old `buildOfficialMaps`, `seed-backlog fetchAll`).
3. **Silent truncation** — no `.range()` loop on a read whose table+filter can
   exceed PostgREST's 1,000-row `max_rows` cap (the rows past 1,000 just never
   arrive; no error).
4. **`.in()` URL-cap** — id lists past ~200 overflow the Kong URL budget and
   400 out, which silent-zero/log-continue then swallows.

## Shared helpers (new, FIX-545)

`packages/db/src/read-helpers.ts`, exported from `@civitics/db`:

- `rowsOrThrow<T>(res, label)` — single-page read; throws on `res.error`,
  returns `res.data ?? []`. Generalizes the FIX-422 local helper from
  `jurisdictions-boundary-backfill`.
- `selectAllOrThrow<T>(label, page, opts?)` — `.range()` pagination loop past
  the 1,000-row cap; throws on ANY page error (never break-with-partial);
  `opts.minRows` optional floor assertion.

Both are client-agnostic (take a result / page factory, not a db handle).

## Guard (FIX-546)

`scripts/check-silent-reads.mjs`, wired as `pnpm check:reads` + a blocking step
in `.github/workflows/tests.yml`. Flags `const { data } = await …` destructures
with no `error` binding on `.from().select()` chains (excludes
`.single()`/`.maybeSingle()`/`.rpc()`/writes/storage). Opt-out per read with a
`// reads-ok: <reason>` comment on the line above.

**Known limitations (accepted):** only the destructure-of-await shape is
detected. `const res = await …; const { data } = res;` and array-destructured
`Promise.all` results slip through (the FIX-547 sites are exactly that shape).
Truncation and `.in()`-cap risks are not mechanically detectable — they need
cardinality judgment, which is what this document records.

## Fixed in this PR

Cardinalities measured on the local prod-clone, 2026-06-09: officials 28.6k,
financial_entities 2.45M, entity_tags 2.8M, financial_relationships 6.2M,
votes 931k, external_source_refs 424k, proposals 78k, jurisdictions 10.5k.

| file : fn | Was | Consequence of the old shape | Fix |
|---|---|---|---|
| littlesis/writer.ts : preloadKnownLittleSisIds | silent-zero (the surfacing case) | known set = 0 → re-matched all 440k entities, run looked clean | selectAllOrThrow |
| congress/votes.ts : buildOfficialMaps (officials) | log-continue + TRUNC (28.6k rows, no range) | bioguide map truncated at 1,000 → House votes unmatched | selectAllOrThrow + order |
| congress/votes.ts : buildOfficialMaps (senators) | log-continue + TRUNC (senate GB carries ~1.9k rows incl. candidate pollution) | senator map truncated | selectAllOrThrow + order |
| congress/votes.ts : buildOfficialMaps (jurisdictions) | log-continue `.in()` (52 ids today, data-dependent) | senator map empty on error | rowsOrThrow + 200-id chunks |
| enrichment/seed-backlog.ts : fetchAll | log-continue + break-with-partial | done-sets undercount → re-enqueue finished items | delegates to selectAllOrThrow |
| congress/officials.ts : existing-officials preload | log-continue ("treat everything as new") | duplicate INSERT of every member on a blip | selectAllOrThrow + order |
| congress/bills.ts : resolveBillsBatch (both ref lookups) | log-continue → all-null map; unchunked `.in()` with full per-chamber buffer (>200 keys) | chamber's votes silently skipped | rowsOrThrow + 200-id chunks |
| agency-leadership/index.ts : closeStaleConnections | silent-zero | stale `is_current` rows never closed | rowsOrThrow |
| agency-leadership/index.ts : wikidata officials preload | silent-zero, no pagination | leaders re-inserted as new officials | selectAllOrThrow + order |
| plum-book/index.ts : closeStaleConnections | silent-zero | same as agency-leadership | rowsOrThrow |
| plum-book/index.ts : plum_id preload loop | paginated but silent-on-error (break-with-partial) | partial map → duplicate officials inserted | selectAllOrThrow |
| plum-book/index.ts : name-match OR-batch | silent-zero | unmatched names → duplicate officials inserted | rowsOrThrow |
| edgar/index.ts : daily tracked-CIK preload | silent-zero + unchunked `.in()` (~500 CIKs > 200 cap) | day mis-skipped as "no tracked CIKs" | rowsOrThrow + 200-id chunks |
| edgar/index.ts : daily financial-entity preload | silent-zero + unchunked `.in()` | edges skipped | rowsOrThrow + 200-id chunks |
| irs990/writer.ts : grant-relationship dedup precheck | silent-zero + 500-key `.in()` > 200 cap | duplicate grant rows on re-run | rowsOrThrow + 200-key sub-chunks |
| irs990/writer.ts : filterUningestedObjectIds | silent-zero | every filing looked uningested → re-fetch/re-ingest all | rowsOrThrow |
| legistar/writer.ts : lookupRefs | log-continue | partial idempotency map → re-insert bound items | rowsOrThrow |
| legistar/writer.ts : agenda-item sequence preload | silent-zero | sequence collisions → batch insert failures | rowsOrThrow |
| enrichment/queue.ts : loadJurisdictionPriorities | silent-zero + unchunked `.in()` (unique jurisdictions can exceed 200) | queue priorities degraded | rowsOrThrow + 200-id chunks |
| tags/ai-classifier.ts : industry-tagged FE preload | silent-zero + TRUNC (tag set ≫ 1,000) | re-tagging already-tagged PACs → re-burning AI budget every run | selectAllOrThrow + order |
| tags/ai-classifier.ts : PAC preload | TRUNC (no range; >1,000 PACs over threshold) | only top-1,000 PACs ever considered | selectAllOrThrow + order |
| tags/ai-tagger.ts : 4× already-tagged dedup sets (proposal/official × 2 paths) | silent-zero + TRUNC | re-tagging tagged entities → re-burning AI budget every run | existing in-file `fetchDistinctIds` (paginate + throw) + order |
| ai-summaries/index.ts : open-proposals work list | log-continue → [] | step silently skipped | rowsOrThrow |
| ai-summaries/index.ts : proposal cache preload | silent-zero + TRUNC | re-summarizing cached proposals → AI budget burn | selectAllOrThrow + order |
| ai-summaries/index.ts : officials work list | return-[]-on-error | step silently skipped | rowsOrThrow |
| ai-summaries/index.ts : official cache preload | silent-zero + TRUNC | re-summarizing cached officials | selectAllOrThrow + order |
| db/anthropic-usage.ts : fetchWindowFromLogs | silent-zero, no pagination | dashboard showed $0 usage on error | selectAllOrThrow (caller's catch → error shape) |
| db/anthropic-usage.ts : getMonthlyAnthropicSpend | error→null OK, but TRUNC undercounted spend | AI budget gate undercounts month spend | selectAllOrThrow inside existing try (null contract kept) |
| db/platform-snapshot.ts : getMonthlyAnthropicSpend (cron copy) | same | same, on the cron path | selectAllOrThrow inside existing try |
| db/platform-usage.ts : getPlatformUsage (limits + usage) | silent-zero | auto-trip evaluator fed empty metrics → safety pass silently skipped | throw on error (snapshot tick fails visibly) |
| db/supabase-prometheus.ts : applyCounterDelta / applyTickDelta | silent `.maybeSingle()` | read error looked like "no prior state" → baseline re-bootstrapped | error check + throw (caller catch → error shape) |
| db/auto-trip-evaluator.ts : kill-switch state read | silent `.maybeSingle()` | auto-trip pass silently skipped the tick | error check + throw (caller records) |
| openstates/writer.ts : legislator + bill ref lookups | log-continue per chunk | insert-vs-update split feeds a plain `.insert()` → duplicate officials/proposals | rowsOrThrow |
| openstates/writer.ts : summary_plain prefetch | log-continue per chunk | existing summaries looked NULL → abstract re-clobbered curated values (FIX-435 regression) | rowsOrThrow |
| regulations/writer.ts : agency lookup + proposal ref lookup | log-continue per chunk | agencies re-upserted over seeded fields; proposals duplicate-inserted | rowsOrThrow |
| usaspending-bulk/writer.ts : recipient ref lookup | log-continue per chunk | duplicate corporation `financial_entities` rows | rowsOrThrow |

## `reads-ok` annotated (deliberate, allow-listed)

Report/sanity reads where an empty result renders **visibly wrong** in
human-read output, and throwing would fail a run whose real work succeeded:

- `fec-bulk/index.ts` — end-of-run top-10-PACs and Senate-coverage sanity prints (2).
- `tags/ai-tagger.ts` — cost-estimate sample proposal (has a hard-coded fallback row) (1).
- `scripts/cron-run-anchor-verify.ts` — 14 anchor-report reads (empty section = visibly missing anchor in cron output).
- `scripts/cron-run-postrun-extract.ts` — pipeline_state report extract (1).
- `scripts/verify-summary-context-sample.ts` — ad-hoc verification samples (2).
- `scripts/audit-dc-territory-jurisdiction-assignments.ts` — territory report read (1).

## Follow-ups (recorded, deliberately NOT in this PR)

### FIX-547 — official stats aggregation reads are dead/truncated

Three sites build per-official vote/donor context and are broken in practice:

- `tags/ai-tagger.ts` `runOfficialAiTagger` votes/donor block — selects
  **`financial_relationships.official_id` + `donor_type`, columns that do not
  exist post-cutover**. The read 400s on every nightly run and is silently
  swallowed (array-destructure shape the guard can't see): officials have been
  tagged with zero financial context since cutover. Its `votes` read is also
  unchunked `.in()` + >1,000-row truncated.
- `ai-summaries/index.ts` `fetchOfficials` votes/donor block — same dead
  `official_id` column, same truncation (officialIds ≤ 50 but result rows ≫ 1,000).
- `enrichment/queue.ts` `aggregateOfficialStats` — correct `to_id`/`from_id`
  columns but unchunked `.in()` with all active official ids and ≫1,000-row
  results.

Durable fix is the FIX-298 shape (GROUP BY RPC + Map lookup;
`get_official_donor_rollup` already exists). Making these fail loud without
the rewrite would hard-break the nightly — hence a separate FIX.

### App request-path surface (out of scope, by design)

`apps/**` reads behind `withDbTimeout` deliberately return `data: null` on
timeout with render-degradation contracts — a different surface with a
different correct behavior. **Not audited here; needs its own pass** with its
own helper conventions if ever hardened.

Relatedly, the `packages/db/src/queries/*` helpers (proposals, votes,
officials, promises, financial-relationships, entity-connections,
entity-industry, jurisdictions, agencies, governing-bodies) all **throw on
error already** (no silent-zero) but several have no `.limit()` and will cap
at 1,000 rows on big tables (`listVotesByProposal`, `getVoteSummary`,
`listProposalsByType`, `getPromiseSummary`, `getConnectionsFrom/To`,
`listDonationsByDonor` second read). These serve the app request path, where
an implicit 1,000-row cap is a product/perf decision, not a pipeline-state
corruption — left as-is and recorded here.
**FIX-1157 (2026-09-05) struck four of the names above:** `listVotesByProposal`,
`getVoteSummary` and `listDonationsByDonor` (with the rest of
`queries/votes.ts` and `queries/financial-relationships.ts`) turned out to have
ZERO callers, and were deleted rather than paginated. The remaining names in
this paragraph still stand. If a consumer needs exact
aggregates, that's a materialization (see `packages/db/CLAUDE.md`), not a
bigger fetch.

### Safe by construction (no change)

- `jurisdictions-boundary-backfill/index.ts` — local `rowsOrThrow` (FIX-422),
  county range-loop. The model for the shared helper.
- `edgar/companies.ts preloadCikBindings`, `fec-bulk/index.ts loadOfficials`,
  `fec-bulk/candidates.ts loadExistingCandidateNames` / `loadOfficialsByFecIds`,
  `irs990/writer.ts loadOfficialsByCanonicalName`, `congress/promote-candidates.ts`
  (both reads), `tags/rules.ts` (via `fetchAllPaged`) — throw + range-loop.
- `congress/reconcile-former-members.ts` — throws; bounded today (~540 active),
  and truncation under-flips (fail-safe) behind its roster-size guard.
- littlesis matcher index — direct `pg.Client` since FIX-294; throws naturally.
- `.maybeSingle()` pipeline-state reads with explicit fallbacks
  (`sync-log.ts`, `legistar/index.ts`, `plum-book getStoredState`,
  `littlesis/util.ts getStoredFingerprint`, agency-leadership federal-jurisdiction
  lookup which warns + skips inserts) — single-row-ok.
- `db/kill-switches.ts loadMap` — propagates `{data,error}` to a caller that
  owns the env-layering fallback contract.
- Count-only reads (`head: true`) and `.rpc()` reads — recorded, out of the
  silent-zero class (the RPC row-cap hazard is documented in
  `reference_postgrest_rpc_row_cap`).
- `openstates/writer.ts` `.insert().select()` / `.upsert().select()` write-backs
  and the per-chunk insert error paths — write failures are counted in
  `out.failed` and surfaced in the sync log; not the silent-read class.

## Full mechanical dump

Re-generate anytime with `node scripts/check-silent-reads.mjs --audit`
(file:line | bindings | error-checked | single | rpc | range | in | limit |
reads-ok for every destructured PostgREST read in scope).
