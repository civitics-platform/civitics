# The name-keyed official resolvers — a census of collisions and of the bindings the new rules would not choose

cc-342, 2026-11-28. Prod, read-only. FIX-1468 (the three rules, landed in
this run) and FIX-1469 (the existing bindings, open: the repair is its own
prompt). Design of record: `docs/audits/2026-11-28-members-with-no-officials-row.md`
answer 4 (cc-340's survey of the name-keyed resolvers) and `votes-maps.ts`
(FIX-940: scope the pool, then refuse an occupied slot and report it).

**How it was read.** Nine prod statements through `scripts/db-query.mjs
--prod`, each with its own `--timeout` (listed at the end). They were one read
of every `officials` row (39,380 rows, ~08:15Z), every `irs990_officers` row
with a matched official (58), every LittleSis → official
`external_source_refs` row (41,443), the rows' FEC candidate ids, the last
three `data_sync_log` rows of each pipeline, and three EXPLAINs. One statement
failed on a column name and was re-run. The census itself ran offline
over those reads. It used the resolvers' own key functions, and after
Items 1–2 landed it was re-run against `buildOfficialNameIndex` and
`resolvePlumNameMatch`. Both landed functions agree with the census to the
row: 33,180 index keys, 963 settled, 1,980 refused, and the plum split
51 / 2,866 / 0. Reading the 39,380 rows in reverse gives the identical
index. Read 4 is one GET of `LEGISLATORS_HISTORICAL_URL`.

**The tree matched the prompt.** All three sites are as cc-340 described, at
`384d1c0`. irs990 `loadOfficialsByCanonicalName` ran `map.set` on first + last
and set-if-unset on `full_name`, over a keyset read by `id`. plum-book phase 2
ran an `ilike` with no ORDER BY and no tier or `is_active`, so the first row
won, and phase 3b then wrote `is_active`. LittleSis `matchPerson` bound a
one-row pool with no first-name check. The resolvers left alone each hold a
guard, one line each:

- `agency-leadership/index.ts` refuses two or more name matches and orders
  its read by `created_at, id`.
- fec-bulk `loadOfficials` filters `.eq("is_active", true)` (`:421`, `:2636`).
- The Senate vote resolver reads `currentGoverningBodyMembers`
  (`is_active` + `tier = 'elected'`).
- Promotion reads `is_active` on the elected side and `tier = 'candidate'` on
  the other.

## The pool (prod 2026-11-28)

| tier | active | inactive |
|---|---|---|
| candidate | 19,589 | 77 |
| elected | 13,768 (5,397 with a `plum_id`) | 4,145 |
| former | 49 (48 with a `plum_id`) | 1,752 |

542 rows carry a bioguide (`source_ids.congress_gov`), and 539 are sitting
members (a bioguide, `is_active`, `elected`). 9,626 rows carry a `plum_id`.
17,157 rows carry no `first_name`, 9,494 of them PLUM appointees. The prompt's
clone figures were 14,214 active elected, 5,884 with a `plum_id`, and 114
active former; prod has fewer of each.

## Read 2 — collisions today

### 2a — lower-cased, whitespace-collapsed `full_name` (plum-book's key)

| | keys |
|---|---|
| held by more than one row | **2,917** (7,218 rows; the clone read 2,835) |
| … with exactly one active elected-tier row | 960 |
| … with none | 1,834 |
| … with two or more | 123 (the clone read 121) |
| … with a bioguide row | 69 |
| … with a sitting member | **68** (the clone read 55); none holds two |

G2's view of the same 2,917 keys: drop the sitting members, and 51 keys keep
one row (they link), 2,866 keep two or more (they link none), and no key is
held by sitting members alone.

### 2b — irs990's key (canonical first + last, and canonical `full_name`, one namespace)

| | keys |
|---|---|
| held by more than one row | **2,943** |
| G1 resolves to the one active elected-tier row | 963 (32.7 %) |
| G1 resolves to nobody | **1,980 (67.3 %)**, of which 1,856 have no active elected row and 124 have two or more |
| … with a sitting member | 68; the old rule bound **39** of them to a row that is not the member (`KEITH SELF`, `MARIANNETTE MILLER MEEKS`, `DAN SULLIVAN`, `SETH MOULTON`, `DON BACON`, `DARRELL ISSA`) |
| the old rule's answer differs from G1's | 2,718 |

The index holds 33,180 keys, against 35,160 under the old rule. The STOP
table's row fired: G1 sends more than half of today's shared keys to nobody.
G1 landed anyway, as that row directs: nobody is better than a coin. In the
old rule's answers, 2,626 shared keys resolved to a row that is not active
and elected. No SQL twin of `canonicalizePersonName` exists; this table was
computed over the one `officials` read.

The largest key is `gavin solomon`, held by 416 rows: FEC candidate stubs
(`fec_bulk_cn`), one per CAND_ID, from 46 states, the last minted 10-31. That
looks like one perennial filer rather than a writer defect. G1 refuses the key.
The old rule gave it to the last stub read.

### 2c — surnames, as LittleSis keys them (`last_name`, else `full_name`'s last token; every row)

| | |
|---|---|
| surnames | 17,914 |
| held by exactly one row | **12,882** (98 of them a sitting member) |
| surname : state pairs | 21,859 (11,931 rows carry no `metadata` state) |
| held by exactly one row within a state | 18,600 |
| lone-surname rows with no `first_name` | 6,230 of the 12,882 |

## Read 3 — existing bindings the rules would not choose

### 3a — irs990: 12 of 58

58 officer rows carry a matched official, on 31 officials. 46 sit on a key one
row holds; G1 resolves each to the row it is bound to. **12 sit on a shared
key, and G1 would choose none of them**: another row for 8, nobody for 4.
One officer shows the defect directly. JAMES DAVIS of EIN 753148958 is bound to
`3d87ee10` for 2022 and 2023, and to `c19c9073` for 2024. Both are candidate
stubs, and which one won depended on the rows present when each filing landed.


| officer (EIN, year, role) | key | bound today | G1 would choose | the key's rows |
|---|---|---|---|---|
| JAMES DAVIS (753148958, 2022, DIRECTOR) | `JAMES DAVIS` | `3d87ee10` candidate | nobody | 4 |
| MICHAEL CANNON (237432162, 2024, DIRECTOR OF HEALTH POLICY) | `MICHAEL CANNON` | `b6edb1ee` former (inactive) · plum_id | `edb5e9b0` elected · plum_id | 2 |
| JESSICA ANDERSON (272244700, 2024, BOARD MEMBER) | `JESSICA ANDERSON` | `2e7ba8ff` candidate | `acc6495e` elected | 2 |
| John Wood (530045720, 2022, SVP, Gnl Cnsl/CLO & Secretary) | `JOHN WOOD` | `410c91bf` candidate | `05065d41` elected · plum_id | 2 |
| CRAIG HAGGARD (530116130, 2024, BOARD DIRECTOR STARTED 05/18/2024) | `CRAIG HAGGARD` | `7d614f3f` candidate | `dfb7c506` elected | 2 |
| Courtney Parella (270730508, 2023, Communications Director) | `COURTNEY PARELLA` | `106eaa80` former (inactive) · plum_id | `542a6fb2` elected · plum_id | 2 |
| JESSICA ANDERSON (272244700, 2022, EXECUTIVE DIRECTOR) | `JESSICA ANDERSON` | `2e7ba8ff` candidate | `acc6495e` elected | 2 |
| JESSICA ANDERSON (272244700, 2023, EXECUTIVE DIRECTOR) | `JESSICA ANDERSON` | `2e7ba8ff` candidate | `acc6495e` elected | 2 |
| MICHAEL CANNON (237432162, 2023, DIRECTOR OF HEALTH POLICY) | `MICHAEL CANNON` | `b6edb1ee` former (inactive) · plum_id | `edb5e9b0` elected · plum_id | 2 |
| JAMES DAVIS (753148958, 2023, DIRECTOR) | `JAMES DAVIS` | `3d87ee10` candidate | nobody | 4 |
| JAMES DAVIS (753148958, 2024, DIRECTOR) | `JAMES DAVIS` | `c19c9073` candidate | nobody | 4 |
| DONNA EDWARDS (521733698, 2024, DIRECTOR) | `DONNA EDWARDS` | `f89cab50` candidate | nobody | 2 |


### 3b — plum-book: 69 of 191 name links, 119 PLUM ids on candidate stubs, 0 on a member

9,626 rows carry a `plum_id`. plum-book inserted 9,435 of them
(`metadata.source = 'plum_book'`); 191 got theirs from the name match. By
the row's source those are `fec_bulk_cn` 111, `congress_nominations` 45,
`wikidata_agency_leadership` 14, none 13, and `fec_bulk_ie` 8.

| | rows | the clone |
|---|---|---|
| candidate-tier with a `plum_id` | **119** | 65 |
| a `plum_id` AND a bioguide | **0** | 0 |
| former-tier with a `plum_id` | 1,059 (48 active) | — |
| name-linked, G2 picks the same row today | 122 | — |
| name-linked, on a name two or more non-member rows hold (G2 links none) | **69** | — |
| name-linked, on a sitting member (G2 drops it) | 0 | — |

By tier and activity, the 191 name links are 77 inactive candidates, 47
active elected, 42 active candidates, 14 inactive elected and 11 inactive
former. **Every inactive candidate stub on prod (77 of 77) is a name-linked
PLUM row.** Phase 3b's `is_active: isCurrent` set each one inactive when the
appointee's occupancy had ended. G2 keeps that write on a stub; it drops it
only on a row with a bioguide.

The first ten candidate-tier rows with a `plum_id`, by id:


| row | name | is_active | linked from | created |
|---|---|---|---|---|
| `0b23a794` | David Perdue | true | fec_bulk_ie | 2026-07-18 |
| `0b2b0d03` | Johnny Garcia | false | fec_bulk_cn | 2026-08-02 |
| `1bc4cbd9` | Sean Duffy | false | fec_bulk_cn | 2026-05-11 |
| `1c687269` | Cameron Hamilton | false | fec_bulk_cn | 2026-05-11 |
| `1efdf7fe` | Darin Smith | true | fec_bulk_cn | 2026-08-02 |
| `1f5b1401` | David Cash | false | fec_bulk_cn | 2026-05-11 |
| `20b1d430` | Orlando Sonza | true | fec_bulk_cn | 2026-05-11 |
| `22199039` | Eric Skrmetta | true | fec_bulk_cn | 2026-05-11 |
| `222c09b7` | Dorothy Mcauliffe | false | fec_bulk_cn | 2026-05-11 |
| `22601874` | Luis Jimenez | false | fec_bulk_cn | 2026-05-11 |


The first ten name links G2 would not make today, by id. Each sits on a name two or more non-member rows hold:


| row | name | tier | is_active | the name's rows |
|---|---|---|---|---|
| `0b23a794` | David Perdue | candidate | true | 2: `0b23a794` candidate plum; `1335fa7d` elected plum |
| `0b2b0d03` | Johnny Garcia | candidate | false | 2: `0b2b0d03` candidate (inactive) plum; `1a30221d` candidate |
| `0e442a36` | John Walker | elected | false | 2: `0e442a36` elected (inactive) plum; `39365ccc` elected |
| `10a42577` | Conner Prochaska | elected | true | 2: `10a42577` elected plum; `70c12df7` elected plum |
| `1bc4cbd9` | Sean Duffy | candidate | false | 2: `1bc4cbd9` candidate (inactive) plum; `5665e535` elected plum |
| `1c687269` | Cameron Hamilton | candidate | false | 4: `1c687269` candidate (inactive) plum; `44fb850a` former plum; `757c4d0f` former (inactive) plum; `af66f049` elected |
| `1efdf7fe` | Darin Smith | candidate | true | 2: `1efdf7fe` candidate plum; `ad135162` elected plum |
| `1f5b1401` | David Cash | candidate | false | 2: `1f5b1401` candidate (inactive) plum; `9568bf6a` candidate |
| `22601874` | Luis Jimenez | candidate | false | 3: `22601874` candidate (inactive) plum; `2ea9ab0b` candidate; `e62bb0cc` candidate |
| `233a8076` | Christopher Smith | candidate | false | 5: `0420960b` elected plum; `233a8076` candidate (inactive) plum; `278411fd` candidate; `d6aa01ab` candidate; `feb8f11d` candidate |


### 3c — LittleSis: at least 31,354 of 41,443 bind the wrong person

| | |
|---|---|
| LittleSis person → official bindings | **41,443**, every one `confidence: medium`, on 10,089 officials |
| officials holding two or more LittleSis people | **5,920**, holding 37,274 bindings |
| so at least this many bind the wrong person | **31,354** (each official keeps at most one) |
| on a surname one row holds today (the lone branch, no first-name check) | 24,352 |
| on a surname two or more rows hold today | 17,091 |
| bound row is a candidate stub / a `plum_id` row / a sitting member / other | 20,349 / 7,853 / 862 / 12,379 |
| sitting members holding two or more | 137 |
| created 2026-06-10 (FIX-275's first persistence) | 38,524; since then 2–1,453 a week |

The lower bound treats two LittleSis entities as two people. That is LittleSis's
own model; its duplicates are rare beside a 547-to-one fan-in. **The count the
prompt asked for, lone-surname bindings whose first names disagree, is
unread.** `external_source_refs` stores only the LittleSis id for an anchor
match, and no table keeps the LittleSis name. Testing the first name needs
the LittleSis entities dump, a GET this run's posture did not include. The
24,352 bindings on a lone surname are the population that test would run
over.

The ten officials holding the most LittleSis people:


| official | name | tier | bioguide | LittleSis people bound | rows with its surname |
|---|---|---|---|---|---|
| `c2ad5c79` | JULIUS GAMBLE, II | elected | — | 547 | 3 |
| `ec9280b9` | Elizabeth Rothschild | candidate | — | 138 | 1 |
| `8a931b12` | GEETA GUPTA | elected | — | 108 | 4 |
| `593601f7` | Dexter Donnell | candidate | — | 95 | 1 |
| `15bdf11f` | Andrew Yang | candidate | — | 89 | 2 |
| `2ba1db49` | LAWRENCE CONNELL | elected | — | 81 | 1 |
| `b75dd935` | Gaby Grossman | elected | — | 81 | 5 |
| `b7085d7a` | Mitzi Epstein | elected | — | 76 | 3 |
| `d693d1d3` | Mark Smith | candidate | — | 75 | 281 |
| `d8f34812` | Scott Meyers | candidate | — | 74 | 4 |


`JULIUS GAMBLE, II` has no `last_name`, so its surname key is `II`. Every
LittleSis person whose last token is `II` and whose pool held that row bound
to it. `Elizabeth Rothschild` is the only `ROTHSCHILD`, so every LittleSis
Rothschild bound to her. `Mark Smith` shows the three-letter prefix is weak
even with two or more rows. He holds 75 in a pool of 281 Smiths, through the
multi branch's prefix narrow (after a state narrow, where there was a hint): a
Mary, a Maria or a Marcus binds to the one Mar… left. G3 adds that same test
to the lone branch. It does not make the test stronger (see Residuals).

## G5 — what each pipeline's next scheduled run does to these bindings

- **irs990** (Vercel cron → `/api/cron/gha-dispatch/irs990`, `0 15 * * 2`;
  next **Tue 2026-12-01 15:00Z**; its 11-24 run inserted 0 rows). It writes
  officer rows only for filings it has not ingested
  (`filterUningestedObjectIds`), so it **binds new officers only**: **0 of the
  58** existing bindings move, and the 12 above stay as they are. A new filing
  of EIN 272244700, 237432162, 530045720, 530116130, 270730508, 753148958 or
  521733698 would bind its officer to the row G1 chooses. For four of those
  officers that is a different row from the one their earlier years hold.
- **plum-book** (the nightly's weekly enrichment-light block; "Sunday's"
  nightly fires **Sat 2026-11-28 21:00Z**). It is a no-op unless OPM's
  `last_change` advanced: 11-07, 11-14 and 11-21 each wrote 0 rows. An
  appointee whose `plum_id` a row already carries never reaches the name match,
  and phase 3b updates only rows linked in that run. So it **binds new
  appointees only**: **0 of the 191** name links move, and the 69 stay.
- **LittleSis** (the weekly enrichment-heavy block, the same Sat 21:00Z start;
  11-21 ran 32 min and wrote 610,030 rows). Pass 1 skips every LittleSis id
  `external_source_refs` holds (`if (anchorMap.has(ent.id)) continue`), and
  the edge resolver reads those bindings as they are. So it **binds new
  LittleSis ids only**: **0 of the 41,443** bindings move. The wrong ones keep
  feeding the edges every run builds. From the next run on, a lone surname
  whose first name disagrees goes to the review queue instead of binding. By
  created_at that has been 2–1,453 binds a week since July. The planner
  estimates the queue at ~922 K LittleSis rows. Its upsert's conflict key
  carries a NULL `source_relationship_id`, so whether a re-queued entity is
  inserted again every week is unread: the count needs a sort of those rows
  (EXPLAIN only, skipped).

No pipeline re-derives an existing binding, so STOP row G5 (more than 200
moved) cannot fire for any of the three.

## Read 4 — the members the former-members work will add

One GET of `legislators-historical.json` (200, `Last-Modified: Thu, 24 Sep
2026 10:21:30 GMT`, 13.5 MB, 12,231 listings). `fetchFeed` was not the
reader: `parseLegislators` keeps only the last term's type, state and
district, and this read needs every term's end. The URL constant is the
repo's, and the raw JSON was parsed directly.

| | |
|---|---|
| listings with a term ending after 2021-01-03 (the 117th Congress or later) | 195 |
| … with a bioguide-keyed `officials` row | 3 |
| … with none: **the set** | **192**: 165 House, 27 Senate (cc-340 counted at least 185) |
| also excluded: a last term ending exactly 2021-01-03 (116th departures) | 61 |
| `full_name` key collides with an existing row | **87**: a candidate stub 87, a `plum_id` row 5, other 4, a sitting member 1 |
| irs990 key collides | **153**: a candidate stub 152, a `plum_id` row 9, other 5, a sitting member 1 |
| any name collision | 153 |
| surname held by one row today, which a new row makes two | 42 |
| surname absent today | 5 |
| no `id.fec` | 2 (Laphonza R. Butler, George S. Helmy) |
| a row already claims one of their `id.fec` | **190** (194 candidate stubs, 1 elected row) |

A member is counted once in each class that one of its colliding rows
belongs to. The sitting-member collision is Robert Menendez (M000639,
Senate, NJ), whose name the sitting House member Rob Menendez holds. The
`plum_id` collisions are the legitimate former targets G1 and G2 were
designed to keep: Marco Rubio, Kelly Loeffler, Lee Zeldin, Billy Long, Lori
Chavez-DeRemer, Mark E. Green, Michael F. Doyle, Michael C. Burgess and
Brandon Williams. **The feed is two months old.** A member who left after
2026-09-24 is not in it.

**Most of the 192 already have an `officials` row: their own FEC candidate
stub.** A ninth prod read took every row's `fec_candidate_id` and
`prior_fec_candidate_ids` (19,938 rows). **190 of the 192** have a row that
claims one of their dataset `id.fec` values: 194 candidate-tier rows and one
elected row. **148 of the 152** irs990-key stub collisions are the member's
own stub. Four collide only with other people's stubs. 42 members have
their own stub under a name spelling the key does not match. So the
collision is mostly not a namesake. It is one person in two rows-to-be.

What the build needs to know:

- **Promote, do not insert.** For 190 of 192, the row to make `former` (with
  the bioguide, `tier`, term dates and `is_active = false`) already exists as
  the FEC stub `fec_bulk_cn` minted. Inserting a second row beside it creates
  exactly the shared key G1 refuses. 148 of these names would then bind no
  990 officer, because neither row is active and elected. `promote-candidates.ts`
  and FIX-933's same-person merge are the in-tree shapes; the claim map is
  `legislator-ids.ts`' `authoritativeClaims`.
- Under G2, a former row is a legitimate link, and plum-book never writes its
  `is_active`. A name a former row shares with another non-member row links
  none.
- Under G3, a promotion changes no surname pool. An insert would make 42 lone
  surnames two, and each of those LittleSis people would then need a
  first-name agreement in the unchanged multi branch.

## Residuals — seen, not changed here

- **The three-letter prefix is a weak test.** G3 copies the multi branch's
  test into the lone branch. The multi branch still binds 75 LittleSis people
  to one `Mark Smith`, and a candidate with no `first_name` never survives its
  narrow. G3's lone branch falls back to `full_name`'s first token; the multi
  branch does not, as Item 3 required it unchanged.
- **G2 can link a row that holds a different `plum_id`.** 598 names are held
  by two or more `plum_id` rows. In 564 of them plum-book inserted two or more
  rows itself (`MATTHEW LUBY`: three rows, three `usplum-` ids), so either
  OPM lists namesakes or OpenSanctions re-keyed a person. When one non-member
  row is left, G2 links it and overwrites that row's `plum_id`, as the old
  rule did. When two or more are left, G2 inserts another row. Each case is a
  duplicate the same-person merge can see, never a silent re-bind of a
  member. That is the trade FIX-940 names.
- **plum-book's name read has no row cap of its own.** A 50-name `or()` batch
  takes PostgREST's 1,000-row maximum. The fifty largest keys on prod hold
  875 rows together, and the largest is `gavin solomon`, 416. A truncated
  batch would make a shared key look unique. That is unlikely at today's
  sizes, but nothing detects it.
- **A name-only irs990 match is written at `match_confidence 1.0`.** The
  census does not show that this matters: 58 bindings on 31 officials. No
  FIX was filed; FIX-1469's repair is the place to revisit it.
- **plum-book's `is_active` write still reaches candidate stubs.** All 77
  inactive candidate stubs on prod got that way from it (3b). G2 stops it
  only on rows with a bioguide, as decided.

## Prod statements

1. `officials`: id, names, tier, is_active, bioguide, plum_id, metadata source / state (39,380 rows)
2. EXPLAIN `irs990_officers` where matched (Index Scan `irs990_officers_matched`)
3. EXPLAIN `external_source_refs` littlesis / official (Index Scan `external_source_refs_entity`)
4. `irs990_officers` ⋈ `irs990_filings`, matched rows (58)
5. `external_source_refs`, littlesis → official (41,443)
6. `data_sync_log`, last three per pipeline — failed: `pipeline_name` does not exist
7. the same, on `pipeline` (9 rows)
8. EXPLAIN the review queue's duplication count (Seq Scan + Sort, ~922 K rows) — not run
9. `officials` with a `fec_candidate_id` or `prior_fec_candidate_ids` (19,938 rows)

## The set: 192 members with no bioguide-keyed `officials` row

The next prompt's input. Nothing was written. `a name collides with` is the
class of every row either resolver key finds.


| bioguide | name | last chamber | state | last term ends | `id.fec` | a name collides with |
|---|---|---|---|---|---|---|
| A000376 | Colin Z. Allred | House | TX | 2025-01-03 | 1 | candidate stub |
| A000377 | Kelly Armstrong | House | ND | 2024-12-14 | 1 | candidate stub |
| A000378 | Cynthia Axne | House | IA | 2023-01-03 | 1 | — |
| B000574 | Earl Blumenauer | House | OR | 2025-01-03 | 1 | candidate stub |
| B000575 | Roy Blunt | Senate | MO | 2023-01-03 | 2 | candidate stub |
| B000755 | Kevin Brady | House | TX | 2023-01-03 | 1 | candidate stub |
| B000944 | Sherrod Brown | Senate | OH | 2025-01-03 | 2 | candidate stub |
| B001135 | Richard Burr | Senate | NC | 2023-01-03 | 2 | candidate stub |
| B001223 | Jamaal Bowman | House | NY | 2025-01-03 | 1 | candidate stub |
| B001224 | Cori Bush | House | MO | 2025-01-03 | 1 | candidate stub |
| B001248 | Michael C. Burgess | House | TX | 2025-01-03 | 1 | plum_id row + candidate stub |
| B001251 | G. K. Butterfield | House | NC | 2022-12-30 | 1 | candidate stub |
| B001270 | Karen Bass | House | CA | 2023-01-03 | 1 | candidate stub |
| B001274 | Mo Brooks | House | AL | 2023-01-03 | 1 | candidate stub |
| B001275 | Larry Bucshon | House | IN | 2025-01-03 | 1 | candidate stub |
| B001286 | Cheri Bustos | House | IL | 2023-01-03 | 1 | candidate stub |
| B001297 | Ken Buck | House | CO | 2024-03-22 | 2 | — |
| B001304 | Anthony G. Brown | House | MD | 2023-01-03 | 1 | candidate stub |
| B001310 | Mike Braun | Senate | IN | 2025-01-03 | 1 | candidate stub |
| B001311 | Dan Bishop | House | NC | 2025-01-03 | 1 | — |
| B001312 | Carolyn Bourdeaux | House | GA | 2023-01-03 | 1 | candidate stub |
| B001320 | Laphonza R. Butler | Senate | CA | 2024-12-08 | 0 | — |
| C000141 | Benjamin L. Cardin | Senate | MD | 2025-01-03 | 2 | candidate stub |
| C000174 | Thomas R. Carper | Senate | DE | 2025-01-03 | 1 | candidate stub |
| C000266 | Steve Chabot | House | OH | 2023-01-03 | 1 | candidate stub |
| C000754 | Jim Cooper | House | TN | 2023-01-03 | 3 | — |
| C001054 | Jerry L. Carl | House | AL | 2025-01-03 | 1 | candidate stub |
| C001070 | Robert P. Casey, Jr. | Senate | PA | 2025-01-03 | 1 | candidate stub |
| C001078 | Gerald E. Connolly | House | VA | 2025-05-21 | 1 | candidate stub |
| C001084 | David N. Cicilline | House | RI | 2023-05-31 | 1 | candidate stub |
| C001090 | Matt Cartwright | House | PA | 2025-01-03 | 1 | candidate stub |
| C001097 | Tony Cárdenas | House | CA | 2025-01-03 | 1 | — |
| C001104 | Madison Cawthorn | House | NC | 2023-01-03 | 1 | candidate stub |
| C001109 | Liz Cheney | House | WY | 2023-01-03 | 1 | — |
| C001111 | Charlie Crist | House | FL | 2022-08-31 | 1 | candidate stub |
| C001128 | Connie Conway | House | CA | 2023-01-03 | 1 | candidate stub |
| C001134 | Yadira Caraveo | House | CO | 2025-01-03 | 1 | candidate stub |
| C001135 | Lori Chavez-DeRemer | House | OR | 2025-01-03 | 1 | plum_id row + candidate stub |
| D000191 | Peter A. DeFazio | House | OR | 2023-01-03 | 2 | candidate stub |
| D000482 | Michael F. Doyle | House | PA | 2022-12-31 | 1 | candidate stub + plum_id row |
| D000610 | Theodore E. Deutch | House | FL | 2022-09-30 | 1 | candidate stub |
| D000615 | Jeff Duncan | House | SC | 2025-01-03 | 1 | — |
| D000619 | Rodney Davis | House | IL | 2023-01-03 | 1 | candidate stub |
| D000627 | Val Butler Demings | House | FL | 2023-01-03 | 1 | candidate stub |
| D000630 | Antonio Delgado | House | NY | 2022-05-25 | 1 | candidate stub |
| D000632 | Anthony D’Esposito | House | NY | 2025-01-03 | 1 | other |
| D000633 | John S. Duarte | House | CA | 2025-01-03 | 1 | candidate stub |
| E000215 | Anna G. Eshoo | House | CA | 2025-01-03 | 1 | candidate stub |
| F000062 | Dianne Feinstein | Senate | CA | 2023-09-28 | 1 | candidate stub |
| F000449 | Jeff Fortenberry | House | NE | 2022-03-31 | 1 | — |
| F000455 | Marcia L. Fudge | House | OH | 2021-03-10 | 1 | candidate stub |
| F000465 | A. Drew Ferguson IV | House | GA | 2025-01-03 | 1 | — |
| F000473 | Mayra Flores | House | TX | 2023-01-03 | 1 | candidate stub |
| G000061 | Mike Garcia | House | CA | 2025-01-03 | 1 | candidate stub |
| G000377 | Kay Granger | House | TX | 2025-01-03 | 1 | candidate stub |
| G000551 | Raúl M. Grijalva | House | AZ | 2025-03-13 | 1 | — |
| G000552 | Louie Gohmert | House | TX | 2023-01-03 | 1 | — |
| G000563 | Bob Gibbs | House | OH | 2023-01-03 | 1 | — |
| G000577 | Garret Graves | House | LA | 2025-01-03 | 1 | candidate stub |
| G000578 | Matt Gaetz | House | FL | 2024-11-13 | 1 | candidate stub |
| G000579 | Mike Gallagher | House | WI | 2024-04-24 | 1 | — |
| G000582 | Jenniffer González-Colón | House | PR | 2025-01-03 | 1 | — |
| G000588 | Anthony Gonzalez | House | OH | 2023-01-03 | 1 | candidate stub |
| G000590 | Mark E. Green | House | TN | 2025-07-21 | 1 | candidate stub + plum_id row |
| G000594 | Tony Gonzales | House | TX | 2026-04-14 | 1 | candidate stub |
| G000595 | Bob Good | House | VA | 2025-01-03 | 1 | candidate stub |
| G000596 | Marjorie Taylor Greene | House | GA | 2026-01-05 | 1 | candidate stub |
| H000324 | Alcee L. Hastings | House | FL | 2021-04-06 | 1 | candidate stub |
| H001038 | Brian Higgins | House | NY | 2024-02-02 | 1 | candidate stub |
| H001053 | Vicky Hartzler | House | MO | 2023-01-03 | 1 | candidate stub |
| H001056 | Jaime Herrera Beutler | House | WA | 2023-01-03 | 1 | candidate stub |
| H001071 | Jody B. Hice | House | GA | 2023-01-03 | 1 | candidate stub |
| H001074 | Trey Hollingsworth | House | IN | 2023-01-03 | 1 | candidate stub |
| H001075 | Kamala D. Harris | Senate | CA | 2021-01-18 | 1 | candidate stub |
| H001080 | Debra A. Haaland | House | NM | 2021-03-16 | 1 | candidate stub |
| H001084 | Yvette Herrell | House | NM | 2023-01-03 | 1 | — |
| H001088 | Jim Hagedorn | House | MN | 2022-02-17 | 1 | — |
| H001097 | George S. Helmy | Senate | NJ | 2024-12-08 | 0 | — |
| I000024 | James M. Inhofe | Senate | OK | 2023-01-03 | 2 | candidate stub |
| J000020 | Chris Jacobs | House | NY | 2023-01-03 | 1 | — |
| J000032 | Sheila Jackson Lee | House | TX | 2024-07-19 | 1 | — |
| J000126 | Eddie Bernice Johnson | House | TX | 2023-01-03 | 1 | candidate stub |
| J000292 | Bill Johnson | House | OH | 2024-01-21 | 1 | candidate stub |
| J000306 | Mondaire Jones | House | NY | 2023-01-03 | 1 | candidate stub |
| J000308 | Jeff Jackson | House | NC | 2024-12-31 | 1 | candidate stub |
| K000188 | Ron Kind | House | WI | 2023-01-03 | 1 | — |
| K000368 | Ann Kirkpatrick | House | AZ | 2023-01-03 | 1 | candidate stub |
| K000378 | Adam Kinzinger | House | IL | 2023-01-03 | 1 | candidate stub |
| K000380 | Daniel T. Kildee | House | MI | 2025-01-03 | 1 | candidate stub |
| K000381 | Derek Kilmer | House | WA | 2025-01-03 | 1 | candidate stub |
| K000382 | Ann M. Kuster | House | NH | 2025-01-03 | 1 | candidate stub |
| K000386 | John Katko | House | NY | 2023-01-03 | 1 | candidate stub |
| K000395 | Fred Keller | House | PA | 2023-01-03 | 1 | candidate stub |
| K000396 | Kaiali’i Kahele | House | HI | 2023-01-03 | 1 | candidate stub |
| L000174 | Patrick J. Leahy | Senate | VT | 2023-01-03 | 1 | candidate stub |
| L000266 | Jake LaTurner | House | KS | 2025-01-03 | 1 | candidate stub |
| L000551 | Barbara Lee | House | CA | 2025-01-03 | 1 | candidate stub |
| L000559 | James R. Langevin | House | RI | 2023-01-03 | 1 | candidate stub |
| L000564 | Doug Lamborn | House | CO | 2025-01-03 | 1 | — |
| L000569 | Blaine Luetkemeyer | House | MO | 2025-01-03 | 1 | — |
| L000576 | Billy Long | House | MO | 2023-01-03 | 1 | plum_id row + candidate stub |
| L000578 | Doug LaMalfa | House | CA | 2026-01-05 | 2 | candidate stub |
| L000579 | Alan S. Lowenthal | House | CA | 2023-01-03 | 1 | candidate stub |
| L000581 | Brenda L. Lawrence | House | MI | 2023-01-03 | 1 | candidate stub |
| L000586 | Al Lawson, Jr. | House | FL | 2023-01-03 | 1 | — |
| L000588 | Conor Lamb | House | PA | 2023-01-03 | 1 | candidate stub |
| L000589 | Debbie Lesko | House | AZ | 2025-01-03 | 1 | candidate stub |
| L000591 | Elaine G. Luria | House | VA | 2023-01-03 | 1 | candidate stub |
| L000592 | Andy Levin | House | MI | 2023-01-03 | 1 | candidate stub |
| L000594 | Kelly Loeffler | Senate | GA | 2021-01-20 | 1 | plum_id row + candidate stub |
| L000604 | Greg Lopez | House | CO | 2025-01-03 | 1 | candidate stub |
| L000605 | Erica Lee Carter | House | TX | 2025-01-03 | 1 | candidate stub |
| M000087 | Carolyn B. Maloney | House | NY | 2023-01-03 | 1 | candidate stub |
| M000639 | Robert Menendez | Senate | NJ | 2024-08-20 | 2 | sitting member + candidate stub |
| M001135 | Kathy E. Manning | House | NC | 2025-01-03 | 1 | candidate stub |
| M001156 | Patrick T. McHenry | House | NC | 2025-01-03 | 1 | candidate stub |
| M001159 | Cathy McMorris Rodgers | House | WA | 2025-01-03 | 1 | candidate stub |
| M001165 | Kevin McCarthy | House | CA | 2023-12-31 | 1 | candidate stub |
| M001166 | Jerry McNerney | House | CA | 2023-01-03 | 1 | candidate stub + other |
| M001180 | David B. McKinley | House | WV | 2023-01-03 | 1 | candidate stub |
| M001183 | Joe Manchin, III | Senate | WV | 2025-01-03 | 1 | candidate stub |
| M001185 | Sean Patrick Maloney | House | NY | 2023-01-03 | 1 | candidate stub |
| M001186 | Peter Meijer | House | MI | 2023-01-03 | 1 | candidate stub |
| M001190 | Markwayne Mullin | Senate | OK | 2026-03-23 | 2 | candidate stub + other |
| M001195 | Alexander X. Mooney | House | WV | 2025-01-03 | 1 | candidate stub |
| M001200 | A. Donald McEachin | House | VA | 2022-11-28 | 1 | — |
| M001202 | Stephanie N. Murphy | House | FL | 2023-01-03 | 1 | candidate stub |
| M001203 | Tom Malinowski | House | NJ | 2023-01-03 | 1 | candidate stub |
| M001221 | Marcus J. Molinaro | House | NY | 2025-01-03 | 1 | candidate stub |
| N000179 | Grace F. Napolitano | House | CA | 2025-01-03 | 1 | candidate stub |
| N000181 | Devin Nunes | House | CA | 2022-01-03 | 1 | candidate stub |
| N000192 | Marie Newman | House | IL | 2023-01-03 | 1 | candidate stub |
| N000194 | Wiley Nickel | House | NC | 2025-01-03 | 1 | candidate stub |
| O000171 | Tom O’Halleran | House | AZ | 2023-01-03 | 1 | candidate stub |
| P000096 | Bill Pascrell, Jr. | House | NJ | 2024-08-21 | 1 | — |
| P000449 | Rob Portman | Senate | OH | 2023-01-03 | 2 | candidate stub |
| P000523 | David E. Price | House | NC | 2023-01-03 | 1 | candidate stub |
| P000593 | Ed Perlmutter | House | CO | 2023-01-03 | 1 | — |
| P000599 | Bill Posey | House | FL | 2025-01-03 | 1 | candidate stub |
| P000601 | Steven M. Palazzo | House | MS | 2023-01-03 | 1 | candidate stub |
| P000604 | Donald M. Payne, Jr. | House | NJ | 2024-04-24 | 1 | candidate stub |
| P000615 | Greg Pence | House | IN | 2025-01-03 | 1 | — |
| P000616 | Dean Phillips | House | MN | 2025-01-03 | 1 | candidate stub |
| P000618 | Katie Porter | House | CA | 2025-01-03 | 1 | — |
| P000619 | Mary Sattler Peltola | House | AK | 2025-01-03 | 1 | candidate stub |
| R000103 | Matthew M. Rosendale, Sr. | House | MT | 2025-01-03 | 1 | — |
| R000486 | Lucille Roybal-Allard | House | CA | 2023-01-03 | 1 | candidate stub |
| R000515 | Bobby L. Rush | House | IL | 2023-01-03 | 1 | candidate stub |
| R000576 | C. A. Dutch Ruppersberger | House | MD | 2025-01-03 | 1 | — |
| R000577 | Tim Ryan | House | OH | 2023-01-03 | 1 | — |
| R000585 | Tom Reed | House | NY | 2022-05-10 | 1 | — |
| R000588 | Cedric L. Richmond | House | LA | 2021-01-15 | 1 | candidate stub |
| R000595 | Marco Rubio | Senate | FL | 2025-01-20 | 1 | plum_id row + candidate stub |
| R000597 | Tom Rice | House | SC | 2023-01-03 | 1 | candidate stub |
| R000602 | Kathleen M. Rice | House | NY | 2023-01-03 | 1 | candidate stub |
| R000615 | Mitt Romney | Senate | UT | 2025-01-03 | 2 | candidate stub |
| S000320 | Richard C. Shelby | Senate | AL | 2023-01-03 | 1 | candidate stub |
| S000770 | Debbie Stabenow | Senate | MI | 2025-01-03 | 2 | candidate stub |
| S001135 | Michelle Steel | House | CA | 2025-01-03 | 1 | candidate stub |
| S001165 | Albio Sires | House | NJ | 2023-01-03 | 1 | candidate stub |
| S001168 | John P. Sarbanes | House | MD | 2025-01-03 | 1 | candidate stub |
| S001175 | Jackie Speier | House | CA | 2023-01-03 | 1 | candidate stub |
| S001177 | Gregorio Kilili Camacho Sablan | House | MP | 2025-01-03 | 1 | candidate stub |
| S001180 | Kurt Schrader | House | OR | 2023-01-03 | 1 | candidate stub |
| S001187 | Steve Stivers | House | OH | 2021-05-16 | 1 | candidate stub |
| S001191 | Kyrsten Sinema | Senate | AZ | 2025-01-03 | 2 | candidate stub |
| S001192 | Chris Stewart | House | UT | 2023-09-15 | 1 | candidate stub + other |
| S001193 | Eric Swalwell | House | CA | 2026-04-14 | 1 | candidate stub |
| S001197 | Ben Sasse | Senate | NE | 2023-01-08 | 1 | candidate stub |
| S001204 | Michael F. Q. San Nicolas | House | GU | 2023-01-03 | 1 | candidate stub |
| S001207 | Mikie Sherrill | House | NJ | 2025-11-20 | 1 | candidate stub |
| S001209 | Abigail Davis Spanberger | House | VA | 2025-01-03 | 1 | candidate stub |
| S001219 | Joseph Sempolinski | House | NY | 2023-01-03 | 1 | candidate stub |
| S001222 | George Santos | House | NY | 2023-12-01 | 1 | — |
| T000461 | Patrick J. Toomey | Senate | PA | 2023-01-03 | 2 | candidate stub |
| T000464 | Jon Tester | Senate | MT | 2025-01-03 | 1 | — |
| T000479 | Van Taylor | House | TX | 2023-01-03 | 1 | — |
| T000483 | David J. Trone | House | MD | 2025-01-03 | 1 | candidate stub |
| T000489 | Sylvester Turner | House | TX | 2025-03-04 | 1 | candidate stub |
| U000031 | Fred Upton | House | MI | 2023-01-03 | 1 | — |
| V000132 | Filemon Vela | House | TX | 2022-03-31 | 1 | candidate stub |
| V000137 | J.D. Vance | Senate | OH | 2025-01-09 | 1 | candidate stub + other |
| W000813 | Jackie Walorski | House | IN | 2022-08-03 | 1 | — |
| W000815 | Brad R. Wenstrup | House | OH | 2025-01-03 | 1 | candidate stub |
| W000823 | Michael Waltz | House | FL | 2025-01-20 | 1 | candidate stub |
| W000825 | Jennifer Wexton | House | VA | 2025-01-03 | 1 | candidate stub |
| W000826 | Susan Wild | House | PA | 2025-01-03 | 1 | candidate stub |
| W000827 | Ron Wright | House | TX | 2021-02-07 | 1 | candidate stub |
| W000828 | Brandon Williams | House | NY | 2025-01-03 | 1 | candidate stub + plum_id row |
| Y000033 | Don Young | House | AK | 2022-03-18 | 1 | — |
| Y000062 | John A. Yarmuth | House | KY | 2023-01-03 | 1 | candidate stub |
| Z000017 | Lee M. Zeldin | House | NY | 2023-01-03 | 1 | candidate stub + plum_id row |
