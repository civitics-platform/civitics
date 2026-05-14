# Cross-source entity resolution — FIX-250 / FIX-251 / FIX-253 investigation

**Status:** investigation only. No schema, code, or data changes in this commit.
**DB queried:** local Docker Supabase (`127.0.0.1:54321`). Local was reseeded
with the post-cutover FEC bulk (2024 + 2026 cycles) plus a partial LittleSis
ingest and the FIX-250 IRS 990 seed set. Prod has a larger LittleSis footprint
(the user reports an "Elon Musk" LittleSis entity with 132 edges on prod that
is absent from local), so absolute counts below transfer with caveats — the
ratios and the structural diagnosis are the same.

**Sources read (line/col evidence cited in §3):**
- `packages/data/src/pipelines/fec-bulk/writer.ts` — `canonicalizeEntityName`,
  PAC + indiv upsert paths
- `packages/data/src/pipelines/fec-bulk/indiv.ts` — `normalizeName`,
  `canonicalDonorName`, `donorFingerprint`
- `packages/data/src/pipelines/irs990/writer.ts` — nonprofit entity upsert,
  officer match, grant resolver
- `packages/data/src/pipelines/irs990/index.ts` — orchestration
- `packages/data/src/pipelines/littlesis/writer.ts` — hop-1 individual /
  org upsert paths, source-ref binding
- `packages/data/src/pipelines/littlesis/matcher.ts` — `personSortKey`,
  `matchPerson`, `matchOrg`
- `packages/data/src/pipelines/littlesis/expand.ts` — `pass1AnchorMatch` and
  the queue-vs-anchor branching
- `packages/data/src/pipelines/edgar/writer.ts` — exec + shareholder writes
- `packages/data/src/pipelines/edgar/matcher.ts` — donor probe via
  `donor_fingerprint LIKE 'CANONICAL|%'`, employer-canonical secondary check
- `packages/data/src/pipelines/edgar/companies.ts` — CIK → corp entity binding
- Live DB introspection of `financial_entities`, `external_source_refs`
- `docs/FIX_239_INVESTIGATION.md` — structural template
- `docs/PIPELINE_AUDIT.md` §1a/1b — confirms `canonicalizeEntityName` is the
  cross-pipeline normalizer

---

## 1. TL;DR

The three new source pipelines (IRS 990, LittleSis, EDGAR) each invented their
own dedup contract — and **none of them check the same key the FEC indiv
writer uses**. The fundamental shape is:

| Source | Dedup arbiter | Looks up existing row by |
|---|---|---|
| FEC indiv | `donor_fingerprint` UNIQUE | (none — fingerprint is *its* key, foreign sources don't write to it) |
| FEC PAC | `fec_committee_id` UNIQUE | (none) |
| LittleSis hop-1 | none (bare INSERT) | matcher pre-pass via `personSortKey` / `orgsByCanonical`; queue/miss → unconditional INSERT |
| IRS 990 nonprofit | none | `external_source_refs(source='irs_990', external_id=EIN)` only |
| EDGAR corporation | none | `external_source_refs(source='sec_edgar', external_id=CIK)`, then `canonical_name + entity_type='corporation'` fallback |
| EDGAR exec / shareholder | n/a — never inserts a `financial_entities` row | matches via `donor_fingerprint LIKE 'CANONICAL\|%'` + employer-canonical-equality |

`financial_entities` has NO cross-source UNIQUE constraint. The only UNIQUEs
are `donor_fingerprint` (FEC indiv only) and `fec_committee_id` (FEC PAC
only). Anything else is enforced — when it's enforced at all — at
application level, by pipeline-specific lookup-then-insert sequences that
diverge in what they look up.

**Quantified scope (local DB, 2026-05-13):**

- **41,188 LittleSis-bound `entity_type='individual'` rows exist where the
  exact same `canonical_name` is already present in an `entity_type='individual'`
  FEC-fingerprinted row.** These are the same person occupying two
  `financial_entities` UUIDs.
- **14,702 distinct canonical_names** have ≥1 LittleSis row + ≥1 FEC indiv
  row. The FEC dollars sitting in these duplicated names: **$206.2M, 8.3%
  of all individual-donor dollars in the table** ($206M of $2.49B).
- **24,409 cross-source non-individual canonical-name clusters** with 2+
  rows total. **59,354 org rows in those clusters** (~14% of all
  non-individual entities). 18,641 specifically mix a LittleSis hop-1 row
  with an unattributed row of the same canonical_name.
- **All but 1 of the 17 IRS 990 nonprofits** in local already collide by
  canonical_name with at least one other `financial_entities` row, often
  multiple. `AMERICANS FOR PROSPERITY` has **5 rows** (IRS 990 nonprofit +
  LittleSis "other" + two `individual` rows accidentally created when FEC
  donors filed the org name in their NAME field + another unattributed
  "other"). `ONE NATION` has 5 rows (IRS 990 + 2 FEC PACs with different
  `fec_committee_id`s + 2 LittleSis "other").
- **8,577 LittleSis individuals (~10.3% of the LS individual set)** map
  exactly to a single FEC row with no ambiguity. The matcher should have
  caught these but didn't — strong evidence of a pipeline-ordering or
  index-staleness bug (see §3.4).

**Recommendation: Strategy D (hybrid — backfill match for high-precision
existing rows + ingest-time match using strict key).** Detailed below in §5.

**Headline for stakeholders:** *Every individual our highest-value sources
already know about (Musk, Singer, Klarman, Adelson, Eychaner, Peterffy) is
in our database twice — once with a $1M+ FEC donation total, once with a
20+ edge LittleSis power-graph — and the connection graph still treats them
as strangers.*

---

## 2. Quantified scope

All counts from local Docker DB at 2026-05-13. Queries available in
`packages/data/scripts/spotcheck-pac-tags.mjs` style — written ad-hoc, not
saved; key numbers reproduced here.

### 2.1 Counts by `entity_type`

| entity_type | count |
|---|---:|
| individual | 987,884 |
| other | 47,694 |
| corporation | 41,313 |
| pac | 6,429 |
| party_committee | 692 |
| super_pac | 347 |
| union | 162 |
| nonprofit | 17 |

### 2.2 Counts by source attribution

| Source | Rows in `external_source_refs` | Distinct entities |
|---|---:|---:|
| littlesis | 111,493 | 111,493 |
| usaspending_recipient | 10,384 | 10,384 |
| irs_990 | 17 | 17 |
| sec_edgar | 5 | 5 |

`congress_gov`, `openstates`, `legistar:*` exist as well but point at
`officials`, not `financial_entities`, so they're not in scope here.

### 2.3 Individual-side cross-source duplicates (the Musk case, generalized)

| Bucket | Count |
|---|---:|
| Individuals with `donor_fingerprint` (FEC-bound) | 903,073 |
| Individuals bound to a LittleSis ref (`confidence=hop1`) | 84,811 |
| Distinct FEC indiv `canonical_name` values | 772,977 |
| Distinct LittleSis indiv `canonical_name` values | 83,146 |
| **Overlap (same canonical_name in both)** | **14,702** |
| **FEC dollars in canonical_names with LS duplicate** | **$206.2M** |
| Total FEC indiv dollars (denominator) | $2,487.6M |
| **Fragmented-dollar ratio** | **8.3%** |

Of the 14,702 overlapping canonical_names:

| LS canonical maps to … | Count | Diagnosis |
|---|---:|---|
| Exactly **1 FEC row** | 8,577 | matchPerson would have returned `kind='medium'` and bound it. Did not. Strong signal of pipeline-ordering bug (see §3.4) |
| **2–5 FEC rows** (multi-ZIP) | 5,061 | matchPerson returns `kind='queue'`. Queue is not auto-processed → unanchored → hop-1 insert. This is FIX-239 fragmentation stacking on top of cross-source. |
| **6+ FEC rows** | 1,064 | Same as above — queue path. Common names. |
| **0 FEC rows** | 68,444 | Genuine LittleSis-only entities (politicians' family, sub-$200 donors, foreigners). Not duplicates — these are net-new. |

The 84,811 LittleSis hop-1 individuals do NOT carry the `[LS:<id>]`
discriminator suffix that `littlesis/writer.ts:107` documents. Either the
suffix code is dead in the path that actually ran, or the data was loaded
by an earlier code revision. Either way, the absence of the suffix means
the rows look identical-by-canonical to FEC rows with no application-layer
protection.

### 2.4 Five concrete individual duplicates (beyond Musk)

All confirmed by inspection of local DB rows:

1. **PAUL SINGER** — 6 financial_entities rows total: 4 FEC indiv rows
   (different ZIPs: 20007 DC, 33480 Palm Beach, 02115 Boston, 10024 NYC;
   one with $953,300 FEC dollars) + 2 LittleSis hop-1 rows (LS:59970 and
   LS:52680). Even within LittleSis there are two ids (LittleSis has its
   own intra-source duplicates that aren't deduped at ingest).
2. **M JUDE REYES** — 2 rows: FEC `REYES, M. JUDE` ($1.1M) + LittleSis
   hop-1 `M. Jude Reyes` (LS:75093). Single FEC row, single LS row, exact
   canonical match — clean case of pipeline-ordering miss.
3. **THOMAS PETERFFY** — 2 rows: FEC `PETERFFY, THOMAS MR.` ($1.05M) +
   LittleSis hop-1 `Thomas Peterffy` (LS:75106). Honorific stripped by
   FIX-239 normalizer → canonical_name=`THOMAS PETERFFY` on both sides.
   Should have matched; didn't.
4. **MIRIAM ADELSON** — 2 rows: FEC `ADELSON, MIRIAM DR.` ($767k) +
   LittleSis hop-1 `Miriam Adelson` (LS:49592). Same dynamic as Peterffy.
5. **JOHN ARNOLD** — 14 rows (!): 13 FEC indiv rows + 1 LittleSis hop-1
   (LS:15131). The 13 FEC rows are multi-ZIP fragmentation (FIX-239's
   problem); the LittleSis row is the cross-source layer. matchPerson
   would have returned `kind='queue'` (13 candidates after sort-key
   lookup) → not anchored → hop-1 insert.
6. **ELON MUSK REVOCABLE TRUST** — 2 rows, both `entity_type='other'`,
   identical canonical_name `ELON MUSK REVOCABLE TRUST`. One bound to
   LittleSis (LS:452041), one not. Neither has a `fec_committee_id`. The
   second row is most likely from USASpending or some other ingest that
   created an unattributed row before LittleSis ran.

### 2.5 Five concrete organization / nonprofit duplicates

1. **AMERICANS FOR PROSPERITY** — 5 rows. IRS 990 nonprofit row (EIN
   753148958, $tens-of-millions in revenue) + 1 LittleSis "other" row
   (the org graph entity, ~100+ edges in their main run) + 2
   `entity_type='individual'` rows where FEC donors filed the org name as
   their own NAME field (data-entry artifact, but they exist as live rows)
   + 1 unattributed "other" row.
2. **ONE NATION** — 5 rows. IRS 990 nonprofit (EIN 271937961) + 2 FEC
   PACs each with their own `fec_committee_id` (the Karl Rove operation
   genuinely operates as multiple FEC committees) + 2 LittleSis "other"
   rows. Only the 2 FEC PAC rows are arguably distinct entities; the
   nonprofit + 2 LS rows should all collapse.
3. **THE HERITAGE FOUNDATION** — 3 rows. IRS 990 nonprofit + 1 LittleSis
   "other" + 1 unattributed "other" (probably USASpending grant
   recipient). All canonical_name = `THE HERITAGE FOUNDATION`.
4. **NATIONAL RIFLE ASSOCIATION OF AMERICA** — IRS 990 nonprofit row.
   FEC has separate PAC rows (`NRA-PVF` and others) that DO have distinct
   `fec_committee_id`s — those are correctly separate. But there's also a
   LittleSis hop-1 org and probably USASpending grant rows under the same
   name. Same pattern as Heritage.
5. **CHAMBER OF COMMERCE OF THE USA** — 3 rows. IRS 990 nonprofit + 1
   LittleSis "other" + 1 unattributed "other". Same shape as Heritage.
   The connected PAC (`US Chamber of Commerce PAC` etc.) is a separate
   row by `fec_committee_id` UNIQUE and is correctly distinct.

### 2.6 Cross-source non-individual cluster summary

| Population | Count |
|---|---:|
| Non-individual canonical-name clusters with 2+ rows | 24,409 |
| Total org rows in those clusters | 59,354 |
| Clusters mixing FEC PAC + LittleSis (different `fec_committee_id` and a LS ref both present) | 203 |
| Clusters mixing LittleSis with at least one unattributed non-FEC row | 18,641 |
| Clusters with 2+ rows but no LittleSis and no FEC PAC link | 5,456 |

The 18,641 LS-vs-unattributed clusters are the biggest by row count and
represent the LittleSis-vs-USASpending-recipient collision class — LittleSis
imported a company as `entity_type='corporation'` or `'other'`, while
USASpending recipient ingestion (`source='usaspending_recipient'`) created
a separate row for the same company under `entity_type='other'`.

### 2.7 Connection-graph consequences

`external_relationships` rows reference `financial_entities` UUIDs.
LittleSis edges (CC-BY-SA, the bulk of the social network in our data)
point at LittleSis hop-1 UUIDs. FEC donation rows point at FEC indiv UUIDs.
So a duplicate-individual case like Musk:

- FEC entity holds ~200 edges (donations to candidates and PACs)
- LittleSis entity holds ~130 edges on prod (board memberships, ownership,
  business partners)
- The donor profile page at `/donors/<uuid>` shows only one or the other,
  not both

Per the `rebuild_entity_connections()` SQL block 10 (LittleSis →
`entity_connections`), the LS edges materialize with `from_id` /
`to_id` = LS hop-1 UUIDs. So today's donor profile page for the FEC
Musk shows 200 donation edges and 0 LittleSis edges; navigating to the
LittleSis Musk shows the inverse. The 132-connection "Elon Musk
(LittleSis)" the user described is real: it's the cluster around the
LittleSis entity, completely disconnected from the FEC dollar trail.

---

## 3. Pipeline-by-pipeline analysis (the WHY)

### 3.1 FEC bulk — the reference normalizer

[fec-bulk/writer.ts:35-45](packages/data/src/pipelines/fec-bulk/writer.ts#L35-L45) —
`canonicalizeEntityName(raw)`:

```ts
const base = raw.toUpperCase()
  .replace(/[^A-Z0-9\s]/g, " ")
  .replace(/\s+/g, " ").trim();
return base.replace(/\s+(INC|LLC|LTD|CORP|CORPORATION|COMPANY|CO|PAC|COMMITTEE)$/i, "").trim();
```

Used by [fec-bulk/writer.ts:111](packages/data/src/pipelines/fec-bulk/writer.ts#L111)
in PAC entity upsert (committee names). Stripped trailing corporate
suffix is appropriate for orgs.

[fec-bulk/indiv.ts:177-188](packages/data/src/pipelines/fec-bulk/indiv.ts#L177-L188) —
`normalizeName(raw)`, FIX-239 Layer 1:

```ts
const cleaned = raw.toUpperCase()
  .replace(/['.]/g, "")          // FIX-244: O'BRIEN → OBRIEN
  .replace(/[^A-Z0-9 ]/g, " ")
  .replace(/\s+/g, " ").trim();
const tokens = cleaned.split(" ").filter((t) => t && !NOISE_TOKENS.has(t));
return tokens.join(" ");
```

Where `NOISE_TOKENS` strips `MR/MRS/MS/DR/MD/PHD/ESQ/REV/HON/CPA/CFP/JD/RN/DDS/DO/MBA`
but preserves generational tokens. Used in `donorFingerprint(name, zip5)`
to produce the FEC indiv UNIQUE key.

[fec-bulk/indiv.ts:217-225](packages/data/src/pipelines/fec-bulk/indiv.ts#L217-L225) —
`canonicalDonorName(rawName)` (FIX-238): reorders FEC's "LAST, FIRST" →
"FIRST LAST" then runs `normalizeName`. Used by
[fec-bulk/writer.ts:220](packages/data/src/pipelines/fec-bulk/writer.ts#L220)
to populate `canonical_name` for FEC indiv rows.

**Result for the Musk case:** FEC ingests `MUSK, ELON` →
`canonical_name = "ELON MUSK"`, `donor_fingerprint = "MUSK ELON|78704"`.
The shape downstream pipelines need to compare against is `canonical_name`
in natural FIRST-LAST order with apostrophes/periods stripped and
honorifics dropped.

### 3.2 LittleSis pipeline (FIX-251)

**Where new financial_entities are considered:**
[littlesis/writer.ts:92-160](packages/data/src/pipelines/littlesis/writer.ts#L92-L160)
`upsertHop1FinancialEntities` — called from
[littlesis/index.ts:152-159](packages/data/src/pipelines/littlesis/index.ts#L152-L159)
for the set of entities REFERENCED BY an edge but NOT in `anchorMap`.

**Matching against existing rows (pre-insert):**
[littlesis/matcher.ts:191-271](packages/data/src/pipelines/littlesis/matcher.ts#L191-L271)
`matchPerson`. Looks up by:
1. `officialsByLastName` first (existing politicians in `officials`)
2. `personsBySortKey` for unmatched (FEC indiv via `personSortKey`)

[littlesis/matcher.ts:69-76](packages/data/src/pipelines/littlesis/matcher.ts#L69-L76)
`personSortKey`:

```ts
return canonical.split(/\s+/).map(t=>t.trim()).filter(Boolean).sort().join(" ");
```

Sorts tokens alphabetically. So FEC `"ELON MUSK"` and LittleSis `"Elon Musk"`
both produce sort-key `"ELON MUSK"` after `canonicalizeEntityName`. **They
should match by sort-key for a single-token-set case.**

**Why it fails in practice (combining §2.3 + matcher reading):**

a. **Pipeline-ordering bug (8,577 cases).** `personsBySortKey` is built
   from `financial_entities` rows at LittleSis pipeline START
   ([matcher.ts:78-170](packages/data/src/pipelines/littlesis/matcher.ts#L78-L170)).
   If a FEC indiv row was inserted after that build but in the same
   nightly run (LittleSis ran first, FEC indiv backfilled later), the
   matcher's index doesn't see it → matchPerson returns `kind='miss'` →
   hop-1 INSERT.

b. **Multi-ZIP FEC fragmentation (6,125 cases).** When FEC has multiple
   rows for the same person (different ZIPs), `personsBySortKey` returns
   `hits.length > 1` → matchPerson returns `kind='queue'`
   ([matcher.ts:260-269](packages/data/src/pipelines/littlesis/matcher.ts#L260-L269)).

c. **Queue isn't anchor.** [expand.ts:99-117](packages/data/src/pipelines/littlesis/expand.ts#L99-L117) —
   if `match.kind === "queue"`, the entity is pushed into `ambiguous`
   and NOT added to `anchorMap`. Then
   [index.ts:142-150](packages/data/src/pipelines/littlesis/index.ts#L142-L150)
   collects `referencedHop1` for any entity not in `anchorMap` →
   `upsertHop1FinancialEntities` creates a new row.

d. **Middle-initial sort-key mismatch.** Sort-key for FEC
   `"ELON R MUSK"` is `"ELON MUSK R"`; LittleSis `"Elon Musk"` is
   `"ELON MUSK"`. They don't match, even though they're the same person.
   This sits inside the 68,444 "no_fec_row" bucket of §2.3 from the
   matcher's POV — it genuinely doesn't find FEC indiv rows with the
   exact same token set.

**Hop-1 INSERT shape:**
[littlesis/writer.ts:101-128](packages/data/src/pipelines/littlesis/writer.ts#L101-L128)
applies the `[LS:<id>]` suffix for individuals **in the writer**. The
live local data shows 0 of 84,811 LS-bound individuals carry the
suffix — so either the suffix was added after the data was loaded, or
the code path that ran was an older revision. Effectively: **the
`canonical_name` LittleSis writes for individuals matches the FEC indiv
`canonical_name` exactly**, which is why we see 41,188 same-name
duplicates.

**`orgsByCanonical` org-side match:**
[matcher.ts:277-318](packages/data/src/pipelines/littlesis/matcher.ts#L277-L318)
looks up by exact `canonical_name`. Hits all rows with that canonical
regardless of entity_type. The match.kind=`high` case requires exactly
one hit. With USASpending pre-loading recipient rows as
`entity_type='other'`, "high" hits are rare for medium-frequency org
names → queue or hop-1 insert.

**No UNIQUE constraint** prevents the hop-1 insert from creating a
duplicate. [littlesis/writer.ts:128-135](packages/data/src/pipelines/littlesis/writer.ts#L128-L135) —
the comment explicitly acknowledges:

> Risk: same canonical_name + entity_type as a pre-existing non-LittleSis
> row produces a duplicate row; accepted for v1 and documented.

### 3.3 IRS 990 pipeline (FIX-250)

**Where new financial_entities are considered:**
[irs990/writer.ts:79-155](packages/data/src/pipelines/irs990/writer.ts#L79-L155)
`upsertNonprofitEntity`. For each filing's org:

1. Look up `external_source_refs(source='irs_990', external_id=EIN)`. If
   found → reuse existing entity.
2. **If not found → INSERT a new `financial_entities` row** with
   `entity_type='nonprofit'`.

**There is no check against existing financial_entities by canonical_name
or by `entity_type IN ('nonprofit','other')`.** The IRS 990 writer doesn't
ask "is there already an Americans for Prosperity entity in the table?"
before inserting; it asks only "have we seen this EIN before?"

[irs990/writer.ts:120-122](packages/data/src/pipelines/irs990/writer.ts#L120-L122)
comments explicitly acknowledge the design:

> A canonical name collision with an existing PAC of the same name is fine:
> they live in distinct entity_type partitions.

That argument fails for the LittleSis case. LittleSis writes its hop-1
org as `entity_type='other'`. IRS 990 writes its nonprofit as
`entity_type='nonprofit'`. They DON'T live in distinct partitions for the
purpose of "is this the same real-world organization." They live in
distinct rows precisely because the IRS 990 pipeline never looked.

**Officer matching (irs990/writer.ts:218-293):** Officers DO try to match
against `officials` via `canonicalizePersonName` (which is
`canonicalizeEntityName` minus the corporate-suffix strip,
[writer.ts:49-55](packages/data/src/pipelines/irs990/writer.ts#L49-L55)).
No `financial_entities` row is created for officers regardless of match
outcome — they stay in the `irs990_officers` sidecar with a nullable
`matched_entity_id`. So officers don't generate cross-source duplicate
individuals. Good.

**Grant recipient resolution:** [irs990/writer.ts:308-342](packages/data/src/pipelines/irs990/writer.ts#L308-L342)
`resolveGrantRecipient` does check `external_source_refs` by EIN first,
then `financial_entities` by `canonical_name + entity_type IN ('nonprofit','other')`.
This is closer to right — but only one-way: it consults canonical_name
to FIND a match, not to PREVENT a duplicate at the nonprofit-insert
step.

**Result:** Each new nonprofit EIN we ingest creates a fresh
`financial_entities` row, even when LittleSis already has the same org
as a hop-1 entity. The 17 nonprofits in local DB collide with 22+ other
rows by canonical_name, almost universally.

### 3.4 EDGAR pipeline (FIX-253)

**Companies — better than the others:** [edgar/companies.ts:220-289](packages/data/src/pipelines/edgar/companies.ts#L220-L289)
`syncCompanies` does:
1. Preload existing `external_source_refs(source='sec_edgar', external_id=CIK)`.
2. If CIK unbound, call `findFinancialEntityByCanonical(canonical, entity_type='corporation')`.
3. Only if BOTH lookups miss → `insertCorporationEntity`.

This is the only one of the three new pipelines that explicitly searches
for an existing row by canonical_name before inserting. **But:** it
filters by `entity_type='corporation'` only
([edgar/companies.ts:115-128](packages/data/src/pipelines/edgar/companies.ts#L115-L128)).
LittleSis writes corporations as `entity_type='corporation'` for some
inputs and `'other'` for others (via
[littlesis/util.ts:330-338](packages/data/src/pipelines/littlesis/util.ts#L330-L338)
`littleSisOrgEntityType` — falls back to `'other'` when types[] doesn't
match any known shape). USASpending recipients land as `'other'` or
`'corporation'` depending on how the pipeline classifies them. So an
EDGAR `findFinancialEntityByCanonical` for `'corporation'` misses a
matching `'other'` row → duplicate insert. Local DB has only 5 EDGAR
CIKs; with full S&P 500 + R3000, this will scale.

**Officers — by design no duplicates:** [edgar/index.ts:97-198](packages/data/src/pipelines/edgar/index.ts#L97-L198)
`runEdgarPipeline` writes `edgar_executive_officers` rows (sidecar
table); only the matcher path can link to an existing `financial_entities`
row. **No new `financial_entities` row is ever created for an exec.**
Excellent — but it means executives without a matched donor don't
participate in the unified financial_entities graph at all. Half the
problem solved by erasing the other half.

**Officer→donor matcher:** [edgar/matcher.ts:117-131](packages/data/src/pipelines/edgar/matcher.ts#L117-L131)
`matchPersonToDonor`. Probes
`donor_fingerprint LIKE 'CANONICAL|%'` (and the LAST-FIRST reverse,
[edgar/matcher.ts:56-62](packages/data/src/pipelines/edgar/matcher.ts#L56-L62)),
filters by employer canonical equality. Requires exactly 1 employer-match
to auto-bind. Conservative — false-positive-resistant — but the
employer match throws away most candidates: FEC's
`metadata->>'employer'` is free text the donor wrote, EDGAR's company
canonical is well-formed. They rarely align letter-for-letter even
after canonicalization (`"Tesla Inc"` vs `"Tesla, Inc."` vs `"Tesla
Motors"` vs `"SpaceX"` for someone with cross-employment). Result:
most matches fall to `kind='name_only'` → review queue, not auto-bound.

**Shareholders — same as officers:** no new financial_entities rows.
Org shareholders go to review queue (no auto-binding); person
shareholders go through `matchPersonToDonor`.

**Result:** EDGAR's risk surface is narrower than the other two. The
duplicate-corporation case is real but small (5 rows locally; ~500 at
full S&P 500 scale, of which probably 50-100 will duplicate existing
LittleSis/USASpending rows). The officer/shareholder side cannot
produce duplicate individuals **but it also doesn't materialize them as
participants in the unified graph**.

### 3.5 Diagnostic table — per-pipeline gap summary

| Question | FEC indiv | FEC PAC | LittleSis indiv | LittleSis org | IRS 990 | EDGAR co. | EDGAR exec/SH |
|---|---|---|---|---|---|---|---|
| Inserts financial_entities rows? | yes | yes | yes (hop-1) | yes (hop-1) | yes | yes | **no** |
| Pre-insert match against existing rows? | n/a (donor_fingerprint UNIQUE) | n/a (fec_committee_id UNIQUE) | personSortKey lookup | orgsByCanonical exact match | EIN lookup ONLY | CIK lookup, then canonical+type='corp' | matches but never inserts |
| Calls `canonicalizeEntityName`? | yes (via normalizeName subset for indiv) | yes | yes | yes | yes | yes | yes (via `canonicalizePersonName`) |
| Compatible input shape with FEC's canonical? | reference shape | reference shape | matches if sort-key matches | matches if exact | yes (orgs); n/a (indiv) | yes (corps only) | yes (people via fingerprint probe) |
| Has UNIQUE constraint protecting cross-source? | donor_fingerprint UNIQUE (FEC-only key, foreign sources don't write here) | fec_committee_id UNIQUE (same) | **none** | **none** | **none** | **none** | n/a |
| Net failure mode | n/a — self-consistent | n/a — self-consistent | hop-1 INSERT when match doesn't fire | hop-1 INSERT when match doesn't fire | INSERT new nonprofit on every unknown EIN | INSERT new corp when canonical+type missed | doesn't add entities, but leaves execs disconnected |

---

## 4. Strategy comparison

Six strategies evaluated against the FIX-239-investigation dimensions:
false-positive rate, false-negative rate, complexity, reversibility,
compatibility with existing data.

### 4.A — Write-time canonical match + UNIQUE constraint

Add a UNIQUE constraint on a derived `cross_source_match_key` column
(deterministic function of `canonical_name` + some discriminator like
state or employer for individuals). Every ingest computes the key,
PostgreSQL rejects collisions. Pipelines must catch the unique-violation,
look up the existing row, and update the source binding instead of
inserting.

| Dimension | Eval |
|---|---|
| False-positive rate | Medium-high for individuals (two John Smiths in different states collapse if discriminator is canonical-only). Lower if discriminator includes state or employer. |
| False-negative rate | Low — if both sources produce the same canonical, the constraint fires. |
| Complexity | M-L. Requires backfilling existing 41,188+24,409 duplicates first (constraint can't be added until duplicates are merged). |
| Reversibility | Hard — once rows are merged, restoring the split requires re-ingest. |
| Compat with FIX-239 Layer 2 | Conflicts. FIX-239 Layer 2 proposes a `dedup_cluster_id` for grouping; A introduces a hard UNIQUE that would force merges before clustering. Can't co-exist easily. |

### 4.B — Post-ingestion match pass (cluster ID, FIX-239-Layer-2 style)

Add nullable `cross_source_cluster_id UUID` to `financial_entities`.
Nightly job computes clusters across all sources. Query layer rolls up
by `cluster_id`. Underlying rows stay where they are.

| Dimension | Eval |
|---|---|
| False-positive rate | Configurable — depends on clustering rules. With same-canonical + same-state + (employer-overlap OR shared-edge) the FP rate is very low. |
| False-negative rate | Configurable — multi-ZIP fragmentation can be addressed by the same job. |
| Complexity | L. New column + cluster function + cross-table query rewrites (search, donor pages, graph). |
| Reversibility | Easy — cluster_id is derived. Recompute anytime. |
| Compat with FIX-239 Layer 2 | **Shared infrastructure**. Same column, same function shape, different rules per entity_type. |

### 4.C — Curated alias table for high-profile entities

Hand-curate a `cross_source_aliases` table that explicitly says
`littlesis:12345 ≡ fec_indiv:<uuid>`. Query layer reads the alias table
and rolls up.

| Dimension | Eval |
|---|---|
| False-positive rate | Effectively zero (curator validates each). |
| False-negative rate | Very high. Only covers what's curated. Local data has ~14,702 LS-FEC indiv overlaps alone; manually curating each is infeasible. |
| Complexity | S to start, XL to maintain. |
| Reversibility | Easy — drop the table. |
| Compat with FIX-239 | Independent. Doesn't conflict, but doesn't share. |

### 4.D — Hybrid: backfill match for known FEC rows + ingest-time match with strict key

**Two phases, in order:**

Phase 1 (one-time backfill): For every LittleSis hop-1 individual,
attempt to match against an existing FEC indiv row using:
- exact `canonical_name` match AND
- single FEC candidate (no multi-ZIP fragmentation), OR
- multi-FEC candidates but at most one has a state-matching donor

For matches, REWRITE the LittleSis-bound row's `id` references in
`external_relationships.from_id/to_id` (and any other FK-bearing tables)
to point at the FEC row, then DELETE the LittleSis-bound row. Result:
LittleSis edges hang off the FEC entity; donor profile pages show both
sets of edges.

Phase 2 (forward-looking): Update each new-source pipeline to:
- Before INSERT, run the same exact-canonical lookup
- If single match → bind via `external_source_refs`, skip INSERT
- If multi-match → write to review queue, do NOT hop-1 insert
- If no match → INSERT (preserving the genuinely-new entities)

| Dimension | Eval |
|---|---|
| False-positive rate | Low — exact canonical match is conservative; ambiguous cases go to queue. The 8,577 "single FEC row" cases are safe; the 5,061 "2-5 FEC rows" cases need rules to pick one or queue. |
| False-negative rate | Medium — middle-initial mismatches (`ELON R MUSK` ≠ `ELON MUSK`) and apostrophe/particle issues stay split until a Layer-2 cluster pass catches them. |
| Complexity | M for backfill (one SQL function similar to FIX-239's merge_plan); S for forward pipeline patches (one helper function, three call sites). |
| Reversibility | Backfill phase is destructive (rows deleted); reversibility costs a re-ingest. Forward phase is non-destructive — turning the match off just resumes hop-1 inserts. |
| Compat with FIX-239 Layer 2 | Excellent. The Layer-2 cluster pass catches what D's exact-match misses. They're complementary; D is the high-precision floor, Layer 2 is the recall ceiling. |

### 4.E — Query-time deduplication (rollup at read time)

Don't change ingestion. Build a query-time view that aggregates
same-canonical entities across sources.

Per task brief: explicitly NOT recommended as the primary answer.
Performance envelope on `financial_relationships` (~5.7M rows post-FIX-236)
makes it impractical for the donor profile page's hot path. Keeping
here for completeness but not evaluating further.

### 4.F — Insert-time match against an `external_source_refs` UNIQUE on `(source, canonical_name)`

A specific shape of A: don't add UNIQUE to `financial_entities`; instead
add a UNIQUE on a derived row in `external_source_refs` that uses
canonical-name-as-external-id for sources that don't have a stable
external id.

| Dimension | Eval |
|---|---|
| False-positive rate | Same as A. |
| False-negative rate | Same as A. |
| Complexity | M. Requires changing what "external_id" means per source. |
| Reversibility | Easy — drop the constraint. |
| Compat | Awkward — overloads `external_source_refs` semantics. |

### Strategy summary table

| Dimension | A. Write-time UNIQUE | B. Cluster ID nightly | C. Curated alias | D. Hybrid backfill + ingest match | F. external_source_refs UNIQUE |
|---|---|---|---|---|---|
| FP rate (collapses distinct people) | Medium | Configurable (low if tuned) | Zero | Low | Medium |
| FN rate (misses real duplicates) | Low | Configurable | Very high | Medium | Low |
| Implementation complexity | M-L | L | S to start, XL maintenance | M (backfill) + S (forward) | M |
| Reversibility | Hard | Easy | Easy | Phase 1 hard, Phase 2 easy | Easy |
| Effect on existing 41,188 dups | Forces backfill before constraint adds | Tags them with cluster_id | Doesn't fix them | Backfill resolves them | Forces backfill |
| Shared infra with FIX-239 L2 | Conflicts | Shared column + function | Independent | Complementary | Conflicts |
| Effect on donor profile page UX | Immediate (collapsed) | Immediate (rolled up by cluster) | Only curated cases collapse | Immediate (collapsed) | Immediate (collapsed) |
| Risk for runtime pipelines | Pipelines must handle unique-violation gracefully | None — pipelines unchanged | None | Pipelines need to lookup-before-insert | Pipelines must handle unique-violation |

---

## 5. Recommended approach — Strategy D (hybrid)

D is preferred over B-alone because:
- The fragmentation is already in the data — 41,188 individuals × ~3
  edges average = ~120k stranded edges today. Layer-2 clustering tags
  them but the donor profile page still has to opt-in to the rollup.
  D's backfill is destructive but produces a single-row-per-person
  outcome that needs no rollup logic in the application layer.
- The pattern is heavily skewed to **single-FEC-match cases** (8,577 of
  14,702 LS-FEC overlaps). The exact-canonical rule fixes these
  losslessly with no FP risk. Layer-2 clustering catches the harder
  middle-initial/multi-ZIP cases on top.

D is preferred over A-alone because:
- A's UNIQUE constraint forces all 41,188 duplicates to merge BEFORE
  the constraint can land, with no ability to defer the hard cases to
  human review. D's backfill produces a queue of ambiguous cases that
  doesn't block the rest of the work.
- A's UNIQUE conflicts with FIX-239 Layer 2's `dedup_cluster_id`. D is
  complementary — D collapses the safe duplicates immediately, Layer 2
  handles the residue across runs.

### 5.1 Architecture

```
                        New pipeline ingest (LS / IRS990 / EDGAR / future)
                              │
                              ▼
                  ┌──────────────────────────────┐
                  │  Match candidate against     │
                  │  resolveOrInsertEntity()     │  ← single helper, one source of truth
                  │                              │
                  │  1. Lookup by external_id    │
                  │  2. Lookup by canonical_name │
                  │     + entity_type bucket     │
                  │  3. (individuals only)       │
                  │     LIKE 'CANONICAL|%' on    │
                  │     donor_fingerprint        │
                  │  4. Score candidates         │
                  │  5. ≥1 high-confidence?      │
                  │     yes → bind via refs      │
                  │     no  → review queue or    │
                  │           hop-1 INSERT (only │
                  │           for genuinely-new) │
                  └──────────────────────────────┘
                              │
                              ▼
                  ┌──────────────────────────────┐
                  │  financial_entities          │
                  │  (single row per entity)     │
                  └──────────────────────────────┘
                              │
                              ▼
                  ┌──────────────────────────────┐
                  │  nightly:                    │
                  │  rebuild_cross_source_clusters()  ← FIX-239 L2 shared
                  │  (covers what D misses)      │
                  └──────────────────────────────┘
```

### 5.2 Schema changes

```sql
-- supabase/migrations/{date}_cross_source_resolution.sql

-- 1. Add cluster_id (shared with FIX-239 Layer 2 plan).
ALTER TABLE public.financial_entities
  ADD COLUMN IF NOT EXISTS cross_source_cluster_id UUID;

CREATE INDEX IF NOT EXISTS financial_entities_cross_source_cluster
  ON public.financial_entities (cross_source_cluster_id)
  WHERE cross_source_cluster_id IS NOT NULL;

COMMENT ON COLUMN public.financial_entities.cross_source_cluster_id IS
  'Derived cross-source dedup cluster. NULL until nightly rebuild runs. Shares column with FIX-239 Layer 2 (donor-side cluster).';

-- 2. Helper SQL function: exact canonical match (single source of truth).
-- Returns the financial_entities.id if exactly one row matches, else NULL.
CREATE OR REPLACE FUNCTION resolve_entity_by_canonical(
  p_canonical_name TEXT,
  p_entity_type    TEXT  DEFAULT NULL,
  p_state          TEXT  DEFAULT NULL  -- for individuals; matches metadata->>'state'
) RETURNS UUID LANGUAGE plpgsql STABLE AS $$
DECLARE
  v_id UUID;
  v_count INT;
BEGIN
  IF p_entity_type = 'individual' THEN
    SELECT count(*), max(id) INTO v_count, v_id
    FROM public.financial_entities
    WHERE canonical_name = p_canonical_name
      AND entity_type = 'individual'
      AND donor_fingerprint IS NOT NULL
      AND (p_state IS NULL OR metadata->>'state' = p_state);
  ELSIF p_entity_type IS NULL THEN
    SELECT count(*), max(id) INTO v_count, v_id
    FROM public.financial_entities
    WHERE canonical_name = p_canonical_name;
  ELSE
    SELECT count(*), max(id) INTO v_count, v_id
    FROM public.financial_entities
    WHERE canonical_name = p_canonical_name
      AND entity_type = p_entity_type;
  END IF;
  IF v_count = 1 THEN RETURN v_id; END IF;
  RETURN NULL;
END;
$$;
```

### 5.3 Pipeline changes per source

**LittleSis ([writer.ts:92-160](packages/data/src/pipelines/littlesis/writer.ts#L92-L160)):**

Replace `upsertHop1FinancialEntities`'s bare INSERT with a per-row
lookup-then-insert via `resolve_entity_by_canonical`:

```ts
async function resolveOrInsertHop1(ent: LittleSisEntity): Promise<{ id: string; created: boolean }> {
  const canonical = canonicalizeEntityName(ent.name);
  const entityType = ent.primary_ext === "Person" ? "individual" : littleSisOrgEntityType(ent.types);

  // Single-canonical lookup first.
  const { data: existing } = await db
    .rpc("resolve_entity_by_canonical", {
      p_canonical_name: canonical,
      p_entity_type:    entityType,
    });
  if (existing) return { id: existing as string, created: false };

  // Genuinely new — INSERT.
  // (existing INSERT logic, no [LS:] suffix since match-first prevents collision)
  ...
}
```

The orchestrator binds the LittleSis ID to whichever id (existing or
new) via `external_source_refs(source='littlesis')`.

**IRS 990 ([writer.ts:79-155](packages/data/src/pipelines/irs990/writer.ts#L79-L155)):**

After step 1 (EIN lookup), before step 2 (INSERT), add a canonical
fallback:

```ts
// 1.5 - Canonical fallback before INSERT
const { data: existing } = await db
  .rpc("resolve_entity_by_canonical", {
    p_canonical_name: canonicalizeOrgName(input.displayName),
    p_entity_type:    null,  // any non-individual; IRS nonprofits often collide with LS 'other' or USAspending 'corporation'
  });
if (existing) {
  // Bind EIN → existing entity instead of inserting a new nonprofit row.
  await db.from("external_source_refs").upsert({
    source: "irs_990", external_id: input.ein,
    entity_type: "financial_entity", entity_id: existing,
    source_url: ..., last_seen_at: ...
  }, { onConflict: "source,external_id" });
  return { entityId: existing };
}
// Else: INSERT new nonprofit (existing logic).
```

Per-entity-type guidance: do NOT match `entity_type='individual'` against
a nonprofit name. The lookup filter at the `resolve_entity_by_canonical`
level handles this — for IRS 990 nonprofit ingestion, pass
`p_entity_type=NULL` since the nonprofit might already live under
'nonprofit', 'other', or 'corporation'; the function returns single-match
only.

**EDGAR ([companies.ts:255-264](packages/data/src/pipelines/edgar/companies.ts#L255-L264)):**

Loosen the existing canonical fallback to include `entity_type='other'`
alongside `entity_type='corporation'`. One-line change to
`findFinancialEntityByCanonical`.

### 5.4 Backfill plan

Single one-off migration that runs in this order:

```
1. Build merge plan for individuals (cross-source):
   CREATE TEMP TABLE merge_plan_indiv AS
   SELECT canonical_name,
          (array_agg(id ORDER BY (CASE WHEN donor_fingerprint IS NULL THEN 0 ELSE 1 END) DESC,
                              total_donated_cents DESC,
                              created_at ASC))[1] AS winner_id,
          array_remove(array_agg(id ORDER BY ...), winner_id) AS loser_ids
   FROM public.financial_entities
   WHERE entity_type = 'individual'
   GROUP BY canonical_name
   HAVING count(*) > 1
      AND count(*) FILTER (WHERE donor_fingerprint IS NOT NULL) <= 1;  -- single-FEC-row case only

2. For each row: rewrite external_relationships from_id/to_id from
   loser_ids → winner_id (FIX-239 Layer 2 plan has the same shape).
   Same for entity_connections, edgar_*.financial_entity_id,
   irs990_filings.financial_entity_id, etc.

3. Rewrite external_source_refs.entity_id from loser_ids → winner_id.

4. DELETE financial_entities WHERE id = ANY(loser_ids).

5. Build merge plan for orgs (canonical_name match, looser FP risk —
   require at least one source binding to consider the match safe):
   CREATE TEMP TABLE merge_plan_org AS
   SELECT canonical_name, (winner = row with most external_source_refs binding count
                            OR highest total_donated_cents tiebreak),
          loser_ids
   FROM public.financial_entities
   WHERE entity_type <> 'individual'
   GROUP BY canonical_name
   HAVING count(*) > 1
      -- Conservative: only merge when at least one row has a non-FEC source binding
      AND bool_or(id IN (SELECT entity_id FROM external_source_refs WHERE source <> 'congress_gov'));

6. Same rewrite-then-delete sequence as steps 2-4 for orgs.

7. (Phase 1 cluster_id stamp) UPDATE financial_entities
   SET cross_source_cluster_id = md5(canonical_name || ...) ::uuid
   WHERE entity_type='individual' OR entity_type='nonprofit' OR ...
```

The 4,801 multi-FEC-row LS overlaps and 1,064 6+-FEC-row cases go to
review queue — explicitly NOT auto-merged, since collapsing
multi-ZIP-fragmentation is FIX-239's job, not this one's.

### 5.5 Order of operations

Pipelines should ship in this order to minimize churn:
1. **Schema + helper function migration** (cross_source_cluster_id +
   `resolve_entity_by_canonical`).
2. **Backfill migration** (5.4 above) — runs once.
3. **EDGAR companies patch** (loosen entity_type filter) — smallest blast
   radius, only 5 local rows affected.
4. **IRS 990 nonprofit patch** — affects 17 rows, well-bounded.
5. **LittleSis hop-1 patch** — biggest impact, most rows. Land last so
   the EDGAR/IRS patches' canonical lookups already see merged FEC
   entities.

### 5.6 Verification anchor cases

After the backfill, the following should each resolve to **one** UUID
in `financial_entities` (verify via canonical_name lookup):

- `ELON MUSK` (individual) — currently 1 FEC row in local; on prod
  should collapse the LittleSis 132-edge Musk into the FEC row
- `PAUL SINGER` (individual) — currently 6 rows local; should collapse
  to 1 row holding all FEC + 2 LittleSis ids in `external_source_refs`
  (the multi-ZIP fragmentation is FIX-239's separate job; this fix
  collapses CROSS-source only; assuming the multi-ZIP gets handled
  first, this is a clean 1-row outcome)
- `MIRIAM ADELSON` (individual) — currently 2 rows; should collapse
  to 1
- `BRIAN ARMSTRONG` (individual) — currently 8 FEC + 1 LS = 9 rows;
  same FIX-239 caveat
- `THE HERITAGE FOUNDATION` (org) — currently 3 rows; should collapse to 1
- `ONE NATION` (org) — currently 5 rows; the 2 FEC PACs with distinct
  fec_committee_ids should stay distinct; the nonprofit + 2 LS rows
  should collapse with one of them. So expected post-fix: 3 rows (2 FEC
  PACs + 1 collapsed nonprofit/LS row), or 2 rows if we decide the
  nonprofit ≡ both PACs (probably not — different legal entities)
- `AMERICANS FOR PROSPERITY` (org) — currently 5 rows; collapse to 2-3
  (nonprofit/LS/unattributed merge; the 2 individual rows stay because
  they're indiv entity_type even though they're misclassified)
- `ELON MUSK REVOCABLE TRUST` (other) — currently 2 rows; collapse to 1
- `THOMAS PETERFFY` (individual) — currently 2 rows; collapse to 1
- `M JUDE REYES` (individual) — currently 2 rows; collapse to 1

---

## 6. Risk register

1. **False-positive merges (collapsing distinct people).** The single-FEC-row
   case is safe by construction (one FEC row + one LS row = same canonical_name
   = same person except in pathological "John Smith from California" cases at
   the long tail). Mitigation: require at least one secondary signal for
   common-name cases (state from metadata, employer overlap, or appearance
   in `external_relationships` with overlapping edges).

2. **Foreign-key impact when entity ids change.** Tables that reference
   `financial_entities.id`:
   - `financial_relationships.from_id` / `to_id`
   - `entity_connections.from_id` / `to_id`
   - `external_source_refs.entity_id`
   - `edgar_companies.financial_entity_id`
   - `edgar_executive_officers.financial_entity_id`
   - `edgar_major_shareholders.financial_entity_id`
   - `irs990_filings.financial_entity_id`
   - `external_relationships.from_id` / `to_id`
   - `financial_entities.parent_entity_id` (self-reference)
   
   All of these need UPDATE statements in the backfill before DELETEs.
   Mitigation: explicit list-and-walk for each table; FK constraints
   already prevent accidental orphans.

3. **`financial_relationships` partial UNIQUE index collisions during
   merge.** Same shape as FIX-239: rewriting `from_id` from loser →
   winner may collide with an existing `(relationship_type, from_id,
   to_id, cycle_year)`. Mitigation: identical to FIX-239's plan — sum
   amounts, sum tx_count, keep latest occurred_at, delete losers.

4. **`external_source_refs(source, external_id) UNIQUE` collisions during
   merge.** If two losers carry the same `(source, external_id)` (LittleSis
   intra-source duplicates like the Paul Singer LS:59970 / LS:52680 pair),
   the rewrite fails. Mitigation: pre-merge intra-source duplicates first
   (LittleSis ships them rarely — ~50 cases in local data).

5. **Pipeline re-runs after the fix.** New runs should idempotently find
   the merged entity via `resolve_entity_by_canonical`. Verify:
   - LittleSis: matchPerson now finds the merged row (same canonical,
     single hit); matchOrg likewise. Hop-1 path triggers only for
     genuinely-new entities.
   - IRS 990: EIN preload still works; new EIN with existing canonical
     → falls through to canonical match → bind to existing row.
   - EDGAR: CIK preload still works; new CIK with existing canonical →
     bind via loosened lookup.

6. **Connection-graph rebuild impact.** `rebuild_entity_connections()`
   reads `external_relationships` and `financial_relationships`. After
   the rewrite, both reference the winner UUID, so the rebuild's output
   merges naturally. No code change to the rebuild RPC needed.

7. **Search-index impact.** `financial_entities_canonical_trgm` (GIN on
   `canonical_name`) backs `/api/search`. Removing 50k+ duplicate rows
   reduces noise in trigram results; the index update is automatic via
   trigger.

8. **The 84,811 LS hop-1 individuals that have no FEC counterpart.**
   Strategy D doesn't touch these — they stay as the canonical row for
   that entity. Risk: a future FEC indiv ingest might match the same
   canonical → at that point the LS row becomes the "existing" row that
   FEC's `resolve_entity_by_canonical` finds. FEC indiv writer would
   need to handle this case (probably: merge donor_fingerprint into the
   existing LS row, set entity_type='individual', etc.). Worth
   reviewing the FEC indiv path as part of the patch set.

9. **Officer/shareholder rows in EDGAR sidecars after individual
   merges.** `edgar_executive_officers.financial_entity_id` may point at
   a loser row that got merged. Mitigation: update these alongside the
   main merge.

---

## 7. Open questions

1. **Should multi-FEC-row cases (5,061 of 14,702) be auto-merged or
   queued?** The conservative position is queue. The aggressive
   position is: pick the largest-donation FEC row as canonical and
   collapse the LS row into it. Defer to user — Strategy D ships either
   way. Recommend queue for v1 to keep FP risk near zero.

2. **What's the right `winner` heuristic when merging?** Options:
   - Highest `total_donated_cents` (preserves FEC dollar accuracy)
   - Most recent `updated_at` (preserves latest metadata)
   - Most external_source_refs bindings (preserves the most-attributed
     row)
   - The row with `donor_fingerprint NOT NULL` (preserves FEC link if
     present, since `donor_fingerprint` is UNIQUE and rewriting it is
     a separate cost)
   
   The last option is the most defensible default: FEC's
   `donor_fingerprint` is the only existing dedup arbiter in the system,
   so preserving it preserves the cleanest source of truth. The merge
   plan in §5.4 step 1 codifies this preference.

3. **Should `cross_source_cluster_id` live on `financial_entities` or in
   a separate `entity_clusters` table?** If FIX-239 Layer 2 is the
   driver, putting both on `financial_entities` is simplest (one
   column, two consumers). If we expect cluster membership to grow
   beyond "donor dedup" + "cross-source dedup" (e.g., "household
   dedup" — same family, different individuals), a separate table is
   more flexible.

4. **What's the prod backfill blast radius?** Local has 41,188 indiv
   duplicates + 24,409 org cluster pairs. Prod LittleSis is more
   complete (the user reports ~111k LS entities present, similar to
   local). FEC indiv is similar (540k vs 903k local — local was reseeded
   more aggressively). Best guess: prod has ~30k-50k indiv
   cross-source duplicates and ~15k-20k org duplicates. The backfill
   touches each loser row + its FK references; estimate 5-10 min wall
   time on Pro with PITR snapshot.

5. **What about FEC PAC ↔ LittleSis Org collisions when canonical
   matches but `fec_committee_id` is present?** The 203 such clusters
   in local DB are mostly the right side of the data — a PAC and a
   LittleSis org of the same canonical name are usually the same real
   entity (the PAC and the corporation it represents). But not always
   — a corporate parent and its corporate PAC are distinct legal
   entities. Defer to manual review for these 203 cases; D's auto-merge
   should NOT pull them together.

6. **Does the Layer-2 cluster pass run before or after the FEC indiv
   pipeline?** Order matters for cross-pipeline freshness. If FEC indiv
   runs first → adds 50k new donor rows → then LittleSis runs → the
   matcher's index includes those new FEC rows → fewer hop-1 inserts.
   Recommend: re-order the nightly orchestrator so FEC bulk completes
   before LittleSis starts. Cheap to do; high leverage.

---

## 8. Relationship to FIX-239 Layer 2

FIX-239 Layer 2 plans a `dedup_cluster_id` on the donor side for
multi-ZIP fragmentation. This investigation proposes
`cross_source_cluster_id` for cross-source fragmentation. **They should
share the same column.**

| Aspect | FIX-239 Layer 2 | This investigation |
|---|---|---|
| Column proposed | `dedup_cluster_id` | `cross_source_cluster_id` |
| Driver | Single-source multi-ZIP fragmentation within FEC | Multi-source same-name collisions |
| Cluster key | (last, first) + ZIP3 + employer-signature | canonical_name + (state for indiv) + source binding inventory |
| Rebuild frequency | Nightly | Nightly |
| Query layer changes | Roll up donor pages by cluster | Same |

Recommendation: **One column, one function, two rule sets**. Name it
`entity_cluster_id` to cover both cases. Implementation:
- Single column on `financial_entities`
- Single `rebuild_entity_clusters()` SQL function with branching by
  entity_type — individuals use FIX-239's multi-ZIP + cross-source
  rules, orgs use canonical-name + entity_type bucket rules
- Single nightly orchestrator call

Strategy D's destructive backfill complements both: the cluster_id pass
runs AFTER D collapses the safe duplicates, so it only has to handle
the genuinely-ambiguous residue (middle-initial / multi-ZIP / common
names).

---

## 9. Out-of-scope discoveries

Surfaced during this investigation; queued as separate FIX items rather
than folded in:

- **The `[LS:<id>]` suffix in
  [littlesis/writer.ts:107](packages/data/src/pipelines/littlesis/writer.ts#L107)
  is either dead code or was added after the local data was loaded.**
  84,811 LS hop-1 individuals exist; 0 carry the suffix. Worth checking
  git blame on `writer.ts` and whether the running pipeline matches the
  code on disk.

- **LittleSis intra-source duplicates.** Paul Singer has LS:59970 AND
  LS:52680 — two LittleSis IDs for the same person on the LittleSis side.
  ~50 such pairs visible in the data. Either LittleSis ships dupes in
  the bulk file or the matcher's lookup-by-LS-id deduplication isn't
  catching pre-existing internal duplicates. New FIX.

- **`AMERICANS FOR PROSPERITY` exists as `entity_type='individual'` twice.**
  The FEC indiv ingest is creating individual-donor rows whose NAME field
  contains the org name. Data-entry artifacts from FEC source data —
  donors filed "AMERICANS FOR PROSPERITY" as their NAME. New FIX to
  filter these at the FEC indiv level (whitelist orgs that should never
  be individuals).

- **No anchor → external_source_refs binding step in `littlesis/index.ts`.**
  When `matchPerson` returns `kind='high'` or `kind='medium'`, the
  anchor is added to `anchorMap` but I cannot find where that anchor
  match is written to `external_source_refs` for future runs.
  `preloadKnownLittleSisIds` reads existing bindings — but new
  anchor-matched LS ids never seem to get written. Suggests a code
  path I'm missing OR a real bug where anchor matches aren't persisted.
  Worth verifying.

- **EDGAR `findFinancialEntityByCanonical` filters to
  `entity_type='corporation'` only.** [companies.ts:115-128](packages/data/src/pipelines/edgar/companies.ts#L115-L128).
  Misses LittleSis hop-1 rows of the same company under `'other'`. Fix
  inside the broader D patch.

---

## 10. Done criteria check

- [x] Quantified scope: 14,702 distinct individual canonical_names with
  LS-FEC overlap ($206M / 8.3% of indiv dollars); 24,409 cross-source
  org clusters; ~all of 17 IRS 990 nonprofits already duplicated.
- [x] ≥5 concrete individual duplicate examples (§2.4: Singer, Reyes,
  Peterffy, Adelson, Arnold, plus Musk Revocable Trust).
- [x] ≥5 concrete org/nonprofit duplicate examples (§2.5: AfP, One
  Nation, Heritage, NRA, Chamber of Commerce).
- [x] All three new pipelines analyzed for entity-matching behavior with
  line:col evidence (§3.2-3.4).
- [x] 4+ strategies evaluated with consistent trade-off dimensions
  (§4 — six evaluated: A, B, C, D, E, F).
- [x] Recommended approach concrete enough that an implementation prompt
  is derivable (§5: schema + helper function + per-pipeline patches +
  backfill + order of operations + verification cases).
- [x] No code, schema, or data changes in this commit other than this
  doc.
- [x] Cross-source resolution issue remains open after this commit
  (this prompt only produces the decision doc, no FIX flip).
- [x] Verified: local (read-only investigation, prod doesn't apply).
