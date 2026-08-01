# FIX-954 — direction signal for cross-person contamination on officials that DO have a legitimate FEC binding

Measured on the local prod-clone, 2026-08-01, **after** FIX-934 phase 2, the FIX-952
cycle backfill, and the FIX-955 fix + repair. Read-only; nothing was written.

## The problem restated

FIX-930's suspect predicate ends `AND source_ids->>'fec_candidate_id' IS NULL`. That
clause is what supplies **direction**: it identifies which side of a symmetric
donation-key overlap is the holder the matcher would never legitimately have selected.

Once an official has a valid binding — which is the correct end state, and which the
FIX-952 backfill produced for Shontel M. Brown — the audit stops seeing them, while the
contamination stays. Widening the predicate does not work: the overlap relation is
symmetric, so the same query flags Marjorie Greene (rightful holder of `H0GA06192`)
against Richard Greene, who is the actually mis-bound one.

## Candidate signal: relative staleness

The writer bumps `updated_at` on every row it believes should exist, so the binding that
is still current keeps being refreshed while a mis-binding freezes at the last run that
resolved to it. For a CROSS-person same-surname pair sharing donation keys, compare
`updated_at` per shared key.

Scoped to pairs with overlap ≥ 50% of the holder's rows and ≥ 52 shared keys:

| verdict | pairs | shared rows |
|---|---:|---:|
| one side almost always staler (≥95%) | 50 | 109,501 |
| MIXED — no clear direction | 15 | 18,694 |

So the signal *does* resolve direction on 77% of pairs, and it puts the right side first
on the reference case: **Shontel M. Brown is staler than Sherrod Brown on 42,970 of
43,001 shared keys (99.9%), $48,129,674.**

## But relative staleness ALONE is not sufficient

Probing the 13 pairs where the holder is the staler side breaks them into two groups.

| holder | own rows refreshed since 2026-07-20 | total rows | reading |
|---|---:|---:|---|
| Shontel M. Brown | 277 | 43,969 | binding LIVE, 43,001 stale+shared → contamination |
| Randy Fine | 1,235 | 3,073 | binding LIVE → contamination |
| Warren Davidson | 620 | 1,904 | binding LIVE → contamination |
| Cory Mills | 353 | 3,257 | binding LIVE → contamination |
| Clay Higgins | 315 | 906 | binding LIVE → contamination |
| Susheela Jayapal | 24 | 839 | mostly dormant — weak |
| John Huffman | 9 | 237 | mostly dormant — weak |
| Mary Waters | 3 | 149 | dormant |
| Tara Johnson | 1 | 180 | dormant |
| Carl Sherman | 0 | 115 | **dormant — staleness is not evidence** |
| Claudia De La Cruz | 0 | 109 | **dormant** |
| Ylenia Aguilar | 0 | 83 | **dormant** |
| R Ivey | 144 | 144 | **ALL rows fresh — "staler" is only a fine-grained ordering, not staleness** |

Two distinct false-positive modes:

1. **Dormant holder.** An inactive candidate whose CAND_ID no longer appears in current
   FEC files has *every* row stale. Being staler than an active same-surname official is
   then guaranteed and means nothing. Deleting would destroy their real historical money.
2. **Both fresh (R Ivey).** All 144 rows were refreshed; the counterpart merely happened
   to be refreshed microseconds later. A strict `<` comparison reports 100% "staler" on
   rows that are not stale at all.

## Proposed three-part rule — NOT YET APPLIED

A row on holder A is mis-bound only when all three hold:

- **(a) absolute staleness** — A's row was not written by the most recent run that
  processed its cycle (not merely older than B's copy), and
- **(b) a fresher owner** — a CROSS-person same-surname official B holds the same
  `(relationship_type, from_id, cycle_year)` with a strictly newer copy, and
- **(c) a live binding on A** — A has other rows that ARE current, proving A's own
  binding is being written and the stale set is therefore residue rather than A simply
  being dormant.

Shontel M. Brown satisfies all three. Carl Sherman fails (c). R Ivey fails (a).

## The MIXED 15 must not be acted on, and show a second defect

They are not merely ambiguous — several are **same-person pairs the CROSS test
mislabels**, because the first-name key is an initial and the seat differs across a
House→Senate move:

- `S Krishnamoorthi` [S6IL00482] vs `Raja Krishnamoorthi` [H6IL08147] — same person
- `James Banks` [H6IN03229] vs `Jim Banks` [S4IN00196] — same person (also FIX-956)
- `Anthony Vargas` / `Juan Vargas` — genuinely different, appears twice as its own mirror

Any FIX-954 implementation must therefore run the SAME/CROSS test *and* the three-part
direction rule, and refuse anything that fails either.

## Recommendation

Implement the three-part rule as a phase-1 manifest (the FIX-934 shape: re-derived live,
TSV + markdown, no writes), review, then apply. Do not ship the two-part
relative-staleness rule — it would delete real money from at least four dormant
candidates.
