# Members with no `officials` row — the one cause behind both "N of M on record" shortfalls (cc-340, read-only prod)

Run 2026-11-28 03:35Z → 03:46Z (Fri 11-27 evening PST). Read-only against
Supabase Pro: ten `db-query --prod` statements, each under its own
`statement_timeout`. The first read the box health; `EXPLAIN` without ANALYZE
came before the one aggregate over `votes`. Three Congress.gov GETs through `fetchCongressApi`, nothing saved. Two
reads on the local clone are marked **local** where they appear; they are the
clone's data, not prod's. The box was quiet throughout: load1 at most 0.54 in
the 3 h ring before the first read, 0 startup timeouts in 60 min, no
dispatcher hold, `session:held` false.

**The finding in one paragraph.** At least 185 members who sat in the 117th–119th
Congresses have no `officials` row, because `members.ts` reads only
`/member?currentMember=true`. None is ambiguous: every unresolved bioguide is
`why: "none"`, and no bioguide sits on two rows. They are almost all of the
House's missing member votes: 92.5 % of the House shortfall falls in the 117th
and 118th, and 98.3 % once the 119th's second cause is set aside. That cause
is [[FIX-1465]]: 54 House rolls of May–June 2026 store a quarter of their
votes and carry 79 % of the 119th's shortfall. 185 is a floor. A member who
cosponsored no stamped measure is not seen by read 3. The 117th House alone is
short about 171 members a roll, against the 151 that read 3 sees.
`/member/congress/{n}` lists every member of a past Congress (557 for the
117th, 554 for the 118th), so it can supply the exact set. Filed as
[[FIX-1464]]. Nothing here builds a backfill.

## Read 3 — the unresolved members (stamped `congress_gov` refs)

1,516 measures carry a `detail` stamp (cc-332 read 1,249). Of those, 675 list
at least one cosponsor the resolver could not place, 6,461 cosponsor
appearances in all.

**(a) / (b): distinct bioguides in `detail.cosponsors_unresolved`.** A member is
counted once in each Congress, and once in the chamber of the measure they
cosponsored.

| Congress | chamber | members | appearances | measures |
|---|---|---|---|---|
| all | all | **185** | 6,461 | 675 |
| 117 | House | 151 | 4,502 | 282 |
| 117 | Senate | 21 | 265 | 71 |
| 117 | both | 172 | 4,767 | 353 |
| 118 | House | 76 | 1,469 | 230 |
| 118 | Senate | 17 | 146 | 38 |
| 118 | both | 93 | 1,615 | 268 |
| 119 | House | 7 | 72 | 49 |
| 119 | Senate | 3 | 7 | 5 |
| 119 | both | 10 | 79 | 54 |

`why = "many"`: **0**. The STOP row did not fire.

**(c): the 25 members on the most measures.**

| bioguide | name (Congress.gov) | measures | Congresses |
|---|---|---|---|
| C001084 | Rep. Cicilline, David N. [D-RI-1] | 95 | 117, 118 |
| P000618 | Rep. Porter, Katie [D-CA-47] | 86 | 117, 118 |
| C001078 | Rep. Connolly, Gerald E. [D-VA-11] | 84 | 117–119 |
| T000483 | Rep. Trone, David J. [D-MD-6] | 82 | 117, 118 |
| W000826 | Rep. Wild, Susan [D-PA-7] | 78 | 117, 118 |
| S001193 | Rep. Swalwell, Eric [D-CA-15] | 76 | 117–119 |
| S001207 | Rep. Sherrill, Mikie [D-NJ-11] | 74 | 117–119 |
| G000582 | Rescom. González-Colón, Jenniffer [R-PR-At Large] | 73 | 117, 118 |
| K000381 | Rep. Kilmer, Derek [D-WA-6] | 73 | 117, 118 |
| M001135 | Rep. Manning, Kathy E. [D-NC-6] | 73 | 117, 118 |
| J000032 | Rep. Jackson Lee, Sheila [D-TX-18] | 72 | 117, 118 |
| L000551 | Rep. Lee, Barbara [D-CA-13] | 72 | 117, 118 |
| L000578 | Rep. LaMalfa, Doug [R-CA-1] | 72 | 117–119 |
| A000376 | Rep. Allred, Colin Z. [D-TX-32] | 71 | 117, 118 |
| S001209 | Rep. Spanberger, Abigail Davis [D-VA-7] | 69 | 117, 118 |
| P000616 | Rep. Phillips, Dean [D-MN-3] | 66 | 117, 118 |
| B001270 | Rep. Bass, Karen [D-CA-37] | 65 | 117 |
| G000551 | Rep. Grijalva, Raúl M. [D-AZ-7] | 64 | 117, 118 |
| G000590 | Rep. Green, Mark E. [R-TN-7] | 64 | 117–119 |
| M000087 | Rep. Maloney, Carolyn B. [D-NY-12] | 64 | 117 |
| B000574 | Rep. Blumenauer, Earl [D-OR-3] | 63 | 117, 118 |
| K000380 | Rep. Kildee, Daniel T. [D-MI-8] | 63 | 117, 118 |
| E000215 | Rep. Eshoo, Anna G. [D-CA-18] | 62 | 117, 118 |
| N000192 | Rep. Newman, Marie [D-IL-3] | 60 | 117 |
| M001203 | Rep. Malinowski, Tom [D-NJ-7] | 59 | 117 |

**(d): `detail.sponsor_outcome`.**

| Congress | `set` | `unresolved_none` (measures) | unresolved sponsors (members) |
|---|---|---|---|
| 117 | 369 | 164 | 89 |
| 118 | 373 | 88 | 47 |
| 119 | 517 | 5 | 3 |
| all | 1,259 | 257 | 114 |

No other value occurs. All 114 unresolved sponsors are among the 185: no
member is missing as a sponsor only.

## Read 4 — against `officials`

**(a) Rows with `source_ids ? 'congress_gov'`:** 542. Of those, 539 are
`tier = 'elected'` and `is_active`, and 3 are `tier = 'former'` and not active
(FIX-409's reconcile flips). **(b)** No bioguide sits on two rows.

**(c) The 185 under any other key.** The match is the Congress.gov name
`Last, First M.`, parsed into `last_name` and a first name. It counts when
`last_name` is equal and either `first_name` is equal or `full_name` starts
with the first name, ignoring case. All 185 names parsed.

- **136 of the 185 have a same-name row with no bioguide.** That is 164 rows,
  every one `tier = 'candidate'` and keyed by `fec_candidate_id`: 158 active
  rows (131 members) and 6 inactive (6 members). Some members have several:
  Colin Allred has 3, Sherrod Brown 2. They are FEC candidate stubs for the
  same people.
- **49 have no row under any name.**
- **1 shares a name with a sitting bioguide row.** Sen. Robert Menendez
  (M000639, NJ) has none of his own. Row `747c96d0-962a-4448-a405-e055dbce8f69`
  "Robert Menendez" (`elected`, active, keys `congress_gov`, `fec_candidate_id`,
  `prior_fec_candidate_ids`) is the sitting Rep. Rob Menendez of NJ.

Ten of the same-name rows:

| bioguide | Congress.gov name | row id | `full_name` | tier / active | keys |
|---|---|---|---|---|---|
| A000376 | Rep. Allred, Colin Z. | 4b0432cc-b13d-42bf-8a47-9240c1a7df38 | Colin Allred | candidate / true | fec_candidate_id |
| A000376 | Rep. Allred, Colin Z. | 29eee756-b8e1-4f5d-b52d-50d9b2b9a177 | Colin Allred | candidate / true | fec_candidate_id |
| A000376 | Rep. Allred, Colin Z. | 252c05cb-e0f0-4d9c-9864-3f87ee67a19d | Colin Allred | candidate / true | fec_candidate_id |
| A000377 | Rep. Armstrong, Kelly | 31c4fb8d-6650-4389-b63e-76a042f50a2b | Kelly Armstrong | candidate / true | fec_candidate_id |
| B000574 | Rep. Blumenauer, Earl | dcdeacd4-02a3-477f-8531-80048de7ff75 | Earl Blumenauer | candidate / true | fec_candidate_id |
| B000575 | Sen. Blunt, Roy | 88fcef99-6ecd-43eb-95e8-c12971a4c7a4 | Roy Blunt | candidate / true | fec_candidate_id |
| B000755 | Rep. Brady, Kevin | 6a09e6c8-fd08-42a2-b1f4-9b8299f39e8c | Kevin Brady | candidate / true | fec_candidate_id |
| B000944 | Sen. Brown, Sherrod | d758a091-fa36-47d4-b2b0-e264d41f1fc2 | Sherrod Brown | candidate / true | fec_candidate_id |
| B000944 | Sen. Brown, Sherrod | ac03bb85-dccf-4ad9-98a3-08696ef05211 | Sherrod Brown | candidate / true | fec_candidate_id |
| B001135 | Sen. Burr, Richard | 5e80ab02-d193-4d13-989e-032d590e1abc | Richard Burr | candidate / true | fec_candidate_id |

## Read 5 — the vote shortfall by Congress

The statement read stored rows per roll from `votes_roll_call`. The plan, read
first: `Index Only Scan using votes_roll_call on votes v` under a
`GroupAggregate`, merge-joined to `vote_rolls_pkey`. It joined those counts to
`vote_rolls` rows that carry all four counts, and ran once.

| chamber | Congress | rolls | official casts | stored rows | shortfall | median stored a roll |
|---|---|---|---|---|---|---|
| House | 117 | 913 | 393,142 | 236,630 | 156,512 | 260 |
| House | 118 | 979 | 425,633 | 316,939 | 108,694 | 324 |
| House | 119 | 682 | 294,850 | 273,261 | 21,589 | 428 |
| Senate | 119 | 110 | 10,998 | 10,998 | 0 | 100 |

The 119th's mean shortfall is 31.7 a roll. Its median is about 4 (428 stored
of about 432 cast), which does not fit 7 missing members. One more statement
split it by short roll, using a per-roll count from the same index:

| 119th House rolls | rolls | official | stored | shortfall | median short | stored range | ids | dates |
|---|---|---|---|---|---|---|---|---|
| stored ≥ 60 % of official | 628 | 271,627 | 267,055 | 4,572 | 5 | 374–437 | 2025-house-003 … 2026-house-327 | 2025-01-03 … 2026-11-19 |
| stored < 60 % | **54** | 23,223 | 6,206 | **17,017** | 324 | 98–193 | 2026-house-156 … 2026-house-209 | 2026-05-12 … 2026-06-08 |

On the local clone, the short rolls carry both parties and nearly every surname
initial (2026-house-160: 106 rows; 2026-house-176: 98). That points to a
truncated write, not missing members. The nightly's House leg skips any roll id
already present in `votes` (the FIX-463 skip-check in `votes.ts`), so nothing
re-reads one. Filed as **[[FIX-1465]]**.

**The Senate 117th–118th is unread on prod.** No Senate roll there has all four
counts yet: every one is list-only, and the walker's 110 Senate details are all
119th. A **local** read compared the list's yea + nay with stored `yes` / `no`
rows:

| Senate (local clone) | rolls | list yea + nay | stored yes / no | short |
|---|---|---|---|---|
| 117 | 693 | 66,707 | 52,274 | 14,433 (21.6 %) |
| 118 | 605 | 57,394 | 48,631 | 8,763 (15.3 %) |
| 119 | 591 | 57,074 | 55,975 | 1,099 (1.9 %) |

## Read 6 — Congress.gov `/member/congress/{n}`

The endpoint exists (Cowork's memory of the name was right). Three GETs at
`limit=250`:

| request | `pagination.count` | first page |
|---|---|---|
| `/member/congress/118` | **554** | 250, `next` set |
| `/member/congress/117` | **557** | 250, `next` set |
| `/member/congress/117?currentMember=false` | 557 | the same first item (a sitting senator) |

Each item carries `bioguideId`, `name` (`Last, First`), `partyName`, `state`
(the full name), `district` (that Congress's: Slotkin is 8 in the 117th and 7
in the 118th), `depiction`, `updateDate` and `terms.item[]`. Those terms span
the whole career, as `{chamber: "House of Representatives" | "Senate",
startYear, endYear}`, not that Congress's alone. All 250 items on each page
had all five fields. **`currentMember=false` is ignored on this path**, so the
former members must be found by diffing the list against the bioguide-keyed
rows. A Congress is three pages.

## The four answers

**1. How many, and whether any is ambiguous.** At least 185 distinct members
have no row: 172 sat in the 117th (151 House, 21 Senate), 93 in the 118th (76,
17) and 10 in the 119th (7, 3). A member who served in several Congresses
counts in each. None is `many`, and no bioguide is on two rows. 185 is a floor.
The 117th House's stored rolls are short about 171 members a roll and the
118th's about 111, against read 3's 151 and 76. The exact set is the paged
`/member/congress/117`, `/118` and `/119` lists, less the 542 bioguide-keyed
rows.

**2. The 117th and 118th share.** In the House, 265,206 of 286,795 missing
member votes are in the 117th and 118th: **92.5 %** (117th 54.6 %, 118th
37.9 %). Set aside FIX-1465's 54 short rolls and the share is 265,206 of
269,778, **98.3 %**. The 119th's remaining 4,572 is a median 5 a roll, about
the 7 members read 3 sees there plus vacancies. In the Senate, prod cannot
answer yet: the 119th's 110 detailed rolls are short 0 of 10,998, and the
117th–118th carry no present / not-voting counts. The local clone's yea / nay
comparison puts 95.5 % of the Senate's gap in the 117th and 118th.

**3. The code that would create the rows.** `officials.ts` preloads
bioguide-keyed rows with no tier filter (`existingMap`, last write wins on a
duplicate bioguide, 0 today). It updates a match, deleting `source_ids` and
`metadata` from the payload first, and inserts the rest in batches of 50.
Every row it writes is `is_active: true`, `tier: 'elected'` (the FIX-409
comment says it is "only ever applied to current congress members"),
`term_start` from the last term's `startYear`, and `term_end` hard-coded to
`2027-01-03` for a Representative. After the loop it runs promotion, then
`reconcile-former-members.ts`, which treats the roster it was passed as "the
feed". That roster's floor is 500. Read 6's endpoint returns the same item
shape `officials.ts` already consumes. So fed `/member/congress/117` as is,
`officials.ts` would:

- write 557 rows as sitting members;
- run promotion against them;
- flip every sitting member who was not in the 117th to `former`, because 557
  clears the floor.

A backfill needs its own writer, or an explicit "this is not the current
roster" mode: `tier = 'former'`, `is_active = false`, term dates from
`terms.item[]`, and no reconcile.

**4. The name-keyed resolvers a new `tier = 'former'` row would enter.** The
survey covered every write-time path that resolves `officials` by name. The
ones with no `is_active` or `tier` filter would see a former row:

| resolver | resolves | key | filter | duplicate names | a former namesake would |
|---|---|---|---|---|---|
| `irs990/writer.ts:257-305` | 990 officer → official | canonical first + last, and canonical `full_name` | none | **last write wins** on first + last (`map.set`), keyset by `id` | take the match from a sitting namesake when its id sorts later, at `match_confidence 1.0` |
| `plum-book/index.ts:422-464` | PLUM appointee with no `plum_id` | lower-cased `full_name` | none | **first wins**, in an unordered select | take the match by row order, then get `is_active` set from the appointee's `isCurrent` (`:545`) |
| `littlesis/matcher.ts:175-357` | LittleSis person → anchor | surname, then state, then first 3 letters | none | lists; 2 or more go to review, but a lone surname binds with no first-name check | turn a sitting member's bind into a review item, or bind alone by surname |
| `agency-leadership/index.ts:265-296` | confirmed nominee → appointment | `ilike full_name` | none | refuses 2 or more, then inserts a new row | turn a unique adopt into a duplicate insert; an adopted row is written `is_active: true` (`:287`) |
| `agency-leadership/index.ts:657-672` | Wikidata leader (insert-error recovery) | `ilike full_name`, `.maybeSingle()` | none | 2 or more → counted `failed` | fail the recovery |

These would not see a former row (`is_active = false`):

| resolver | why |
|---|---|
| `fec-bulk/index.ts` `matchRow` (`:726-795`) and `perCycleNameFallback` (`:826-885`) | `.eq("is_active", true)` on `loadOfficials` |
| `congress/votes.ts:373-386` (Senate casts, `senateNameKey` last name : state) | `is_active` and `tier = 'elected'` (`currentGoverningBodyMembers`) |
| `congress/promote-candidates.ts:240-282` | the elected side is `is_active`; the candidate side is `tier = 'candidate'` |

The bioguide-keyed resolvers are the reason to backfill, and none of them
filters on tier:

- `votes-maps.ts` `buildBioguideMap`, the House casts, which loads every
  official;
- `bill-details-parse.ts` `buildBioguideResolver`, which resolves `none`,
  `one` or `many`;
- `officials.ts`' preload.

Two of these cut against a backfill. The **Senate** casts resolve by name and
state against sitting elected senators only, so a former senator's row would
not take a single 117th or 118th Senate vote until that resolver changes. And
the one known namesake, Menendez, is exactly the irs990 / plum-book / LittleSis
case: a former Sen. Robert Menendez row beside the sitting Rep. Robert Menendez,
both NJ.

CourtListener (`courtlistener/writer.ts`) and fec-bulk's `writer.ts` key on
external ids, not names. The supervised scripts (`move-stub-senate-votes.ts`,
`merge-same-person-official-dupes.ts`) filter on `elected` and `is_active`, or
on `elected` / `candidate`.

## What a former-member backfill's first prompt would have to decide

- **Where the rows come from.** `/member/congress/117`, `/118` and `/119`, paged
  at three GETs each, diffed against bioguide-keyed rows of any tier. Which
  Congresses: the 117th is where the votes start.
- **Which writer.** Not `officials.ts` as it stands (answer 3). Decide the
  former row's `tier`, `is_active`, `role_title`, term dates and
  `governing_body_id` from `terms.item[]`.
- **The candidate stubs.** 136 of the 185 have FEC `candidate` rows by name. Do
  the former rows absorb them through the row-deleting promote RPC, or stay
  beside them? Promotion today pairs only active `elected` rows.
- **The name-keyed resolvers** (answer 4). Filter irs990, plum-book and
  LittleSis to sitting members before the rows land, or land them and measure
  what moves.
- **Re-resolution.** A House cast with no row was counted and not written. A
  117th–118th re-run (`votes-backfill.ts` runs `votes.ts` per Congress) would
  add on the order of 265 k rows, plus the vote arm's edges. The watermark and
  vacuum rules apply. The Senate needs its resolver changed first.
  `bill-details` stamps carry the bioguides, so cosponsors and sponsors
  re-resolve from the stamp with no GET.
