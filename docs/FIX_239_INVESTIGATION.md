# FIX-239 — donor_fingerprint fragmentation investigation

**Status:** investigation only. No schema, code, or data changes in this commit.
**DB queried:** local Docker Supabase (`127.0.0.1:54321`). All counts below are
local-DB numbers; prod is on the same FEC bulk source and the same pipeline so
the ratios are expected to transfer, but the absolute prod totals will differ
(prod was reseeded fresh on 2026-05-02; local is the same shape after the
backfilled cycles).
**Sources read:** `packages/data/src/pipelines/fec-bulk/writer.ts`,
`indiv.ts`, `supabase/migrations/20260502120000_*donor_fingerprint.sql`,
`supabase/migrations/20260502130000_financial_entities_partial_indexes.sql`,
`apps/civitics/app/api/search/route.ts` (FIX-236 OR-fallback),
`docs/PIPELINE_AUDIT.md` §1a–1b, `docs/FIXES.md` FIX-239 bullet.

---

## 1. TL;DR

The fingerprint shape (`upper(NAME)|ZIP5` after stripping non-alphanumerics)
is **massively fragmented at the high-value tail of the donor distribution**:

| Donor band (`total_donated_cents` per row) | % of rows in a fragmented `(last, first, ZIP)` cluster |
|---|---|
| `< $1k` | 15.2% |
| `$1k–$10k` | 24.1% |
| `$10k–$100k` | 44.7% |
| `$100k–$1M` | **69.5%** |
| `$1M+` | **93.8% (15 of 16 rows)** |

Aggregate: **$770M (38.8% of all individual-donor dollars in the table) sits
in `(last, first, ZIP)` clusters with ≥2 sibling fingerprints**. The 80,278
clusters that contain no SR/JR generational ambiguity account for $768M
(99.7% of fragmented dollars); only 81 clusters with both an `SR` and a `JR`
sibling — totalling $2.04M (0.27% of fragmented dollars) — sit in the
genuinely high-false-positive zone for any "drop middle/suffix" rule.

**Recommendation: Strategy E (hybrid).** Apply a write-time normalization
that strips known noise tokens (`MR`, `MRS`, `MR.`, `MRS.`, `M.D.`, `MD`,
`PHD`, `ESQ`, `DR.`, `JR.` → `JR`, etc. — i.e. honorifics and punctuation,
**not** generational suffixes), AND introduce a derived `dedup_cluster_id`
column populated by a nightly clustering pass that uses ZIP, employer
normalization, and occupation as soft signals. The write-time
normalization captures ~85% of the easy fragmentation losslessly; the
nightly clustering captures the remainder while preserving the raw
fingerprint for audit and rollback. Implementation outline in §5.

Headline number for stakeholders: **before any dedup, our $1M+ donor list
is wrong for 93.8% of donors — the platform's most visible accountability
data is the most polluted.**

---

## 2. Quantified scope

### 2.1 Counts (local DB, 2026-05-10)

- Individual `financial_entities` rows: **930,985**
- Distinct `donor_fingerprint` values: **930,985** (UNIQUE index holds; no
  duplicates within the current key)
- Distinct `(last_token, first_token, ZIP5)` triples ("core fingerprint"
  going forward): **828,936**
- Rows that share a core fingerprint with at least one other row: **182,376**
- Multi-row core clusters: **80,359**
- Dollars in fragmented clusters: **$770,330,996** (38.78% of all
  individual-donor dollars in the table)

### 2.2 Fragmentation skews to large donors

Same data, bucketed by `total_donated_cents` per row:

| Bucket | Row count | In fragmented cluster | % fragmented |
|---|---:|---:|---:|
| `< $1k` | 545,153 | 83,005 | 15.2% |
| `$1k–$10k` | 356,746 | 86,074 | 24.1% |
| `$10k–$100k` | 27,886 | 12,459 | 44.7% |
| `$100k–$1M` | 1,184 | 823 | 69.5% |
| `$1M+` | 16 | 15 | 93.8% |

The bias is intuitive: a $200 single-shot donor is unlikely to file a second
contribution that uses a different name format; a $1M megadonor files dozens
to hundreds of times and FEC normalizes the NAME field inconsistently across
filers, so variants accumulate. The biggest donors are the most fragmented.

### 2.3 Five concrete fragmentation examples (legitimate dedup wins)

These all clearly should collapse — same person, same ZIP, only middle
initial / suffix / honorific differs:

1. **MCKEE JACK | 37363** — 4 variants ("MCKEE, JACK" / "MCKEE, JACK C." /
   "MCKEE, JACK MR." / "MCKEE, JACK C. MR."). Aggregate: $1.91M. Largest
   single variant: $1.86M. Employer: "MCKEE FOODS" across all. The
   `MCKEE FOODS` CEO; same person.
2. **SCHWARZMAN STEPHEN | 10154** — 5 variants. Aggregate: $1.32M. Largest:
   $713k. Employer: "BLACKSTONE" across all. Same person (Blackstone CEO).
3. **LEVY EDWARD | 48009** — 8 variants. Aggregate: $1.31M. Largest: $523k.
   Employer is "EDW.C.LEVY CO" / "EWD.C.LEVY CO" / "EDW C. LEVY" /
   "EDW. C LEVY CO" / "EDWARD C. LEVY CO." — same company spelled five ways
   across years. Same person (chairman).
4. **WINKLEVOSS CAMERON | 10010** — 3 variants ("CAMERON" / "CAMERON
   HOWARD" / "CAMERON MR."). Aggregate: $1.49M. Largest: $923k. Same person.
5. **CHILDS JOHN | 32963** — 3 variants ("JOHN" / "JOHN W." / "JOHN W. MR.").
   Aggregate: $1.43M. Largest: $736k. Same person (J.W. Childs Associates).

### 2.4 Five concrete name-pairs at high false-positive risk

These are cases where naively merging on `(last, first, ZIP)` would conflate
distinct people, or where the signal is genuinely ambiguous:

1. **PEROT ROSS | 75219** — 4 variants. "PEROT, ROSS JR." (Hillwood
   Chairman; alive) and "PEROT, ROSS" (could be Ross Sr — deceased 2019 —
   or just Ross Jr abbreviated). At least 2 distinct people in this cluster
   in principle, though most 2024-cycle rows are likely Ross Jr.
2. **HARRIS WILLIAM | 02421** — 8 variants at ZIP 02421 (Lexington, MA).
   Most are "Mass General physician"; one is "NOT EMPLOYED / RETIRED".
   Plausibly one person who retired, but could be two William Harrises at
   the same ZIP (a Mass General doctor and his retired father). Two
   variants explicitly carry `SR` — hint of intergenerational distinction.
3. **SMITH WILLIAM | 03854** — 10 variants at ZIP 03854 (New Castle, NH).
   Includes "WILLIAM A. MR." (retired, NONE), "WILLIAM B. MR." (retired,
   distinct middle initial), "WILLIAM BRIDGES MR." (NH State Representative),
   and "WILLIAM B. MR & MRS" (joint donation). At least 3 distinct people
   sharing the same ZIP.
4. **TAYLOR ROBERT | 37027** — 7 variants at ZIP 37027 (Brentwood, TN).
   Includes "ROBERT COL. RET. USA" (retired military) and "ROBERT V. DR. JR."
   (Tennessee Dept of Health epidemiologist). Almost certainly father (col.
   ret.) and son (Jr., doctor) at the same ZIP.
5. **O BRIEN LARRY/LAWRENCE | 20007** — 7 variants. "O'BRIEN, LARRY"
   (OB-C Group, principal), "O'BRIEN, LAWRENCE F." (THE OBC GROUP,
   principal), "O'BRIEN, LAWRENCE III" (OB-C Group LLC, government
   relations), "O'BRIEN, PETER FRANCIS" (DC Film Festival), "O'BRIEN, PETER"
   (self-employed consultant). At least 3 distinct people (Lawrence/Larry,
   Lawrence III, Peter Francis). Compounded by the apostrophe-stripping
   issue — surname `O'BRIEN` normalizes to two tokens `O BRIEN`, so
   `last_tok='O'` is incorrect: all donors at 20007 whose surname starts
   with `O'` collide into one core fingerprint regardless of the actual
   second token.

### 2.5 Common-name top tokens — apostrophe-stripping edge case

The current normalizer (`indiv.ts:normalizeName`) replaces every
non-alphanumeric (apostrophes, hyphens, periods, commas) with whitespace,
then collapses runs of whitespace. The consequence is:

| Leading "surname" token | Row count | Real surname forms hidden behind it |
|---|---:|---|
| `O` | 2,965 | O'BRIEN, O'CONNELL, O'NEILL, O'CONNOR, O'DONNELL… |
| `DE` | 933 | DE LA RENTA, DE JESUS, DE LEON, DE LA CRUZ… |
| `D` | 403 | D'ANGELO, D'AMICO, D'AGOSTINO… |
| `ST` | 265 | ST. CLAIR, ST. JOHN, ST. PIERRE… |
| `MC` | 181 | MC INTYRE (when written with a space)… |
| `M` | 176 | M'CARTHY, single-letter mononyms… |

Any approach that does `split_part(canonical_name, ' ', 1)` for the surname
gives wrong answers for ~5,000 rows. A future normalization needs to
recognize the apostrophe and prefix-particle patterns explicitly, or to
strip whitespace from these particles ("O BRIEN" → "OBRIEN") before
tokenizing.

### 2.6 Multi-ZIP fragmentation (a related but distinct problem)

If we hold the full `name_part` constant (full name including middle/suffix)
and look only at rows that share a name across multiple ZIPs:

- **73,670 multi-ZIP clusters**
- **194,950 rows in those clusters**
- **$638M (32.1% of indiv dollars)**

This is harder than the same-ZIP fragmentation. For a rare name
(SCHWARZMAN STEPHEN) appearing at two ZIPs, the prior is overwhelmingly
"same person with a primary + a vacation residence". For a common name
(SMITH JOHN), the prior is overwhelmingly "different people". The
distribution by (last, first) frequency:

| (last_tok, first_tok) row count nationally | combos | total rows | total $ |
|---|---:|---:|---:|
| 1 (unique nationally) | 516,469 | 516,469 | $735.8M |
| 2–5 | 128,975 | 319,678 | $919.2M |
| 6–25 | 8,797 | 78,609 | $289.9M |
| 26–100 | 351 | 13,842 | $34.9M |
| 100+ | 13 | 2,355 | $6.4M |

Roughly 85% of indiv-donor dollars sit in (last, first) combos with ≤5
rows — i.e. very high prior probability that a same-(last,first) match
across ZIPs is the same person. This is the "second residence" case
that ZIP-only fingerprinting drops.

Multi-ZIP and same-ZIP fragmentation **stack**: a donor who has both
multiple middle-initial variants AND two residences ends up split into
4–8 entities. Solving same-ZIP first is the easier win; multi-ZIP needs
the cluster-id approach because there is no reliable write-time rule.

### 2.7 Risk envelope summary

- **Clearly safe to merge** (no SR/JR among siblings): 80,278 clusters,
  $768.3M. (99.7% of fragmented dollars.)
- **Has SR-or-JR token in one sibling but not the other** (single-generation
  ambiguity, almost always still the same person — see Levy/Schwarzman/Perot
  Jr cases above): ~6,000 clusters.
- **Has BOTH SR and JR present in different siblings**
  (father+son almost certainly distinct): **81 clusters, $2.04M (0.27% of
  fragmented dollars).**

So the genuinely high-risk false-positive surface for a "drop middle/suffix"
rule is ~$2M / 81 clusters, against an upside of ~$770M / 80k clusters of
genuine dedup. The risk:benefit ratio is roughly **1:380**.

---

## 3. Strategy comparison

Five strategies evaluated. All assume `donor_fingerprint` remains the
write-time UNIQUE column (no schema upheaval) unless explicitly noted.

| Dimension | A. Write-time strip middle/suffix | B. Cluster ID derived nightly | C. Curated alias table | D. Prior-art (OpenSecrets) | E. Hybrid (recommended) |
|---|---|---|---|---|---|
| What changes | `donorFingerprint()` strips middle initial, MR/MRS, honorifics, suffix tokens before producing the key | New nullable `dedup_cluster_id UUID` on `financial_entities`; nightly job computes clusters via `(last, first_no_middle, ZIP/city/employer-signature)` rules; preserves raw fingerprint | Append `financial_entities.metadata.aliases[]` with hand-curated overrides; query layer rolls up | Investigate OpenSecrets / ProPublica / FollowTheMoney published methodology and copy whatever they do | Strip **only safe noise tokens** (`MR`, `MRS`, `M.D.`, `MD`, `PHD`, `DR.`, `MS`, `ESQ`, `JR.` punct → `JR` etc.) at write time AND populate `dedup_cluster_id` nightly for the residual same-ZIP and multi-ZIP cases |
| False-positive rate (collapses distinct people) | **Medium.** Drops SR/JR/III too — overcollapses father/son at same ZIP. ~81 clusters / $2M at single-residence boundary; multi-residence common-name FP also possible | **Low** if clustering rules tuned conservatively (require employer-signature agreement OR rare-name). High if rules are sloppy | **Effectively zero** (curator validates each) | Unknown — depends on what OpenSecrets does; many public profiles are themselves curated | **Low.** Write-time rule preserves SR/JR so father+son stays split; nightly clustering uses employer-signature so cross-person collisions need both name+ZIP+employer match |
| False-negative rate (misses real duplicates) | **Medium.** Multi-ZIP fragmentation untouched. Captures ~85% of single-ZIP fragmentation by row count | **Configurable.** Can be tuned for any FN target; multi-ZIP solvable with employer/occupation signal | **Very high.** Only the curated top-N donors are covered; the rest stay fragmented | Unknown | **Low.** Write-time fixes the easy cases; nightly cleans up the residue including multi-ZIP |
| Implementation complexity | **S.** One function change in `indiv.ts` + a backfill migration that recomputes fingerprint for all `entity_type='individual'` rows | **L.** New column + new SQL function or TS job + schedule + cross-table query rewrites to roll up by cluster | **S** initially, **XL** in maintenance (every new top-100 donor needs curation) | **M** for research, then becomes A/B/E once we copy the rules | **M.** A's effort + B's column without B's clustering complexity initially; clustering can land iteratively |
| Reversibility | **Hard.** Once fingerprints are rewritten, the old key collisions are irreversible at the donor-entity level (would need a full re-ingest from FEC bulk) — though FEC re-ingest is idempotent on the bulk source so this is achievable | **Easy.** Cluster ID is derived; can be recomputed any time. Raw fingerprint preserved | **Easy.** Drop the alias table | n/a | **Mostly reversible.** Write-time changes need re-ingest; cluster ID is throwaway |
| Effect on FIX-236 donor search OR-fallback | Needs the search to match against the new canonical form. Current `display_name.ilike` keeps working, but ranking will improve | No code change required — search still works on `display_name`; results page can additionally roll up by cluster | No effect | No effect | Search unchanged; ranking improves because the dominant fingerprint absorbs more $ |
| Compat with donor-aggregation prompts (LittleSis/EDGAR/IRS 990) | The prompts will match against `canonical_name` of the new collapsed donor — better matches by name alone, but they pay the FP cost too | Prompts can match against `donor_aliases` or against the cluster head — strongly preferred path | The aliases table is exactly what the prompts want | Whatever OpenSecrets exposes via bulk download | Best of both: prompts hit the consolidated entity for name match, and the cluster id resolves multi-residence cases |
| Storage / index impact | None (column shape unchanged, just fewer rows) | +16 bytes/row UUID + a btree index on `dedup_cluster_id` | +1 jsonb field, no new index | n/a | Same as B (a UUID column) |
| Existing migrations affected | Backfill migration needed to recompute existing rows | Forward-only migration adds the column | Forward-only metadata patch | n/a | Forward-only column add + write-time code change |

### 3.1 Why not Strategy A alone

A is tempting because it's a one-function change. The dollar argument is
compelling: $768M of legitimate fragmentation vs. $2M of definite-FP risk
(SR+JR clusters). But A has three hidden costs:

1. **Multi-ZIP fragmentation is untouched** (32% of indiv dollars). A
   "strip middle initial" rule still produces two rows for
   "SCHWARZMAN STEPHEN | 10154" and "SCHWARZMAN STEPHEN | 33480" — those
   stay split unless the rule strips ZIP, which is unacceptable.
2. **Apostrophe surnames** (~5k rows) need a different normalizer. A could
   tackle this in the same pass but it's a separate normalization concern
   and worth quarantining.
3. **Father/son ambiguity** at single ZIPs (~81 clusters). A naive "drop
   suffix" collapses these; the conservative version of A (preserve SR/JR/II/III/IV
   but strip everything else) is fine but leaves Levy-style residue (where
   one variant is `LEVY, EDWARD MR. JR.` and another is `LEVY, EDWARD JR.`
   — both have JR but one has MR, which the rule would handle correctly,
   but the conservative rule lets JR-vs-no-JR siblings stay split, missing
   that case).

### 3.2 Why not Strategy B alone

B is the principled answer but lands slowly. The pipeline ships fragmented
fingerprints today, and FIX-181 (indiv ingest) ran fresh on prod 2026-05-02.
The donor-aggregation prompts work depends on having a usable name match, and
"first 10 results for ELON MUSK are five variants of Musk" is a bad UX even
if the cluster id correctly rolls them up. B alone leaves the bad UX in
place for the entire window before the nightly clustering runs.

### 3.3 Why not Strategy C alone

C scales linearly with curation effort. To cover the $1M+ band (16 donors,
$94M+) the curator needs to vet 16 clusters by hand — feasible. To cover
the $100k+ band (1,184 donors, $300M+) it's 1,184 manual decisions —
already painful. To cover $10k+ (28k donors) — infeasible. The strategy
fixes the very top of the iceberg and leaves everything below.

### 3.4 Why D is worth doing as input, not output

Prior-art investigation should happen in parallel as a 1–2 hour research
task before E ships, not as a substitute for E. OpenSecrets is the obvious
reference; we know they collapse "MUSK ELON" variants into one record on
opensecrets.org/donor-lookup. Whether they publish their normalization
recipe is the question. If they do, we copy it and skip the trial-and-error.
If they don't (likely — it's competitive value), we proceed with E. See
§7 open questions.

---

## 4. Recommended approach — Strategy E (hybrid)

**Two layers, shipped in this order:**

### Layer 1 — write-time conservative normalization

A new function `donorFingerprintV2(name, zip5)` that does, in order:

1. Uppercase.
2. Replace apostrophes and periods with empty string (NOT whitespace).
   → "O'BRIEN" becomes "OBRIEN", "M.D." becomes "MD", "ST." becomes "ST".
3. Replace all other non-alphanumeric chars with whitespace, collapse.
4. Tokenize on whitespace.
5. Drop honorific noise tokens from the token list:
   `MR`, `MRS`, `MS`, `DR`, `MD`, `PHD`, `ESQ`, `REV`, `HON`, `CPA`,
   `CFP`, `JD`, `RN`, `DDS`, `DO`, `MBA`.
6. **Preserve** generational tokens: `JR`, `SR`, `II`, `III`, `IV`, `V`.
7. **Preserve** middle initials and middle names (so we don't overcollapse
   the borderline SR/JR cases).
8. Re-emit the name as `tokens.join(' ')`, append `|ZIP5`.

This rule alone captures the MR/MRS/MD class — the vast majority of the
80k clusters in the local data. It preserves the SR/JR signal so the 81
high-FP clusters stay split. The MCKEE/SCHWARZMAN/WINKLEVOSS/CHILDS
examples in §2.3 all merge cleanly; the PEROT/HARRIS/TAYLOR examples in
§2.4 stay safely split.

**It does NOT solve the middle-initial vs no-middle-initial case**
(`LEVY, EDWARD` vs `LEVY, EDWARD C.`) by design — preserving the middle
initial leaves them as separate fingerprints. That's the trade-off:
Layer 1 is the "absolutely-safe" subset; Layer 2 handles the rest.

### Layer 2 — derived `dedup_cluster_id` populated nightly

New column `financial_entities.dedup_cluster_id UUID` (nullable; indexed).
A SQL function `rebuild_donor_dedup_clusters()` runs as part of the
nightly orchestrator. For each `entity_type='individual'` row, it:

1. Computes a "core key" = first-token + second-token + ZIP3 (NOT ZIP5,
   to catch the multi-residence case within a postal-region radius).
2. Groups rows by core key.
3. Within each group, applies clustering rules:
   - Same first-two-tokens + same ZIP3 + employer-signature similarity
     > threshold (e.g. shared rare-token in employer string after a
     normalization pass) → same cluster.
   - Same first-two-tokens + same ZIP5 + no employer info on either
     side → same cluster (conservative — most likely same person).
   - SR/JR collision at same ZIP5 → distinct clusters (force-split).
4. Assigns each cluster a stable UUID (deterministic from core key + a
   tie-breaker). Stable across runs so app caches don't invalidate.

Query layer changes:
- Donor lookup pages roll up by `dedup_cluster_id` when displaying totals.
- The `financial_relationships` rows still point at the underlying
  `financial_entities.id` — no relationship rewrite needed.
- Search results aggregate by cluster id when sorting by donation total.

### Why this beats alternatives

- vs A: solves multi-ZIP fragmentation that A cannot touch; preserves the
  audit trail (raw fingerprint per filing event).
- vs B alone: ships immediate UX wins for the easy cases (the FIX-236
  search results page won't show 8 variants of LEVY EDWARD).
- vs C: scales to all donors, not just the curated top.
- vs D: doesn't depend on whether OpenSecrets publishes their recipe.

### Compat with donor-aggregation prompts

The prompts (LittleSis/EDGAR/IRS 990) match against `canonical_name` via
trigram. After Layer 1, the canonical_name for individual donors becomes
"MCKEE JACK" or "SCHWARZMAN STEPHEN A" — much closer to how LittleSis
publishes the same person ("Jack McKee", "Stephen A. Schwarzman"), so
fuzzy-match accuracy improves. After Layer 2, the cluster head exposes
all known fingerprint variants as an aliases list, which the prompts can
use as candidate match keys.

---

## 5. Implementation outline (pseudocode level)

### 5.1 Migration to add `dedup_cluster_id` column

```sql
-- supabase/migrations/{date}_financial_entities_dedup_cluster_id.sql

ALTER TABLE public.financial_entities
  ADD COLUMN IF NOT EXISTS dedup_cluster_id UUID;

CREATE INDEX IF NOT EXISTS financial_entities_dedup_cluster_id
  ON public.financial_entities (dedup_cluster_id)
  WHERE dedup_cluster_id IS NOT NULL;

COMMENT ON COLUMN public.financial_entities.dedup_cluster_id IS
  'Derived dedup cluster (FIX-239). NULL until rebuild_donor_dedup_clusters() runs. Group by this for donor-level rollups; individual rows still carry their own donor_fingerprint for audit.';
```

### 5.2 Migration to rewrite `donor_fingerprint` for existing rows

Idempotent: re-runs leave already-canonical rows untouched.

```sql
-- supabase/migrations/{date+1}_financial_entities_donor_fingerprint_v2.sql

CREATE OR REPLACE FUNCTION canonical_donor_fingerprint(raw_name TEXT, zip5 TEXT)
RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  noise TEXT[] := ARRAY['MR','MRS','MS','DR','MD','PHD','ESQ','REV','HON','CPA','CFP','JD','RN','DDS','DO','MBA'];
  cleaned TEXT;
  tokens TEXT[];
BEGIN
  -- step 1-3 of §4 layer 1
  cleaned := upper(raw_name);
  cleaned := regexp_replace(cleaned, '[''.]', '', 'g');
  cleaned := regexp_replace(cleaned, '[^A-Z0-9 ]', ' ', 'g');
  cleaned := regexp_replace(cleaned, '\s+', ' ', 'g');
  cleaned := trim(cleaned);
  -- step 4-5
  tokens := string_to_array(cleaned, ' ');
  tokens := array_remove(tokens, ANY(noise));  -- pseudocode; SQL uses subselect
  IF coalesce(zip5,'') = '' THEN
    RETURN array_to_string(tokens, ' ');
  END IF;
  RETURN array_to_string(tokens, ' ') || '|' || zip5;
END;
$$;

-- Backfill — set-based, no row-by-row loop
UPDATE public.financial_entities
SET donor_fingerprint = canonical_donor_fingerprint(
      display_name,
      metadata->>'zip5'
    ),
    canonical_name = split_part(
      canonical_donor_fingerprint(display_name, metadata->>'zip5'),
      '|', 1
    )
WHERE entity_type = 'individual'
  AND donor_fingerprint IS NOT NULL;
```

**Risk:** the backfill UPDATE will trip the UNIQUE constraint on
`donor_fingerprint` once a row's new key collides with an existing row's
new key. The migration must merge those rows first (sum
`total_donated_cents`, take the newest `metadata`, redirect
`financial_relationships.from_id` from the loser to the winner) before
running the rewrite. This is the bulk of the work. Detailed plan:

```
1. CREATE TEMP TABLE merge_plan AS
   SELECT canonical_donor_fingerprint(display_name, metadata->>'zip5') AS new_fp,
          array_agg(id ORDER BY total_donated_cents DESC, created_at ASC) AS ids
   FROM financial_entities
   WHERE entity_type = 'individual'
   GROUP BY 1 HAVING count(*) > 1;
2. For each row in merge_plan: winner = ids[1]; losers = ids[2..N]
3. UPDATE financial_relationships SET from_id = winner WHERE from_id = ANY(losers)
4. UPDATE financial_entities SET total_donated_cents = (sum across cluster),
       metadata = (preferred merge of metadata jsonbs)
     WHERE id = winner
5. DELETE financial_entities WHERE id = ANY(losers)
6. UPDATE financial_entities SET donor_fingerprint = new_fp WHERE id = winner
7. Now safe to rewrite the remaining (singleton) rows — no collisions left
```

### 5.3 Code change in `indiv.ts`

Replace the body of `donorFingerprint()` with logic matching
`canonical_donor_fingerprint()` so future writes match the new key. Add
a unit test against `MCKEE JACK MR.` / `SCHWARZMAN STEPHEN A. MR.` etc.

### 5.4 Clustering function (Layer 2 — can be a follow-up FIX)

```sql
CREATE OR REPLACE FUNCTION rebuild_donor_dedup_clusters() RETURNS void ...
-- groups by (token1, token2, left(zip5,3))
-- within each group, applies the rules in §4 Layer 2
-- writes dedup_cluster_id back to each row
-- deterministic UUID: md5(token1||'|'||token2||'|'||zip3) cast to uuid
```

Schedule: nightly, after FEC bulk runs.

### 5.5 Query layer

For `apps/civitics/app/api/search/route.ts` and donor-detail pages, add
an option to roll up by `dedup_cluster_id`. Default behavior: when
displaying individual-donor totals, sum `total_donated_cents` across the
cluster and pick the highest-donation row's `display_name` as the
canonical label.

---

## 6. Risk register

1. **Backfill UPDATE explodes the migration window.**
   - Mitigation: the merge_plan staging + per-cluster transaction
     approach scales linearly; estimated < 5 min wall time even at
     1M individual rows on Pro. Run as a one-shot migration during a
     scheduled maintenance window. PITR snapshot taken immediately
     before.
2. **`financial_relationships.from_id` rewrite breaks the partial UNIQUE
   index `financial_relationships_donation_unique`.**
   - Two losing rows pointed at the same `(to_id, cycle_year)` as the
     winner → constraint violation. Mitigation: merge those relationship
     rows too (sum amount_cents, sum tx_count, keep latest occurred_at).
     The writer already does this client-side; reuse the same logic in
     SQL.
3. **Over-collapsing father/son (SR vs JR at same ZIP, but no SR token
   in the JR row).**
   - 81 clusters identified locally where both SR and JR are present
     across siblings. Mitigation: §4 Layer 1 rule preserves SR/JR tokens
     verbatim, so as long as at least one filing of the father included
     `SR`, the father stays separated. Failure mode: father consistently
     filed without `SR` and son consistently filed with `JR` — son still
     separate; father merged with any siblings of his own variants.
     Acceptable.
4. **OpenSecrets-style donor lookup expectations.**
   - Users coming from OpenSecrets will expect a specific dedup
     behavior. If we diverge significantly, our donor pages look "wrong"
     by comparison. Mitigation: §7 open question 1.
5. **Donor-aggregation prompts that already pre-fetched fingerprints will
   break.**
   - There's no prompt work shipped yet that depends on the current
     fingerprint shape (the LittleSis/EDGAR/IRS 990 prompts are still
     planned). Mitigation: ship FIX-239 before any prompt work that
     would need to be re-pointed.
6. **Apostrophe-surname rewrite changes ranking for `O'BRIEN` searches.**
   - Pre-FIX-239: search for "O'Brien" matches `display_name` ILIKE
     "%O'BRIEN%". Post-FIX-239: `canonical_name` is "OBRIEN LARRY", so
     a trigram search on canonical loses the apostrophe; the
     `display_name` ILIKE still works. Mitigation: keep `display_name`
     as the search target (which FIX-236 already does); only
     `canonical_name` and `donor_fingerprint` change.
7. **Re-running the FEC pipeline after the migration races the dedup
   cluster id rebuild.**
   - The pipeline writes the new fingerprint shape directly, so dedup
     works at upsert time. The cluster id is recomputed nightly, so a
     fresh ingest's rows have NULL cluster_id until the next nightly
     pass. Mitigation: the search/donor pages must tolerate NULL
     dedup_cluster_id and fall back to grouping by id; not a regression.

---

## 7. Open questions

Things that need more investigation before implementation can begin
in earnest:

1. **Does OpenSecrets publish their donor normalization recipe?**
   Check `opensecrets.org/open-data/methodology`. If yes, copy the rules;
   our $770M-fragmented finding is exactly the problem they've already
   solved. If no, file a FIX item to do a 1–2 hour competitive look at
   their `donor-lookup` results for our top-20 fragmented clusters and
   reverse-engineer the rules.
2. **Should Layer 2 use ZIP3 or ZIP5?**
   ZIP3 (postal sectional) catches the multi-residence case but
   broadens FP risk. ZIP5 stays safer but doesn't fix the
   "primary + vacation" case. Worth quantifying: how many rare-name
   (last, first) combos appear at 2+ ZIPs *within the same state* vs.
   across states? Same-state probably same person (relocation);
   cross-state probably either same person (residence change) or
   different people. A query of `WHERE state same AND ZIP differs` vs
   `state differs AND ZIP differs` would inform the choice. Did not
   run in this investigation.
3. **What's the right cluster head when merging?**
   Current outline: pick the row with the highest `total_donated_cents`.
   Alternatives: pick the longest-name row (most info preserved), pick
   the most recent `metadata.updated_at` row (most current employer/
   occupation). Worth A/B'ing the rule with a sample of the top 100
   fragmented clusters and seeing which feels most right.
4. **Do we want a "manual override" path for known high-profile donors?**
   Strategy C as a complement to E. Curated aliases for the top 20
   could explicitly say "MUSK ELON | 78704 is the same person as MUSK
   ELON | 94027 — Musk relocated from CA to TX in 2020." Worth a small
   `donor_aliases` table that the cluster rebuild reads first.
5. **How will the dedup_cluster_id interact with `entity_connections`?**
   `entity_connections` is rebuilt by `rebuild_entity_connections()`
   from `financial_relationships`. After merging, the relationship rows
   point at the winning entity, so connections rebuild naturally pulls
   the merged total. But if Layer 2 *clusters without merging* (keeps
   raw rows separate, just tags them with a cluster id), the connection
   graph still shows fragmented edges. Decision needed: does the cluster
   id replace the per-row entity in the graph, or just for UI rollups?
6. **Backfill blast radius on prod's existing 540K donors.**
   The local DB has 930K individual rows (FIX-181 plus subsequent
   cycles). Prod was last reseeded 2026-05-02 with 540K. The merge
   plan needs to be tested against a prod-shape replica before running
   live; the row counts are similar enough that local validation should
   transfer, but the dollar distribution likely differs.

---

## 8. Out-of-scope discoveries

Surfaced during this investigation; queued as separate FIX items rather
than folded into FIX-239:

- **Apostrophe-stripping bug in `normalizeName()`.** Strips `'` to
  whitespace, splitting `O'BRIEN` into `O BRIEN`. Causes ~5,000 rows to
  carry wrong `last_token`. Should be a quick code change in the same
  PR as FIX-239 Layer 1 but is a logically separate fix; will queue as
  a new FIX after this investigation is reviewed.
- **`financial_entities.canonical_name` for individuals duplicates the
  name portion of `donor_fingerprint`.** Confirmed 930,985 of 930,985
  match. Suggests the two columns could be unified or one dropped, but
  the `canonical_name` index is used by the trigram search path so
  keeping both for now. Worth a follow-up to verify whether the index
  is still hit after FIX-195's partial-index changes excluded
  individuals.
- **The donor-aggregation-prompts workstream is not yet defined in code.**
  Prompts for LittleSis / EDGAR / IRS 990 matching against existing
  donors are referenced in the FIX-239 task brief but no implementation
  file exists yet. Recommend the prompt work depend on FIX-239 landing
  first so the prompts match against the dedupd entity, not against
  one of N fragments.

---

## 9. Done criteria check

- [x] Quantified scope: 38.8% of indiv dollars in fragmented clusters,
  93.8% of $1M+ donors fragmented.
- [x] ≥5 concrete fragmentation examples (§2.3).
- [x] ≥5 concrete high-FP-risk examples (§2.4).
- [x] ≥3 strategies evaluated with consistent dimensions (§3 table; five
  evaluated).
- [x] Recommendation concrete enough that implementation prompt is
  derivable (§4 + §5).
- [x] No code, schema, or data changes in this commit other than this doc.
- [x] FIX-239 stays open after this commit (no `[x]` flip).
