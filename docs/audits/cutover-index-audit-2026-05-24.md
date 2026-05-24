# Cutover-dropped-indexes audit — 2026-05-24

- Ran at: `2026-05-24T06:32:38.902Z`
- DB host: `aws-0-us-west-2.pooler.supabase.com:5432`
- Pre-cutover migrations scanned: 62
- Pre-cutover CREATE INDEX statements extracted: 230
- Live `public` indexes on target DB: 344

Buckets:
- PRESENT: 179
- MISSING_UNEXPLAINED: 14
- INTENTIONAL_REPLACED: 0
- INTENTIONAL_RESHAPED: 13
- INTENTIONAL_DROPPED: 24

## Front page: MISSING_UNEXPLAINED (14)

High-signal triage list. Each row is an index that existed in pre-cutover
migration history but was not found by any other heuristic (no same-name
rebuild, no same-table+columns reshape, no explicit DROP INDEX). For each,
decide: restore as-is / restore with new shape / intentionally dropped.

| index_name | table | columns | source_migration | notes | raw_statement |
|---|---|---|---|---|---|
| `entity_connections_occurred_at` | `entity_connections` | occurred_at | `0001_initial_schema.sql` |  | `CREATE INDEX IF NOT EXISTS entity_connections_occurred_at ON entity_connections(occurred_at)` |
| `votes_updated_at` | `votes` | updated_at | `0001_initial_schema.sql` |  | `CREATE INDEX IF NOT EXISTS votes_updated_at ON votes(updated_at)` |
| `financial_relationships_updated_at` | `financial_relationships` | updated_at | `0001_initial_schema.sql` |  | `CREATE INDEX IF NOT EXISTS financial_relationships_updated_at ON financial_relationships(updated_at)` |
| `users_updated_at` | `users` | updated_at | `0001_initial_schema.sql` |  | `CREATE INDEX IF NOT EXISTS users_updated_at ON users(updated_at)` |
| `financial_entities_total_donated` | `financial_entities` | total_donated_cents | `0004_financial_entities_and_connections_unique.sql` |  | `CREATE INDEX IF NOT EXISTS financial_entities_total_donated ON financial_entities(total_donated_cents DESC)` |
| `financial_entities_updated_at` | `financial_entities` | updated_at | `0004_financial_entities_and_connections_unique.sql` |  | `CREATE INDEX IF NOT EXISTS financial_entities_updated_at ON financial_entities(updated_at)` |
| `idx_proposals_fts` | `proposals` | to_tsvector('english', title || ' ' ||
      coalesce(summary_plain, '' | `0008_search_indexes.sql` |  | `CREATE INDEX IF NOT EXISTS idx_proposals_fts ON proposals USING GIN ( to_tsvector('english', title \|\| ' ' \|\| COALESCE(summary_plain, '')` |
| `proposals_federal_register_pub_date` | `proposals` | federal_register_publication_date desc | `20260420010000_federal_register.sql` |  | `CREATE INDEX IF NOT EXISTS proposals_federal_register_pub_date ON proposals(federal_register_publication_date DESC NULLS LAST)` |
| `enrichment_queue_active_unique` | `enrichment_queue` | entity_type, entity_id, enrichment_type | `20260421000006_stage1_07_queues.sql` |  | `CREATE UNIQUE INDEX IF NOT EXISTS enrichment_queue_active_unique ON shadow.enrichment_queue(entity_type, entity_id, enrichment_type)` |
| `enrichment_queue_pending` | `enrichment_queue` | status, priority, created_at | `20260421000006_stage1_07_queues.sql` |  | `CREATE INDEX IF NOT EXISTS enrichment_queue_pending ON shadow.enrichment_queue(status, priority, created_at)` |
| `enrichment_queue_worker` | `enrichment_queue` | worker_id, status | `20260421000006_stage1_07_queues.sql` |  | `CREATE INDEX IF NOT EXISTS enrichment_queue_worker ON shadow.enrichment_queue(worker_id, status)` |
| `enrichment_queue_entity` | `enrichment_queue` | entity_type, entity_id | `20260421000006_stage1_07_queues.sql` |  | `CREATE INDEX IF NOT EXISTS enrichment_queue_entity ON shadow.enrichment_queue(entity_type, entity_id)` |
| `pipeline_state_updated_at` | `pipeline_state` | updated_at | `20260421000006_stage1_07_queues.sql` |  | `CREATE INDEX IF NOT EXISTS pipeline_state_updated_at ON shadow.pipeline_state(updated_at DESC)` |
| `data_sync_log_status` | `data_sync_log` | status | `20260421000006_stage1_07_queues.sql` |  | `CREATE INDEX IF NOT EXISTS data_sync_log_status ON shadow.data_sync_log(status)` |


## Collapsed: INTENTIONAL_* (37 total)

<details>
<summary>INTENTIONAL_REPLACED (0) — same name recreated by cutover or later migration</summary>

_(none)_


</details>

<details>
<summary>INTENTIONAL_RESHAPED (13) — different name, same (table, column set) — likely partial-index conversion or rename</summary>

| index_name | table | columns | source_migration | notes | raw_statement |
|---|---|---|---|---|---|
| `proposals_governing_body_id` | `proposals` | governing_body_id | `0001_initial_schema.sql` | Live DB has shadow_proposals_governing_body_id covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS proposals_governing_body_id ON proposals(governing_body_id)` |
| `proposals_jurisdiction_id` | `proposals` | jurisdiction_id | `0001_initial_schema.sql` | Live DB has shadow_proposals_jurisdiction_id covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS proposals_jurisdiction_id ON proposals(jurisdiction_id)` |
| `proposals_type` | `proposals` | type | `0001_initial_schema.sql` | Live DB has shadow_proposals_type covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS proposals_type ON proposals(type)` |
| `proposals_status` | `proposals` | status | `0001_initial_schema.sql` | Live DB has shadow_proposals_status covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS proposals_status ON proposals(status)` |
| `proposals_search_vector` | `proposals` | search_vector | `0001_initial_schema.sql` | Live DB has shadow_proposals_search_vector covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS proposals_search_vector ON proposals USING GIN(search_vector)` |
| `proposals_title_trgm` | `proposals` | title | `0001_initial_schema.sql` | Live DB has shadow_proposals_title_trgm covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS proposals_title_trgm ON proposals USING GIN(title gin_trgm_ops)` |
| `financial_relationships_cycle_year` | `financial_relationships` | cycle_year | `0001_initial_schema.sql` | Live DB has financial_relationships_cycle covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS financial_relationships_cycle_year ON financial_relationships(cycle_year)` |
| `votes_official_id` | `votes` | official_id | `0001_initial_schema.sql` | Live DB has votes_official covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS votes_official_id ON votes(official_id)` |
| `proposals_updated_at` | `proposals` | updated_at | `0001_initial_schema.sql` | Live DB has shadow_proposals_updated_at covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS proposals_updated_at ON proposals(updated_at)` |
| `financial_entities_entity_type` | `financial_entities` | entity_type | `0004_financial_entities_and_connections_unique.sql` | Live DB has financial_entities_type covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS financial_entities_entity_type ON financial_entities(entity_type)` |
| `idx_proposals_title_trgm` | `proposals` | title | `0008_search_indexes.sql` | Live DB has shadow_proposals_title_trgm covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS idx_proposals_title_trgm ON proposals USING GIN (title gin_trgm_ops)` |
| `data_sync_log_pipeline` | `data_sync_log` | pipeline, started_at | `20260421000006_stage1_07_queues.sql` | Live DB has idx_data_sync_log_pipeline covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS data_sync_log_pipeline ON shadow.data_sync_log(pipeline, started_at DESC)` |
| `data_sync_log_started_at` | `data_sync_log` | started_at | `20260421000006_stage1_07_queues.sql` | Live DB has idx_data_sync_log_started_at covering the same (table, columns). | `CREATE INDEX IF NOT EXISTS data_sync_log_started_at ON shadow.data_sync_log(started_at DESC)` |


</details>

<details>
<summary>INTENTIONAL_DROPPED (24) — explicit DROP INDEX in cutover or post-cutover migration</summary>

| index_name | table | columns | source_migration | notes | raw_statement |
|---|---|---|---|---|---|
| `proposals_comment_period_end` | `proposals` | comment_period_end | `0001_initial_schema.sql` | Column(s) no longer exist on public.proposals: comment_period_end. | `CREATE INDEX IF NOT EXISTS proposals_comment_period_end ON proposals(comment_period_end)` |
| `financial_relationships_official_id` | `financial_relationships` | official_id | `0001_initial_schema.sql` | Column(s) no longer exist on public.financial_relationships: official_id. | `CREATE INDEX IF NOT EXISTS financial_relationships_official_id ON financial_relationships(official_id)` |
| `financial_relationships_donor_name_trgm` | `financial_relationships` | donor_name | `0001_initial_schema.sql` | Column(s) no longer exist on public.financial_relationships: donor_name. | `CREATE INDEX IF NOT EXISTS financial_relationships_donor_name_trgm ON financial_relationships USING GIN(donor_name gin_trgm_ops)` |
| `financial_relationships_industry` | `financial_relationships` | industry | `0001_initial_schema.sql` | Column(s) no longer exist on public.financial_relationships: industry. | `CREATE INDEX IF NOT EXISTS financial_relationships_industry ON financial_relationships(industry)` |
| `spending_records_jurisdiction_id` | `spending_records` | jurisdiction_id | `0001_initial_schema.sql` | Table public.spending_records no longer exists. | `CREATE INDEX IF NOT EXISTS spending_records_jurisdiction_id ON spending_records(jurisdiction_id)` |
| `spending_records_recipient_location` | `spending_records` | recipient_location_jurisdiction_id | `0001_initial_schema.sql` | Table public.spending_records no longer exists. | `CREATE INDEX IF NOT EXISTS spending_records_recipient_location ON spending_records(recipient_location_jurisdiction_id)` |
| `spending_records_award_date` | `spending_records` | award_date | `0001_initial_schema.sql` | Table public.spending_records no longer exists. | `CREATE INDEX IF NOT EXISTS spending_records_award_date ON spending_records(award_date)` |
| `spending_records_amount` | `spending_records` | amount_cents | `0001_initial_schema.sql` | Table public.spending_records no longer exists. | `CREATE INDEX IF NOT EXISTS spending_records_amount ON spending_records(amount_cents DESC)` |
| `spending_records_awarding_agency` | `spending_records` | awarding_agency | `0001_initial_schema.sql` | Table public.spending_records no longer exists. | `CREATE INDEX IF NOT EXISTS spending_records_awarding_agency ON spending_records(awarding_agency)` |
| `users_privy_user_id` | `users` | privy_user_id | `0001_initial_schema.sql` | Column(s) no longer exist on public.users: privy_user_id. | `CREATE INDEX IF NOT EXISTS users_privy_user_id ON users(privy_user_id)` |
| `users_district_jurisdiction_id` | `users` | district_jurisdiction_id | `0001_initial_schema.sql` | Column(s) no longer exist on public.users: district_jurisdiction_id. | `CREATE INDEX IF NOT EXISTS users_district_jurisdiction_id ON users(district_jurisdiction_id)` |
| `votes_proposal_id` | `votes` | proposal_id | `0001_initial_schema.sql` | Column(s) no longer exist on public.votes: proposal_id. | `CREATE INDEX IF NOT EXISTS votes_proposal_id ON votes(proposal_id)` |
| `entity_connections_updated_at` | `entity_connections` | updated_at | `0001_initial_schema.sql` | Column(s) no longer exist on public.entity_connections: updated_at. | `CREATE INDEX IF NOT EXISTS entity_connections_updated_at ON entity_connections(updated_at)` |
| `spending_records_updated_at` | `spending_records` | updated_at | `0001_initial_schema.sql` | Table public.spending_records no longer exists. | `CREATE INDEX IF NOT EXISTS spending_records_updated_at ON spending_records(updated_at)` |
| `financial_entities_name` | `financial_entities` | name | `0004_financial_entities_and_connections_unique.sql` | Column(s) no longer exist on public.financial_entities: name. | `CREATE INDEX IF NOT EXISTS financial_entities_name ON financial_entities(name)` |
| `idx_financial_entities_name_trgm` | `financial_entities` | name | `0030_search_financial_index.sql` | Column(s) no longer exist on public.financial_entities: name. | `CREATE INDEX IF NOT EXISTS idx_financial_entities_name_trgm ON financial_entities USING GIN (name gin_trgm_ops)` |
| `civic_initiatives_stage` | `civic_initiatives` | stage | `20260411010026_civic_initiatives.sql` | Table public.civic_initiatives no longer exists. | `CREATE INDEX IF NOT EXISTS civic_initiatives_stage ON civic_initiatives(stage)` |
| `civic_initiatives_author` | `civic_initiatives` | primary_author_id | `20260411010026_civic_initiatives.sql` | Table public.civic_initiatives no longer exists. | `CREATE INDEX IF NOT EXISTS civic_initiatives_author ON civic_initiatives(primary_author_id)` |
| `civic_initiatives_proposal` | `civic_initiatives` | linked_proposal_id | `20260411010026_civic_initiatives.sql` | Table public.civic_initiatives no longer exists. | `CREATE INDEX IF NOT EXISTS civic_initiatives_proposal ON civic_initiatives(linked_proposal_id)` |
| `civic_initiatives_scope` | `civic_initiatives` | scope | `20260411010026_civic_initiatives.sql` | Table public.civic_initiatives no longer exists. | `CREATE INDEX IF NOT EXISTS civic_initiatives_scope ON civic_initiatives(scope)` |
| `civic_initiatives_tags` | `civic_initiatives` | issue_area_tags | `20260411010026_civic_initiatives.sql` | Table public.civic_initiatives no longer exists. | `CREATE INDEX IF NOT EXISTS civic_initiatives_tags ON civic_initiatives USING GIN(issue_area_tags)` |
| `civic_initiatives_parent_problem` | `civic_initiatives` | parent_problem_id | `20260418000000_comment_types.sql` | Table public.civic_initiatives no longer exists. | `CREATE INDEX IF NOT EXISTS civic_initiatives_parent_problem ON public.civic_initiatives(parent_problem_id)` |
| `civic_initiatives_from_comment` | `civic_initiatives` | from_comment_id | `20260418000000_comment_types.sql` | Table public.civic_initiatives no longer exists. | `CREATE INDEX IF NOT EXISTS civic_initiatives_from_comment ON public.civic_initiatives(from_comment_id)` |
| `financial_entities_industry` | `financial_entities` | industry | `20260421000004_stage1_05_financial.sql` | DROP INDEX in cutover or post-cutover migration. | `CREATE INDEX IF NOT EXISTS financial_entities_industry ON shadow.financial_entities(industry)` |


</details>

## PRESENT — 179 pre-cutover indexes still live on the DB.

_(No table — these are the happy path. See JSON output for the full list.)_
