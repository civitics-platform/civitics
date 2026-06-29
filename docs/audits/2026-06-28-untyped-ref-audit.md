# Untyped DB-reference audit — 2026-06-28

**Scope:** every place in the repo that names a DB column / relation / RPC / JSONB
key that does **not** resolve against the live schema, across the surfaces the
TypeScript build cannot catch (PostgREST `42703`/`PGRST200`/`PGRST201` swallowed
by `const { data } =`, or a JSONB filter that silently returns zero rows). Same
bug class as FIX-675/676 (agencies.slug; enrichment_queue.enrichment_type).

**Method:** a live-DB **gate** (ground truth) was built first from the local
Docker DB (`local == prod` schema, confirmed) — `information_schema.columns`
(G1), installed `pg_get_functiondef` / `pg_views` / `pg_matviews` bodies (G2),
`pg_proc` signatures (G3), and live `jsonb_object_keys` population for the 5 hot
tables (G4) — plus `packages/db/src/types/database.ts` relationships. Then 7
surface workers (one per surface) grepped the repo and validated **only** against
the gate; every candidate finding was independently re-checked by an adversarial
verifier (default-to-refute); a completeness critic swept for missed instances;
and a final main-thread consolidation re-verified every surviving finding **and
every proposed fix target** against a grep-robust column catalog. 34 agents,
2.18M tokens.

**Gate corrected three stale calibrations** before any worker ran (the gate
overrides docs/CLAUDE.md where they disagree):

| Claim (prior docs / prompt) | Live-DB reality (gate) |
|---|---|
| `votes.metadata->>'legis_num'` is unpopulated | **83.3% populated** — live, do not flag |
| `officials` has no `source_ids` column | **`officials.source_ids` EXISTS** (jsonb) — anchor-verify:237/271 are valid |
| `financial_entities` keyed on `source_ids->>'fec_committee_id'` (packages/data CLAUDE.md) | **No `source_ids` column; `fec_committee_id` is a first-class column** — FEC writer already uses it (`onConflict: "fec_committee_id"`) |

Other ground-truth facts the gate established: `entity_connections.metadata` is
**empty for all 5.68M rows** (any `->>'k'` filter returns zero);
`entity_connections.is_verified` does **not** exist (CLAUDE.md lists it — stale);
`financial_relationships.source_ids` does **not** exist (it uses
`metadata->>'source'`).

---

## Summary — findings by surface × confidence

All 26 findings were **confirmed** by adversarial verification (0 false positives
survived). Confidence below is the post-verification value; all landed **high**.

| Surface | Findings | Auto-fixed | Filed (FIX) | Notes |
|---|---:|---:|---:|---|
| **S1** Raw SQL in TS | 0 | – | – | Every raw-SQL col/table/RPC resolves |
| **S2** Migrations + installed bodies | 0 | – | – | Installed bodies uniformly post-rename; dead-col refs only in superseded/historical migrations + comments |
| **S3** PostgREST embeds | 10 | 9 | 1 | 9× `initiative_details` dual-FK ambiguity; 1× nonexistent `civic_initiatives` relation |
| **S4** JSONB path refs | 2 | 0 | 1 | `entity_connections.metadata->>is_current` (empty metadata) — both sites → FIX-692 |
| **S5** RPC calls | 8 | 0 | 4 | Missing/dead RPCs — need migrations (S5 policy = report only) |
| **S6** Builder-reassignment | 1 | 1 | – | `proposals.comment_period_end` (B2) |
| **S7** Dynamic/concat selects | 3 | 3 | – | `proposals.bill_number` (B1), `financial_entities.source_ids` ×2 (B4) |
| **CRITIC** completeness | 2 | 2 | – | `proposals.regulations_gov_id` (B3); `entity_connections.is_verified` upsert key |
| **Total** | **26** | **15** | **6 FIXes (11 findings)** | |

**Auto-applied:** 15 findings (13 code edits across 10 files). `pnpm typecheck`
(10/10 packages) and `pnpm build` pass clean.
**Filed for follow-up:** FIX-691 … FIX-696 (S3 redesign, S4 jsonb, S5 migrations).

---

## Auto-applied fixes (high-confidence, mechanical, gate-confirmed)

Each is a string-identifier change with exactly one correct target. The
`metadata->>key` filter pattern and the `!fkname` FK-qualified embed pattern are
both already used elsewhere in the typed app, so all edits compile.

### S3 — `initiative_details` dual-FK embeds → name the FK (9 edits)

`initiative_details` has **two** FKs to `proposals` (`proposal_id_fkey`,
`promoted_to_proposal_id_fkey`), so a bare `initiative_details(...)` embed from
`proposals` is ambiguous → **PGRST201** → silently empty section. Fix names the
canonical 1:1 link `initiative_details_proposal_id_fkey` (same fix FIX-616
applied to `/franklin`, `initiatives/page.tsx`, `api/initiatives/route.ts` — these
9 call sites were missed by that sweep).

*Gate evidence:* `database.ts` initiative_details Relationships lists both FK
names referencing `proposals`; live `pg_constraint` confirms
`initiative_details_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES proposals(id)`.

| File:line | Embed |
|---|---|
| `apps/civitics/app/initiatives/[id]/page.tsx:39` | `initiative_details(stage, scope)` |
| `apps/civitics/app/initiatives/[id]/page.tsx:152` | `initiative_details(*)` |
| `apps/civitics/app/proposals/[id]/page.tsx:244` | nested `initiative_details(stage, scope, issue_area_tags)` |
| `apps/civitics/app/api/search/route.ts:681` | `initiative_details!inner(stage)` |
| `apps/civitics/app/api/initiatives/[id]/advance/route.ts:34` | `initiative_details(stage, primary_author_id, mobilise_started_at, scope)` |
| `apps/civitics/app/api/initiatives/[id]/gate/route.ts:25` | `initiative_details(stage, mobilise_started_at, scope)` |
| `apps/civitics/app/api/initiatives/[id]/route.ts:27` | `initiative_details(*)` |
| `apps/civitics/app/api/initiatives/[id]/route.ts:131` | `initiative_details(body_md, stage, primary_author_id)` |
| `apps/civitics/app/api/initiatives/[id]/route.ts:231` | `initiative_details(stage)` |

### S6 / B2 — `proposals.comment_period_end` → `metadata->>comment_period_end`

`packages/db/src/queries/proposals.ts:35-36` (`listOpenForComment`) filtered
`.gt("comment_period_end", …)` and ordered `.order("comment_period_end")` on a
**nonexistent column** → the query always returns zero rows (silent). The rest of
the app already reads it from metadata (search/route.ts, dashboard, page.tsx).

*Gate evidence:* `g1` proposals has 25 columns, none named `comment_period_end`;
`g4` proposals `metadata->>'comment_period_end'` present at 1.7% (1350 rows).
**Fix:** `.gt("metadata->>comment_period_end", …)` + `.order("metadata->>comment_period_end")`.

### CRITIC / B3 — `proposals.regulations_gov_id` → `metadata->>regulations_gov_id`

`packages/db/src/queries/proposals.ts:105` (`getProposalByRegulationsGovId`)
`.eq("regulations_gov_id", …)` on a nonexistent column → always zero rows.

*Gate evidence:* not in `g1` proposals; `g4` `metadata->>'regulations_gov_id'`
at 1.7%. **Fix:** `.eq("metadata->>regulations_gov_id", …)`.

### S7 / B1 — `proposals.bill_number` → `bill_details(bill_number)` embed + unwrap

`apps/civitics/app/api/cron/notify-followers/route.ts:167` selected
`bill_number` directly off `proposals` (the followed-agencies block), so the
notification bill-label was always null. The followed-officials block 65 lines
above (line 102) already does it correctly via `bill_details(bill_number)`.

*Gate evidence:* `g1` proposals has no `bill_number`; `bill_details.bill_number`
exists (FK on `proposal_id`). **Fix:** embed `bill_details(bill_number)` and
unwrap the array-vs-object the same way line 106 does.

### S7 / B4 — `financial_entities.source_ids` (2 sites)

`packages/data/src/scripts/cron-run-anchor-verify.ts` selected a nonexistent
`source_ids` column on `financial_entities`.

*Gate evidence:* `g1` — `financial_entities` has **no** `source_ids` column (it
has a first-class `fec_committee_id`). **Fixes:** `:62` drop the dead `source_ids`
(never read); `:282`/`:286` rename `source_ids` → the real `fec_committee_id`
column.

### CRITIC — `entity_connections.is_verified` upsert key

`scripts/seed-agency-officials.ts:156` passed `is_verified: false` in an
`entity_connections.upsert({...})` — the column does not exist, so PostgREST
rejects the payload (`PGRST204`) and the whole seed silently never inserts.

*Gate evidence:* live `entity_connections` columns are `id, from_type, from_id,
to_type, to_id, connection_type, strength, amount_cents, occurred_at, ended_at,
evidence_count, evidence_source, evidence_ids, derived_at, metadata` — **no
`is_verified`** (CLAUDE.md lists it; the doc is stale). **Fix:** drop the key
(the table tracks verification via `evidence_count`/`evidence_source`).

---

## Filed for follow-up (need migration / redesign / semantic judgment)

### S3 — `civic_initiatives` relation does not exist → **FIX-691** (🟠)

`apps/civitics/app/api/officials/[id]/responsiveness/route.ts:19` embeds
`civic_initiatives!initiative_id(id, title, scope)` on base table
`civic_initiative_responses`, but **there is no `civic_initiatives` table** →
**PGRST200 → the route 500s**. Not a one-token rename: `initiative_id` FK targets
`proposals`, and `proposals` has no `scope` (scope is on `initiative_details`).

*Gate evidence:* `g1` has no `civic_initiatives.*` rows;
`civic_initiative_responses.initiative_id` exists; `proposals` has no `scope`.

### S4 — `entity_connections.metadata->>is_current` silent-zero → **FIX-692** (🟠)

`packages/data/src/pipelines/agency-leadership/index.ts:145` and
`packages/data/src/pipelines/plum-book/index.ts:238` (both `closeStaleConnections`)
filter `.filter("metadata->>is_current", "eq", "true")` — but
`entity_connections.metadata` is empty for **all 5.68M rows** → the filter matches
nothing and stale appointment edges are never closed.

*Gate evidence:* `g4` returns **zero** jsonb keys for `entity_connections`
(metadata `{}`/null across the table). **Fix direction:** use the first-class
`.is("ended_at", null)` (`ended_at` exists per `g1`; the rebuild stamps it,
NULL = active).

### S5 — missing / dead RPCs (need migrations) → **FIX-693/694/695/696** (🟡/🟢)

S5 policy is report-only (each needs a migration). All degrade without a 500
(try/catch, `void`, or a fallback path), but the intended effect silently never
happens.

| RPC | Call sites | Gate (g3) | FIX |
|---|---|---|---|
| `find_entity_path` ×2, `find_shortest_path` ×1 | snapshot/route.ts:491, pathfinder/route.ts:26, entity-connections.ts:88 | absent | **FIX-693** |
| `increment_snapshot_view` ×2 | graph/[code]/page.tsx:48, snapshot/route.ts:1353 | absent | **FIX-694** |
| `increment_service_usage` ×1 | track-usage/route.ts:32 | absent | **FIX-695** |
| `exec_sql_json` (drain/status.ts:22, has fallback), `noop_skip` (anchor-verify.ts:90, dead) | 2 | absent | **FIX-696** |

---

## Negative results (clean surfaces — not gaps)

- **S1 (raw SQL in TS):** 0. heavy-rebuild, drain, cron scripts, FEC/USASpending/
  LittleSis writers, the franklin seed (~25 tables of INSERT/UPDATE column lists)
  all validate against `g1`. FEC writer correctly keys `financial_entities` on the
  first-class `fec_committee_id` (`onConflict: "fec_committee_id"`) — the
  packages/data CLAUDE.md prose describing `source_ids->>'fec_committee_id'` is
  stale but the code is correct.
- **S2 (migrations + installed bodies):** 0. Installed function/view/MV bodies
  uniformly use post-rename columns. Dead-column refs (`votes.proposal_id`,
  `vote_cast`/`vote_date`) appear only in **superseded** pre-promotion migrations
  (append-only history) and one fix-documenting header comment — known false
  positives, not live. `compute_alignment_score`'s installed body correctly joins
  `v.bill_proposal_id` (the FIX-438 fix).
- **Calibration confirmed:** `votes.metadata->>'legis_num'` (83% live) and
  `officials.source_ids` (real jsonb) were **not** flagged.

---

## Notes for future audits

- Build the gate column catalog in a **grep-robust** form (`table.column`, one
  per line, unaligned) — psql's default aligned output pads `table   | column`,
  and a naive `grep "table \| column"` false-negatives on the padding. This
  session's first spot-check mislabeled `officials.source_ids` as absent for
  exactly this reason; the clean `.audit-tmp/g1_colkeys.txt` catalog fixed it.
- `database.ts` `Relationships[]` is the cheapest way to find dual-FK embed
  ambiguity (PGRST201) — any table with two FKs to the same parent makes a bare
  embed of it ambiguous.
- Three CLAUDE.md / doc staleness items surfaced and are worth a docs pass:
  `entity_connections.is_verified` (packages/db), `financial_entities.source_ids`
  keying (packages/data), `financial_relationships.source_ids` (packages/db).
