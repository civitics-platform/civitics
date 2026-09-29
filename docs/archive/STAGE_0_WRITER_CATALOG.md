# Stage 0 — Pipeline Writer Catalog

**Session:** First Cowork session on the platform rebuild (2026-04-19).
**Source:** Grep of `\.from\("[^"]*"\)\s*\.\s*(insert|upsert)` across `packages/data/src/pipelines/` (multiline). Plus a secondary pass for `.update(…)` and `.rpc(…)` calls, since several pipelines are enrichment-only.

**Scope of this doc:** every call site that writes (INSERT, UPSERT, UPDATE, or RPC) in the pipelines tree. No reader queries. No app-side mutations. This is the input to the schema-design work.

**Owner decisions received this session (Craig, in kickoff message):**

| # | Question | Answer |
|---|---|---|
| 1 | Supabase tier target | Pro ($25/mo) |
| 2 | Proposals structure (unified vs. split) | Undecided — also wants to think about how **initiatives** slot in |
| 3 | Local data pilot scope | "Skeleton of full buildout" — needs brainstorming + reality check |
| 4 | Keep vs. rewrite FEC donations | Rewrite |
| 5 | Connection-graph backing store | Rebuild alongside everything else |
| 6 | AI enrichment replay strategy | Prioritized queue, use parallel agents (Pro/Max plan) |

---

## Writer catalog — INSERT / UPSERT

`FK lookup?` column captures whether the write is preceded by a SELECT/lookup against another entity to resolve a foreign-key value at ingest time. `Retry?` captures any retry, queue, or dedupe-before-write logic beyond a plain insert.

| # | File:Line | Table | Op | Key columns written | JSON blob columns | FK lookup at ingest? | Retry / queue? |
|---|---|---|---|---|---|---|---|
| 1 | `congress/officials.ts:97` | `officials` | INSERT (batch 50) | `full_name`, `first_name`, `last_name`, `role_title`, `governing_body_id`, `jurisdiction_id`, `party`, `district_name`, `photo_url`, `term_start/end`, `website_url` | `source_ids:{congress_gov}`, `metadata:{}` (empty) | Yes — `jurisdiction_id` via `stateIds` map fallback to federal; `governing_body_id` from passed-in senate/house | Pre-fetch of all existing `congress_gov` source_ids into a Map → update-if-known, insert-if-new; no retry |
| 2 | `congress/votes.ts:315-317` (inside `findOrCreateProposal`) | `proposals` | INSERT | `title`, `bill_number`, `type`, `jurisdiction_id`, `congress_number`, `session`, `status`, `governing_body_id`, `congress_gov_url`, `introduced_at`, `last_action_at` | `source_ids:{congress_gov_bill}`, `metadata:{latest_action}` | SELECT-first by `source_ids->>congress_gov_bill`; chamber gov_body resolved from bill type | None |
| 3 | `congress/votes.ts:886` | `proposals` | INSERT | Same shape as #2 | `source_ids:{congress_gov_bill}`, `metadata:{latest_action}` | SELECT-first by `source_ids->>congress_gov_bill` | None |
| 4 | `congress/votes.ts:598-599` (House) | `votes` | INSERT (bulk array) | `official_id`, `proposal_id`, `vote`, `chamber`, `roll_call_number`, `session`, `voted_at` | `source_ids:{house_clerk_url,roll_call}`, `metadata:{vote_question,vote_result,legis_num}` | `official_id` via bioguide→UUID map pre-built once per run; `proposal_id` via `findOrCreateProposal` (#2) — if no bill ref, **votes are silently dropped** | Handles unique_violation (23505) as expected (per comment, widens after migration 0002); no queue for missing-bill votes |
| 5 | `congress/votes.ts:776-777` (Senate) | `votes` | INSERT (bulk array) | Same shape as #4 | `source_ids:{senate_lis_url,roll_call}`, `metadata:{vote_question,vote_result}` — note: **no `legis_num`** on Senate side | `official_id` via `lastName:state` → UUID map; `proposal_id` via `findOrCreateProposal` | Same 23505 swallow as #4 |
| 6 | `openstates/index.ts:137` | `governing_bodies` | INSERT (.select.single) | `jurisdiction_id`, `type`, `name`, `short_name`, `is_active` | — | SELECT-first by `(jurisdiction_id, type)`; result cached in-memory map | None |
| 7 | `openstates/index.ts:218` | `officials` | INSERT | Same shape as #1 | `source_ids:{openstates_id}`, `metadata:{state_abbr, org_classification}` | SELECT-first via `filter("source_ids->>openstates_id", "eq", osId)` — JSON-path dedup, not a real unique index | None |
| 8 | `courtlistener/index.ts:172` | `officials` | INSERT | `full_name`, `first_name`, `last_name`, `role_title="Federal Judge"`, `governing_body_id`, `jurisdiction_id`, `term_start/end` | `source_ids:{courtlistener_person_id}`, `metadata:{court, court_full_name, position_type}` | `governing_body_id` is **senate's** UUID (passed from caller as "proxy for federal judiciary — good enough for Phase 1"); dedupe via `filter("source_ids->>courtlistener_person_id", ...)` | None |
| 9 | `courtlistener/index.ts:259` | `proposals` | INSERT | `title=case_name`, `type="other"`, `status="enacted"`, `jurisdiction_id`, `introduced_at`, `last_action_at`, `full_text_url` | `source_ids:{courtlistener_cluster_id,court_id,scdb_id}`, `metadata:{court, source, syllabus}` | Dedupe via `filter("source_ids->>courtlistener_cluster_id", ...)` | None |
| 10 | `regulations/index.ts:194-195` | `agencies` | INSERT (.select.single) | `name`, `acronym`, `jurisdiction_id`, `agency_type="federal"`, `is_active` | `source_ids:{regulations_gov_agency_id}` | SELECT-first by `acronym`; cached in `agencyIdMap` | None — but warns to stderr if acronym→name mapping is missing |
| 11 | `regulations/index.ts:253` | `proposals` | INSERT | `title`, `type="regulation"`, `status`, `jurisdiction_id`, `regulations_gov_id` (first-class column), `introduced_at`, `comment_period_start`, `comment_period_end`, `full_text_url` | `source_ids:{regulations_gov,docket_id}`, `metadata:{agency_id (acronym string), document_type, object_id}` | Dedupe via `regulations_gov_id` first-class column (not JSON) — cleanest of the proposal writers | None |
| 12 | `fec/index.ts:292` | `financial_relationships` | INSERT | `official_id`, `donor_name`, `donor_type`, `amount_cents`, `cycle_year`, `contribution_date`, `fec_committee_id`, `source_url` | `source_ids:{fec_candidate_id, fec_committee_id}` | Pre-INSERT SELECT on `(official_id, donor_name, cycle_year)` → UPDATE or INSERT | None; aborts whole pipeline on RateLimitError |
| 13 | `fec-bulk/index.ts:594` | `financial_relationships` | INSERT | Same columns as #12 | `source_ids:{…}` | Same SELECT-then-UPDATE-or-INSERT pattern (helper `upsertFinancial`) | None |
| 14 | `fec-bulk/index.ts:646-647` | `financial_entities` | INSERT (.select.single) | `name`, `entity_type`, `industry`, `total_donated_cents` | `source_ids:{fec_committee_id}`, `metadata:{}` | SELECT via `filter("source_ids->>fec_committee_id", …)` | None |
| 15 | `fec-bulk/index.ts:706` | `financial_relationships` | INSERT (PAC→candidate) | `official_id`, `donor_name=info.name`, `donor_type`, `industry`, `amount_cents`, `contribution_date`, `cycle_year`, `fec_committee_id`, `source_url` | `source_ids:{fec_committee_id, source_system:"fec_bulk_pac"}`, `metadata:{tx_count}` | SELECT on `(official_id, fec_committee_id, cycle_year)` | None |
| 16 | `fec-bulk/index.ts:785` | `entity_connections` | INSERT | `from_type="financial"`, `from_id`, `to_type="official"`, `to_id`, `connection_type="donation"`, `strength`, `amount_cents`, `occurred_at`, `is_verified=true` | `evidence:[{source,committee_id,cycle}]`, `metadata:{}` | SELECT on `(from_id, to_id, connection_type)` | None |
| 17 | `financial-entities/index.ts:151-152` | `financial_entities` | INSERT | `name`, `entity_type`, `industry`, `total_donated_cents` | `source_ids:{}` (empty) | SELECT-first on `(name, entity_type)` — **name-based dedup, no FEC ID key on this path** | None |
| 18 | `usaspending/index.ts:214` | `spending_records` | INSERT | `jurisdiction_id`, `awarding_agency` (text, not FK), `recipient_name` (text, not FK to `financial_entities`), `award_type`, `amount_cents`, `total_amount_cents`, `award_date`, `period_of_performance_*`, `usaspending_award_id`, `naics_code`, `cfda_number`, `description`, `recipient_location_jurisdiction_id` | `source_ids:{usaspending_award_id, agency_acronym}`, `metadata:{fiscal_year, agency_acronym}` | `jurisdiction_id` from federal/state map; `recipient_location_jurisdiction_id` from state map; **no FK to agencies** for awarding_agency; SELECT-first by `usaspending_award_id` | Storage budget gate (breaks loop if DB > 200 + budget MB); no retry |
| 19 | `connections/index.ts:164-165` | `entity_connections` | UPSERT (batch, `onConflict:"from_id,to_id,connection_type"`) | `from_type`, `from_id`, `to_type`, `to_id`, `connection_type`, `strength`, `amount_cents`, `evidence[]` | `evidence` (JSON array) | — (derives from already-joined `votes.proposal_id`) | Per-batch retry (3×) but only on `timeout` errors; 100 ms throttle between batches |
| 20 | `connections/index.ts:314-315` | `financial_entities` | UPSERT (`onConflict:"name,entity_type"`) | `name`, `entity_type`, `total_donated_cents`, `updated_at` | — (omits `source_ids` so DB default `'{}'` applies) | Aggregation key = uppercased `donor_name` + `donor_type`; **name-based, collides donors with identical names** | None (same 3× timeout retry as #19 at the batch level) |
| 21 | `connections/index.ts:555,693,736,760` (4 call sites) | `pipeline_state` | UPSERT (`onConflict:"key"`) | `key`, `value` (JSON), `updated_at` | `value` | — | Recency guard: skips whole pipeline if last run < 4 h ago (unless `--force`) |
| 22 | `connections/delta.ts:52` | `pipeline_state` | UPSERT | `key`, `value:{last_run, …merged}` | `value` | Reads existing value first to merge (preserves `last_vote_id`) | — |
| 23 | `connections/delta.ts:170` | `financial_entities` | INSERT (.select.single) | `name`, `entity_type`, `total_donated_cents` | `source_ids:{}` | SELECT on `(name, entity_type)` | None — **parallel implementation to #17 and #20, with slightly different aggregation semantics** |
| 24 | `connections/delta.ts:179` | `entity_connections` | UPSERT (`onConflict:"from_id,to_id,connection_type"`) | `from_type="financial"`, `from_id`, `to_type="official"`, `to_id`, `connection_type="donation"`, `strength`, `amount_cents` | `evidence:[{source,amount_cents,election_cycles,url}]` | Donor entity ID resolved via in-memory map | None |
| 25 | `connections/delta.ts:207` | `entity_connections` | UPSERT (same onConflict) | `from_type="official"`, `from_id`, `to_type="proposal"`, `to_id`, `connection_type`, `strength=1.0` | `evidence:[{source,vote_date,roll_call,chamber,session,roll_call_key}]` | Joins `votes` to `proposals!proposal_id` for `vote_category` + `title` | None |
| 26 | `tags/rules.ts:215` (via `upsertWithRetry` helper) | `entity_tags` | UPSERT (`onConflict:"entity_type,entity_id,tag,tag_category"`) | `entity_type`, `entity_id`, `tag`, `tag_category`, `display_label`, `display_icon`, `visibility`, `generated_by`, `confidence`, `ai_model`, `pipeline_version` | `metadata` | `entity_id` is a string with no FK to the target entity — see observation #10 | Retry 3× with exponential backoff (500/1000/2000 ms) on any error, comment says for "schema cache" races |
| 27 | `tags/ai-tagger.ts:227` (proposal path) | `entity_tags` | UPSERT | Same shape as #26 | `metadata:{reasoning, affects_individuals, is_primary}` | — | No retry wrapper here (only rules.ts wraps it) |
| 28 | `tags/ai-tagger.ts:408` (official path) | `entity_tags` | UPSERT | Same shape | `metadata:{is_primary, rank}` | — | No retry wrapper |
| 29 | `tags/ai-tagger.ts:677` | `pipeline_state` | UPSERT | `key="tags_last_run"`, `value:{last_run}` | `value` | — | — |
| 30 | `tags/ai-classifier.ts:236` (PAC industry) | `entity_tags` | UPSERT | `entity_type="financial_entity"`, `entity_id=pac.id`, `tag=industry`, `tag_category="industry"` | `metadata:{reasoning}` | `entity_id` references `financial_entities.id` but no FK enforces this | 150 ms delay between items; no retry |
| 31 | `enrichment/seed-backlog.ts:236` | `enrichment_queue` | UPSERT (`onConflict:"entity_id,entity_type,task_type"`, `ignoreDuplicates:false`) | `entity_id`, `entity_type`, `task_type`, `context`, `status="pending"`, `claimed_at=null`, `claimed_by=null`, `last_error=null` | `context` (JSON) | — | Pre-fetches existing queue snapshot → classifies `created / retried / skipped_done / skipped_pending` before writing |
| 32 | `enrichment/queue.ts:36` (RPC) | `enrichment_queue` | via RPC `enqueue_enrichment(p_entity_id, p_entity_type, p_task_type, p_context)` | — (DB function decides) | `context` | — | The RPC encapsulates retry semantics — the only place where queue-with-retry exists |
| 33 | `ai-summaries/index.ts:100` | `ai_summary_cache` | UPSERT (`onConflict:"entity_type,entity_id,summary_type"`) | `entity_type`, `entity_id`, `summary_type`, `summary_text`, `model`, `tokens_used` | `metadata` | `entity_id` — no FK to proposals/officials | — |
| 34 | `ai-summaries/index.ts:114` | `api_usage_logs` | INSERT | `service="anthropic"`, `endpoint`, `model`, `tokens_used`, `input_tokens`, `output_tokens`, `cost_cents` | — | — | — |
| 35 | `ai-summaries/index.ts:658` | `pipeline_state` | UPSERT | `key="ai_summaries_last_run"`, `value:{last_run}` | `value` | — | — |
| 36 | `sync-log.ts:21-22` | `data_sync_log` | INSERT (.select.single) | `pipeline`, `status="running"`, `started_at` | — | — | Errors are swallowed (pipeline continues with empty log id) |
| 37 | `pipelines/index.ts:545` | `pipeline_state` | UPSERT | `key="cron_last_run"`, `value:{started_at, completed_at, status, results}` | `value` | — | — |
| 38 | `pipelines/index.ts:561` | `data_sync_log` | INSERT | `pipeline_name="nightly_cron"`, `status`, `started_at`, `completed_at`, `rows_inserted` | `metadata:results` | — | Note: this writes **`pipeline_name`** while `sync-log.ts:22` writes **`pipeline`** — two different column names for the same logical field (one is wrong, or the table has both) |

## Writer catalog — UPDATE only (enrichment / patching passes)

Not insert/upsert — but they change writer behavior and belong in the mental model.

| # | File:Line | Table | Columns updated | Notes |
|---|---|---|---|---|
| U1 | `usaspending/index.ts:207` | `spending_records` | `amount_cents`, `updated_at` | Update branch of the SELECT+INSERT pattern |
| U2 | `fec/index.ts:288` | `financial_relationships` | `amount_cents`, `updated_at` | Update branch |
| U3 | `fec-bulk/index.ts:586-590` | `financial_relationships` | `amount_cents`, `source_ids`, `updated_at` | `upsertFinancial` update branch |
| U4 | `fec-bulk/index.ts:633-642` | `financial_entities` | `name`, `entity_type`, `industry`, `total_donated_cents`, `updated_at` | `upsertFinancialEntity` update branch |
| U5 | `fec-bulk/index.ts:697-703` | `financial_relationships` | `amount_cents`, `contribution_date`, `updated_at` | PAC path update branch |
| U6 | `fec-bulk/index.ts:760-768` | `entity_connections` | `strength`, `amount_cents`, `occurred_at`, `evidence`, `updated_at` | PAC connection update branch |
| U7 | `fec/index.ts:244-246` | `officials` | `source_ids` merged to add `fec_candidate_id` | Back-references the FEC candidate ID into the official so future runs skip the search |
| U8 | `openstates/index.ts:213-215` | `officials` | whole record | Update branch |
| U9 | `courtlistener/index.ts:167-169` | `officials` | whole record | Update branch |
| U10 | `courtlistener/index.ts:254-256` | `proposals` | `updated_at` only | Barely an update — keeps `updated_at` fresh; doesn't correct stale titles/metadata |
| U11 | `congress/votes.ts:858-861` | `proposals` | `status`, `updated_at` | Refreshes bill status only — does not correct `title` even if it was previously set to a vote-question |
| U12 | `regulations/index.ts:247-249` | `proposals` | whole record + `updated_at` | Full re-write of the row on every run |
| U13 | `financial-entities/index.ts:134-141` | `financial_entities` | `industry`, `total_donated_cents`, `updated_at` | — |
| U14 | `connections/delta.ts:168` | `financial_entities` | `total_donated_cents`, `updated_at` | — |
| U15 | `agencies-hierarchy/index.ts:141-143` | `agencies` | `parent_agency_id`, `updated_at` | Static mapping pass |
| U16 | `agencies-hierarchy/index.ts:173-176` | `agencies` | `usaspending_agency_id` | Best-effort sweep from USASpending toptier API |
| U17 | `elections/index.ts:149-153` | `officials` | `current_term_start`, `current_term_end`, `next_election_date`, `next_election_type`, `is_up_for_election` | Full-table pass, 1000-row pages |
| U18 | `pac-classify/index.ts:189-192` | `financial_relationships` | `metadata` (merge `sector` into existing JSON) | 500-row parallel batches; overwrites entire metadata blob |
| U19 | `congress/officials.ts:165-168` | `officials` | Whole record | Update branch (when bioguideId already known) |
| U20 | `sync-log.ts:39-46` | `data_sync_log` | `status`, `completed_at`, `rows_*`, `estimated_mb` | Run completion |
| U21 | `sync-log.ts:57-61` | `data_sync_log` | `status="failed"`, `completed_at`, `error_message` | Run failure |

## Writer catalog — RPCs

| # | File:Line | RPC | Purpose |
|---|---|---|---|
| R1 | `sync-log.ts:71` | `get_database_size_bytes()` | Read-only size check (not a writer but drives budget gates) |
| R2 | `enrichment/queue.ts:36` | `enqueue_enrichment(p_entity_id, p_entity_type, p_task_type, p_context)` | Insert-or-retry on `enrichment_queue` with server-side logic |
| R3 | `pipelines/index.ts:490` | `refresh_proposal_trending()` | Refresh materialized view for the trending tab (FIX-029) |

**Pipeline directories with no writers at all:** `govtrack-cosponsors/`, `federal-register/`, `opensecrets-bulk/`. These look like stubs — worth deciding in Stage 0 whether to implement or delete.

---

## Tables touched (count of writer call sites per table, excluding updates)

| Table | Writers | Pipelines that write |
|---|---|---|
| `proposals` | 4 | congress.votes (×2 — `findOrCreateProposal` + bill-list branch), courtlistener, regulations |
| `officials` | 4 | congress.officials, openstates, courtlistener, (+ elections, agencies-hierarchy, fec update-only) |
| `votes` | 2 | congress.votes (House + Senate XML paths) |
| `financial_relationships` | 3 | fec (API), fec-bulk weball, fec-bulk PAC |
| `financial_entities` | 3 | fec-bulk (per-committee), financial-entities (aggregation), connections.index + delta |
| `entity_connections` | 4 | fec-bulk (PAC→official direct), connections.index (batch), connections.delta (×2) |
| `entity_tags` | 4 | tags.rules, tags.ai-tagger (×2: proposals & officials), tags.ai-classifier |
| `agencies` | 1 | regulations (+ agencies-hierarchy update-only) |
| `governing_bodies` | 1 | openstates |
| `spending_records` | 1 | usaspending |
| `enrichment_queue` | 2 | enrichment.seed-backlog (direct), enrichment.queue (via RPC) |
| `ai_summary_cache` | 1 | ai-summaries |
| `api_usage_logs` | 1 | ai-summaries |
| `data_sync_log` | 2 | sync-log, pipelines.index (nightly cron) |
| `pipeline_state` | 7+ | connections (×5), tags.ai-tagger, ai-summaries, pipelines.index |

---

## Things I wasn't expecting

1. **The "vote-question as proposal title" bug isn't a single-line fix in one file — it's `findOrCreateProposal` being called from vote processing.** At `congress/votes.ts:524` and `:701`, `title` is computed as `voteQuestion || "${type} ${number}"`. If the vote pipeline runs before the bill-list API pipeline for that bill, the first roll call's `vote-question` string ("On Passage", "On the Cloture Motion") becomes the proposal's permanent title — because subsequent calls return `existing` unchanged. The update branch at `:858-861` only refreshes `status`, never `title`. So a contaminated title is sticky. This matters for Stage 0 because: (a) the fix isn't just in the `:886` branch the spec called out, and (b) whatever the new schema is, proposals need to be ingested **before** votes or votes need a bill-resolution queue, not a synth-and-hope path.

2. **The spec's grep pattern misses several writer call sites.** `\.from\("[^"]*"\)\.(insert|upsert)` is single-line. Several writers wrap across lines (e.g. `congress/votes.ts:598-599`, `financial-entities/index.ts:151-152`, `connections/index.ts:164-165`). A multiline grep finds ~14 additional sites including **both vote inserts** — arguably the most important writers in the whole tree. Worth noting in the spec so the next session doesn't also miss them.

3. **`createAdminClient()` is called ad-hoc throughout.** `sync-log.ts` creates a fresh client for every log call (4 helpers × N pipelines × N runs). Not catastrophic, but under the rebuild it would be cleaner to pass one admin client through.

4. **CourtListener writes federal judges' `governing_body_id = senateId`**, via a passed-in argument the standalone entrypoint describes as "Use Senate governing body as proxy for federal judiciary — good enough for Phase 1" (`courtlistener/index.ts:307`). Every federal judge in the DB currently has `governing_body_id` pointing at the Senate. This isn't on the known-issues list in the spec.

5. **`officials.metadata` is written with genuinely different shapes by every ingestion path.** Congress writes `{}`. OpenStates writes `{state_abbr, org_classification}`. CourtListener writes `{court, court_full_name, position_type}`. Nobody writes `{state: "..."}` — yet `tags/ai-tagger.ts:378` reads `official.metadata?.state` and falls back to `"Unknown"`. So the AI classifier has been running on `state: "Unknown"` for every official, silently. The FIX-071 symptom is a downstream effect of this shape inconsistency, not just the duplicate-state issue the spec names.

6. **There are *three* donor-aggregation paths writing to `financial_entities` with subtly different keys.**
   - `fec-bulk/index.ts:646` → keys by `source_ids->>fec_committee_id` (correct for PACs)
   - `financial-entities/index.ts:151` → keys by `(name, entity_type)` (text, case-folded)
   - `connections/index.ts:314` + `connections/delta.ts:170` → keys by `(name, entity_type)` as well
   
   These collide. A PAC written via #1 will not match a re-aggregation via #2 if names differ. And two legitimately different donors sharing a name merge silently under #2/#3. This is a design bug, not a data bug — the "canonical financial entity" concept isn't defined anywhere.

7. **Dedup happens seven different ways.** Native `.upsert(onConflict: …)` for `entity_tags`, `entity_connections`, `financial_entities` (in connections path only), `pipeline_state`, `ai_summary_cache`, `enrichment_queue`. SELECT-then-INSERT for everyone else, half the time via a JSON path operator (`filter("source_ids->>X", "eq", …)`) that cannot be indexed as a true unique constraint. The SELECT-then-INSERT path is inherently racy and non-idempotent under concurrent runs. The new schema needs real unique indexes on every (source_id) first-class column so native upsert works everywhere.

8. **`source_ids` JSONB is being used as the primary dedup key by 5+ pipelines.** This forces SELECT-first-then-write, which forbids native upsert, which makes pipelines non-atomic. Pulling every `source_ids.*` field out to a proper typed column with a unique index is one of the largest single wins available in the rebuild.

9. **Votes insert swallows 23505 unique-violation errors with a comment saying "apply migration 0002 to widen the unique constraint."** At `congress/votes.ts:603-606` and `:781-784`. Migration 0002 apparently hasn't landed, so currently only the **first** roll call per bill is persisted — subsequent roll calls on the same bill silently no-op. This means the vote count in the DB is an undercount, not a bug I've seen mentioned in audit findings.

10. **`entity_tags`, `ai_summary_cache`, `enrichment_queue`, and `api_usage_logs` all store `entity_id` as a plain string with no foreign key back to `proposals` / `officials` / `financial_entities`.** Cascade on delete doesn't work. Orphan rows are possible and likely exist. The spec flagged this suspicion for `entity_tags` and `ai_summary_cache`; confirmed here for all four.

11. **`spending_records.recipient_name` is raw text, not a FK to `financial_entities`.** So USAspending recipients and FEC donors live in separate string namespaces. The connection graph can never link "Lockheed Martin (federal contractor)" to "Lockheed Martin PAC" through schema alone. This is a missed edge for the graph-first principle.

12. **`data_sync_log` has two writer call sites with two different column names.** `sync-log.ts:22` writes `pipeline`; `pipelines/index.ts:562` writes `pipeline_name`. One of them is silently failing to populate the intended column, or the table literally has both columns. Either way, reads that filter by one miss rows written the other way. Worth checking the schema before doing anything else.

13. **`connections/delta.ts` duplicates the aggregation logic in `connections/index.ts`** rather than sharing a helper. Their evidence payloads and edge-case handling differ slightly (delta uses `source_url` as evidence URL fallback; full uses a constant). A Stage-1 rewrite should consolidate — one pipeline should produce one shape of connection row, always.

14. **The only real retry/queue infrastructure is `enqueue_enrichment` (RPC) for AI tasks.** Ingestion pipelines have no durable retry queue. If Congress.gov is down for a session, votes are lost for that session. If the current design asks for "queue for retry when bill isn't in yet," that infrastructure doesn't exist — it'd be new in Stage 1.

15. **`pipeline_state` is the closest thing to a pipeline-orchestration layer the codebase has**, and it's a key/value table with a JSONB value column written from 7+ call sites. Some keys are recency guards, some are cursor positions (`last_relationship_id`, `last_vote_id`), some are egress meters, some are nightly-cron summaries. This is doing the work of a scheduler + state store + run log. Worth being explicit in the new schema about which of these are truly durable state vs. which should be proper tables (run log, cursor state, recency locks are three different things).

16. **`regulations.gov` is actually the cleanest pipeline in the tree** — it uses `regulations_gov_id` as a first-class column (not a JSON path), `agencies` is a real FK, and the dedup key is indexable. If the rebuild wants a template for "good ingestion" this is the one to look at. The others are all variations on "stuff it into JSON and query it back out."

17. **Per spec answer #2 (proposals structure + initiatives):** initiatives don't appear anywhere in the current writer catalog. There's no pipeline feeding them and no table being written to called `initiatives`. Whatever the final shape, initiatives are greenfield — good news, no legacy to migrate. Worth a separate Stage-0 sub-question: are initiatives "proposals with `type='initiative'`," or their own table, or a view over user-submitted legislative petitions? The answer interacts directly with the unified-vs-split decision.
