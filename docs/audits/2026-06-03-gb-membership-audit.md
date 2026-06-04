# governing_body Membership-Pollution Audit — 2026-06-03

**Scope:** how `officials.governing_body_id` is used as a parking lot, and whether
the `tier` column (FIX-246/249) cleanly labels the pollution well enough to fix the
`/institutions/[id]` display surfaces consumer-side without a schema change.

**FIX:** FIX-470. **This is investigation-first / report-first.** Nothing was written
to either DB. Prod was queried **read-only** via a `pg.Client` with
`default_transaction_read_only = on` (the session aborts on any DML). Numbers below
are ground-truthed against the live local Docker DB and live prod
(`xsazcoxinpgttgquwvuf`) — not migration files, not the stale `.tmp-schema-compare/`.

**Method:** `packages/data/src/scripts/audit-gb-membership-pollution.ts`
(`pnpm --filter @civitics/data diag:gb-membership[:prod]`). Chamber mapping mirrors
`get_institution_recent_votes` v2 (FIX-439): `legislature_upper → 'Senate'`,
`legislature_lower → 'House'`.

---

## 1. Verdict

**The tier hypothesis is CONFIRMED on both local and prod.** The FEC candidate field
(`fec-bulk/candidates.ts`, FIX-246) parks every candidate on the body it runs for with
`tier='candidate'`. The `/institutions/[id]` roster / party-balance / member-count
queries filter on `is_active` only, never `tier`, so a US legislature page counts the
entire candidate field as "members". `tier='elected'` cleanly separates real members
from the candidate parking on the three polluted federal bodies:

| Body (prod) | `is_active` only (today) | `is_active AND tier='elected'` (fix) |
|---|---|---|
| United States House of Representatives | **8,880** | **436** |
| United States Senate | **1,921** | **100** |
| Office of the President | **2,612** | **2** |

→ **No schema change needed for the federal display bug.** The fix is the shared
current-member predicate (`is_active AND tier='elected'`) applied to the institutions
page loaders. Two findings narrow the blast radius and spawn one follow-up (§5):

- **Cross-chamber misassignment among elected officials = 0** on both envs. Tier IS a
  clean chamber signal; no reassignment FIX is warranted (this *refutes* a fear carried
  over from the FIX-439 RPC header, which was describing candidate-tier mis-linking).
- **Legistar municipal councils are all `tier='elected'`** (default), so tier scoping
  does NOT shrink them to plausible council sizes — a separate ingest-side problem
  (§5, follow-up FIX).

---

## 2. Tier coverage (predicate safety)

`tier` is `NOT NULL` with a column default of `'elected'`. Confirmed **0 NULL tiers**
on both envs, so the predicate's implicit "NULL is not a member" decision hides nothing.

| tier | local | prod |
|---|---|---|
| elected | 16,216 | 13,917 |
| candidate | 9,275 | 12,875 |
| former | 1,645 | 1,799 |
| **NULL** | **0** | **0** |

Predicate decision: **`is_active = true AND tier = 'elected'`**; NULL excluded. Safe
because no NULL-tier rows exist (and none are attached to a gb). No tier-NULL backfill
FIX needed.

---

## 3. Per-gb composition — top bodies by attached officials (prod)

"active" = current display result (`is_active` only). "active elected" = post-fix
predicate result.

| gb | type | attached | active | **active elected** | active candidate |
|---|---|---|---|---|---|
| United States House of Representatives | legislature_lower | 8,882 | 8,880 | **436** | 8,444 |
| Office of the President of the United States | executive | 2,612 | 2,612 | **2** | 2,610 |
| United States Senate | legislature_upper | 1,921 | 1,921 | **100** | 1,821 |
| City Council | municipal_council | 605 | 232 | 232 | 0 |
| City Council Addendum Agenda | municipal_council | 605 | 472 | 472 | 0 |
| Board of Supervisors | other | 409 | 397 | 397 | 0 |
| New Hampshire State House | legislature_lower | 390 | 390 | 390 | 0 |
| Pennsylvania State House | legislature_lower | 201 | 201 | 201 | 0 |
| (state houses continue — all candidate-free, all tier='elected') | | | | | |

Local mirrors prod (House 6,046 attached / 436 elected; Senate 1,431 / 100; OPOTUS
2,341 / 2). The candidate pollution lives **only** on the three federal bodies the FEC
pipeline targets (House/Senate/President). State legislatures (OpenStates) carry zero
candidates — they are already correct under either query, and the predicate is a no-op
for them.

Post-fix roster shape (active-elected role_titles, prod):
- US House → `Representative (436)`
- US Senate → `Senator (100)`
- Office of the President → `Vice President (1)`, `President (1)`

---

## 4. Cross-chamber misassignment (prod)

For every `tier='elected'` active official on a legislature gb, compare their most-recent
(180-day) `votes.chamber` against the gb's mapped chamber.

| gb chamber (expected) | elected-active (all upper/lower bodies) | with recent vote | most-recent vote in WRONG chamber |
|---|---|---|---|
| House | 5,876 | 436 | **0** |
| Senate | 2,110 | 99 | **0** |

**0 mismatches.** Only US Congress members have roll-call vote data (state legislators
have none, hence "with recent vote" ≈ 436/99). Among those, every elected official's
recent votes are in their gb's chamber. The mis-linking the FIX-439 v2 RPC header warned
about was **candidate-tier** pollution (now excluded by the predicate), not misfiled
elected members. **No cross-chamber reassignment FIX is warranted.**

---

## 5. Legistar / municipal-council person flood (prod)

| gb | type | attached | active | active elected | active candidate |
|---|---|---|---|---|---|
| City Council | municipal_council | 605 | 232 | **232** | 0 |
| City Council Addendum Agenda | municipal_council | 605 | 472 | **472** | 0 |
| Board of Supervisors | other | 409 | 397 | **397** | 0 |

Active-official role_titles on "City Council": `elected | Council Member | 232`.

These bodies carry **zero candidates** — every attached official is `tier='elected'`
(the column default; Legistar's writer never sets `tier`). So **tier scoping does NOT
fix municipal rosters**: a single generic "City Council" body aggregates ~232 elected
council members (and "City Council Addendum Agenda" — which should not be a governing
body at all — another 472). Plausible single-council size is ~9–11. This is a distinct
ingest-side problem: Legistar collapses many cities' councils (and/or never deactivates
former members) onto generic shared bodies. → **Follow-up FIX-471** (does not block this
PR; the institutions pages affected are the federal legislatures, which the predicate
fixes). The "Addendum Agenda shouldn't be a body" normalization is already queued
separately from the 2026-06-03 brainstorm — not re-filed here.

---

## 6. Writer enumeration — who assigns `officials.governing_body_id` and what `tier`

`officials.tier` defaults to `'elected'` (`NOT NULL`). Only the FEC pipeline sets it to
anything else, which is exactly why the predicate isolates the candidate pollution and
nothing else.

| Pipeline file | gb assigned | tier set | classification |
|---|---|---|---|
| `congress/officials.ts` | US House / US Senate | `'elected'` (explicit, FIX-409) | membership |
| `congress/bills.ts` | bill's chamber gb on **proposals** | n/a | proposal scoping — NOT an officials writer |
| `congress/votes.ts` | reads senate gb (`.eq`) | n/a | read-only |
| `courtlistener/writer.ts` | federal court gb | default `'elected'` | membership (judges) |
| `elections/index.ts` | reads gb for reconciliation | n/a | read-only re: assignment |
| `executive/seed.ts` | Office of the President | `'elected'` (explicit) | membership (President/VP) |
| `fec-bulk/candidates.ts` | body the candidate runs for | **`'candidate'` (explicit)** | **parking — the pollution source** |
| `legistar/index.ts` + `mappers.ts` | primary council body | default `'elected'` | membership-intent, floods (§5) |
| `openstates/writer.ts` | state legislature chamber | default `'elected'` | membership |

**Takeaway:** `fec-bulk/candidates.ts` is the only writer that parks rows under a
non-membership tier, and it does so correctly (candidate-for-a-body, labeled as such).
The bug is entirely consumer-side. Ingest stays untouched (per FIX-470 design decision 3).

---

## 7. Fix shipped in this PR

Shared predicate `currentGoverningBodyMembers()` + `CURRENT_MEMBER_TIER` in
`packages/db/src/queries/governing-bodies.ts`, applied to the three GoverningBodyView
loaders in `apps/civitics/app/institutions/[id]/page.tsx` (roster, party balance,
member-count stat). FIX-468 graph group-expansion will consume the same predicate
instead of re-hardcoding `.eq('tier','elected')`.

**Expected post-fix display (prod):** US Senate "Active members" → 100; US House → 436;
Office of the President → 2.
