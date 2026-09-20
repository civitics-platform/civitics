# FIX-1188 — ITC DROPPED-OUT committee census

**Read-only on prod, 2026-09-20 19:22–19:55 UTC (cc-139).** Nothing was written
to Pro. Every count below comes from `node scripts/db-query.mjs --prod`, which
wraps its statement in a `SET TRANSACTION READ ONLY` transaction.

Source manifest: `docs/audits/2026-09-14-fix1106-residue-2026-fec_bulk_indiv_to_committee.tsv`,
cut 2026-09-14T04:17:48Z against emit run `84470d3b-d147-5a01-b43a-e4a4d7930890`
(complete_at 2026-09-14 00:23:11+00). It carries a hand-added header from cc-126
reading **NOT AN AUTHORISATION**, above the audit writer's own default header
which says the opposite; the hand-added note flags that contradiction itself.

---

## 1. The question this census was asked, and why it had the wrong shape

FIX-1188 asks: of the 626 ITC DROPPED-OUT committees, "how many have an FE row,
how many resolve to an official, and how many are simply unminted."

**The first and third questions are answered by the manifest's own schema, not by
prod.** The manifest's key column is `to_id`, and `to_type` is
`financial_entity` for all 808 rows (626 DROPPED-OUT + 182 PARTIAL). The key
*is* a `financial_entities.id`. So a committee with no FE row cannot appear in
this file at all — "unminted" is not a class the manifest can contain.

That is not a technicality. It means the bullet's stated blocker — *"a committee
with no FE row cannot be distinguished from a committee whose binding was
retracted"* — does not describe this manifest. Everything in it is minted. The
real blocker is a different one, and §4 names it.

---

## 2. The counts

Verified on prod against the 626 manifest ids:

| # | class | count | share |
|---|---|---|---|
| (a) | has a `financial_entities` row | **626 / 626** | 100 % |
| (a′) | …and a non-NULL `fec_committee_id` | **626 / 626** | 100 % |
| (b) | resolves to an official today | **0 / 626** | 0 % |
| (c) | unminted (no FE row) | **0 / 626** | 0 % — impossible by construction |

Manifest totals, recomputed from the file: 626 distinct `to_id`, 106,278 rows,
**$536,845,833** — matching the manifest header and the FIX-1188 bullet exactly.

**Entity shape of the 626** — uniform, with no exceptions:

| property | value | count |
|---|---|---|
| `entity_type` | `pac` | 626 |
| `is_synthetic` | false | 626 |
| `metadata->>'fec_cmte_type_raw'` | `N` | 621 |
| | `Q` | 4 |
| | `V` | 1 |

**Not one is FEC type `P` (principal campaign committee) or `A` (authorized).**
That is the ITC arm working as designed: `packages/data/src/pipelines/fec-bulk/indiv.ts`
routes each indiv row by its recipient committee, and `ROUTE_CMTE` — the source
behind `fec_bulk_indiv_to_committee` — is explicitly the *non*-candidate path
(super PACs, party committees, other PACs, and per FIX-701 leadership PACs and
SSFs). Candidate-authorized committees go down `ROUTE_CAND` to `CAND_ID` to an
official instead, which is a different source.

---

## 3. Why (b) is zero, and why that is a mechanism finding rather than a data gap

**There is no persisted committee-to-official linkage anywhere in the schema.**

- `officials.source_ids` carries `fec_candidate_id` (19,600 officials), never a
  committee id. The full key census: `fec_candidate_id`, `plum_id`,
  `openstates_id`, `legistar:*`, `congress_gov`, `courtlistener_person_id`,
  `merged_fec_candidate_ids`, `misattributed_fec_id`, `congress_nomination_id`,
  `merged_into`, `wikidata_id`, `fec_id`, `prior_fec_candidate_ids`. No
  `fec_committee_id`.
- There is no `fec_committee_candidate` table. The only tables matching
  committee/candidate are `official_committee_memberships` (congressional
  committees — unrelated), `brigade_candidates` and `sybil_candidates`.
- Cross-checking every one of the 626 committee ids against
  `officials.source_ids::text` returns **0** matching officials.
- The 626's own metadata carries only `fec_cmte_type_raw` and
  `fec_connected_org_nm` (626 each) — no candidate id, no official reference.

The CMTE_ID to CAND_ID map exists only **inside the pipeline**, built per-run by
`parseCcl()` from the FEC `ccl{yy}` linkage file as an in-memory allow-list of
P/A designations. It is never written to the database. So "does this committee
belong to a candidate?" is a question prod cannot answer today, for any
committee — not just these 626.

---

## 4. What the top of the class actually looks like — and the hazard

The top 20 DROPPED-OUT committees by the manifest's `cents` column:

| # | $ | rows | committee |
|---|---|---|---|
| 1 | 82,378,471 | 1,231 | GROW THE MAJORITY |
| 2 | 22,993,372 | 8,140 | COOPER VICTORY FUND |
| 3 | 16,818,132 | 559 | EMMER MAJORITY BUILDERS |
| 4 | 16,795,970 | 308 | DEFEND OUR MAJORITY |
| 5 | 12,645,720 | 57 | NRSC VICTORY |
| 6 | 12,036,085 | 9,059 | TRUMP NATIONAL COMMITTEE JFC |
| 7 | 11,572,783 | 653 | CORNYN LONESTAR VICTORY FUND |
| 8 | 10,353,366 | 351 | JEFFRIES VICTORY FUND |
| 9 | 9,295,005 | 1,303 | WHATLEY VICTORY |
| 10 | 8,763,840 | 405 | DEMOCRATIC GRASSROOTS VICTORY FUND |
| 11 | 8,590,017 | 130 | ONE TEAM SENATE MAJORITY |
| 12 | 7,797,641 | 3,189 | OSSOFF VICTORY FUND |
| 13 | 7,244,351 | 2,038 | JOHNSON LEADERSHIP FUND |
| 14 | 7,104,812 | 1,309 | TEAM HUSTED |
| 15 | 7,044,343 | 1,776 | CORNYN VICTORY |
| 16 | 6,288,062 | 1,469 | TORRES VICTORY FUND |
| 17 | 5,898,460 | 3,544 | BOOKER VICTORY FUND |
| 18 | 5,846,023 | 2,067 | OHIO GRASSROOTS VICTORY FUND |
| 19 | 5,586,356 | 494 | TEAM MORENO |
| 20 | 5,239,855 | 1,205 | ASHLEY MOODY VICTORY FUND |

Twelve of the top twenty are named after a sitting official. **(b) = 0 does not
mean this money is unattributed in the reader's eyes — it means the database
has no field that would notice.** That inverts the safety argument: the absence
of a linkage is what makes the sweep dangerous, not what makes it safe.

### (d) Collins, the bullet's worked example — and the bullet is half wrong

The bullet says her principal committee C00314575 "has no `financial_entities`
row at all". **Confirmed on prod: zero rows for `fec_committee_id='C00314575'`.**
It is also **not in this manifest**, and it could not be — as a P-designation
committee it routes `ROUTE_CAND`, so its money reaches Senator Collins
(`officials` id `3e559d5c…`, `fec_candidate_id` `S6ME00159`) through the
`fec_bulk_indiv` source. For a P committee, "no FE row" is the designed state,
not a defect.

But the bullet's "her three committees are DROPPED-OUT on ITC" is correct, and
they are **not** C00314575. All three are in the 626:

| FE id | committee | FEC id | type | rows | $ |
|---|---|---|---|---|---|
| `ea8b727c…` | COLLINS VICTORY | C00692897 | N | 694 | 2,912,054 |
| `b2a8395d…` | COLLINS VICTORY FUND | C00824151 | N | 420 | 1,456,227 |
| `4deeea7c…` | SUSAN COLLINS FOR MAINE | C00920389 | N | 16 | 338,500 |

**`SUSAN COLLINS FOR MAINE` (C00920389) is a sitting senator's own 2026-cycle
campaign committee, stored with `fec_cmte_type_raw = 'N'`, sitting in the
DROPPED-OUT class with $338,500.** Nothing in the schema distinguishes it from
`GROW THE MAJORITY`. Collins's three total $4,706,781 across 1,130 rows.

This is [[FIX-1182]]'s hazard reaching the ITC arm by a second route. FIX-1187
shape A (shared-CAND_ID twins) genuinely does not touch ITC — the bullet is
right about that — but shape A was never the only way to delete a sitting
member's money.

### A second gap the census surfaced

`indiv.ts` excludes joint-fundraising committees (`CMTE_DSGN='J'`) at source, to
avoid double-counting money that is re-itemized via JFC-to-participant
transfers. Yet `TRUMP NATIONAL COMMITTEE JFC` is row 6 of this class, and rows
2, 7, 8, 10, 12, 16, 17, 18 and 20 are victory funds — the usual JFC shape. We
store `fec_cmte_type_raw` (CMTE_TP) but **not CMTE_DSGN**, so prod cannot tell a
JFC from a plain PAC either. Whether these are genuine non-J committees or an
exclusion that did not hold is a separate question, and this census does not
settle it — but it is a second reason the class is not safely sweepable today.

---

## 5. The SQL

```sql
-- (a) / (a-prime) / (c) — the 626 manifest ids
WITH m(id) AS (SELECT unnest(ARRAY[<626 uuids>]::uuid[]))
SELECT (SELECT count(*) FROM m)                                                 AS manifest_ids,
       (SELECT count(*) FROM m JOIN public.financial_entities fe ON fe.id=m.id) AS fe_row_present,
       (SELECT count(*) FROM m LEFT JOIN public.financial_entities fe ON fe.id=m.id
          WHERE fe.id IS NULL)                                                  AS fe_row_missing,
       (SELECT count(*) FROM m JOIN public.financial_entities fe ON fe.id=m.id
          WHERE fe.fec_committee_id IS NOT NULL)                                AS has_cmte_id;

-- shape
WITH m(id) AS (SELECT unnest(ARRAY[...]::uuid[]))
SELECT fe.entity_type, count(*), count(*) FILTER (WHERE fe.is_synthetic) AS synthetic
FROM m JOIN public.financial_entities fe ON fe.id=m.id GROUP BY 1;

WITH m(id) AS (SELECT unnest(ARRAY[...]::uuid[]))
SELECT fe.metadata->>'fec_cmte_type_raw' AS cmte_type, count(*)
FROM m JOIN public.financial_entities fe ON fe.id=m.id GROUP BY 1 ORDER BY 2 DESC;

-- (b) — every persisted path from a manifest committee to an official
WITH m(id) AS (SELECT unnest(ARRAY[...]::uuid[])),
     c AS (SELECT fe.fec_committee_id AS cid
             FROM m JOIN public.financial_entities fe ON fe.id=m.id)
SELECT count(*) AS officials_referencing_a_manifest_committee
FROM public.officials o JOIN c ON o.source_ids::text LIKE '%' || c.cid || '%';   -- 0

-- linkage census
SELECT k, count(*) FROM public.officials o, jsonb_object_keys(o.source_ids) k
GROUP BY k ORDER BY 2 DESC;                     -- no fec_committee_id key

-- (d)
SELECT id, display_name, entity_type, fec_committee_id,
       metadata->>'fec_cmte_type_raw'
FROM public.financial_entities WHERE fec_committee_id = 'C00314575';          -- 0 rows
```

The 626-uuid array was generated from the manifest with
`awk -F'\t' '$1=="DROPPED-OUT"{print $3}'`.

---

## 6. Recommendation for Monday's FIX-1106 apply

**The ITC source must be EXCLUDED from the apply.** Not deferred pending a
minting step — there is nothing to mint.

The bullet's sweep-if-empty condition was *"only if class (a)-with-resolution is
empty or tiny"*, and on its face (b) = 0 satisfies it. **That condition should
not be honoured**, because it was written on the assumption that resolution is
*measurable*. It is not: no committee-to-official linkage is persisted, so
(b) = 0 is a statement about the schema, not about the money. Twelve of the top
twenty committees are named after sitting officials and one of the 626 is a
sitting senator's own campaign committee. Sweeping on a zero that the schema
guarantees would delete $536.8M of official-associated money with nothing able
to object.

The missing step is a **committee-to-candidate binding**, not a minting pass:
persist the `ccl{yy}` P/A linkage (and CMTE_DSGN alongside it) so DROPPED-OUT
can be told apart from "a candidate committee we never bound". Filed as
FIX-1203.

One timing note for Monday, from the manifest's own header: the apply is blocked
on [[FIX-1182]] "until a second complete emit run exists (Sun 2026-09-20)", and
the header also says to **re-cut the manifest against the current emit set
before anything is applied from this slice**. This census describes the
2026-09-14 cut. Whatever lands Monday should be re-measured against the re-cut
manifest; the structural findings in sections 2-4 are properties of the arm and
will carry over, but the 626 and the $536.8M are not guaranteed to.
