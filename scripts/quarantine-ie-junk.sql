-- FIX-A — Quarantine corrupt Schedule E (independent-expenditure) rows.
--
-- ROOT CAUSE (see commit + done.log): FEC's public Schedule E corpus carries
-- vexatious / fake filings — fake committees ("THE COURT OF DIVINE JUSTICE",
-- "THE COMMITTEE OF 300") and a serial prankster filing $1B–$9.98B "IEs" under
-- names like "Bettis, Shawn" / "Warren Buffet Apple Inc". These are genuine
-- source rows (CSV columns align cleanly — NOT a parse bug), so they land in
-- financial_relationships as ie_support / ie_oppose and pollute total_ie_*_cents,
-- search (gated on IE > 0), and IE leaderboards/treemaps.
--
-- BOUND = $1,000,000,000 (100,000,000,000 cents). Chosen from the aggregate
-- distribution: the four rows above $1B are confirmed-fake committees, and a
-- clean ~2x gap separates them from the largest *legitimate* aggregate
-- (FF PAC, ~$499M). Crucially every aggregate above the bound contains at least
-- one single transaction above the FIX-A ingest bound ($50M/row), so once that
-- guard ships the nightly IE run will NOT recreate these rows.
--
-- Real super PACs (FF PAC, Make America Great Again Inc., Senate Leadership
-- Fund, Preserve America PAC) sit below the bound and are intentionally kept —
-- their largest single disbursements are ≤ $30M, well within the ingest guard.
--
-- Usage: run the PREVIEW first against local AND prod, eyeball the rows, then
-- run the DELETE. Prod DELETE requires explicit confirmation (CLAUDE.md).
-- After the DELETE, recompute totals: pnpm data:rebuild:ie-totals.

\set bound_cents 100000000000

-- ── PREVIEW ────────────────────────────────────────────────────────────────
SELECT fr.id,
       fe.display_name,
       fr.relationship_type,
       fr.cycle_year,
       fr.amount_cents / 100.0           AS usd,
       fr.metadata->>'tx_count'          AS tx_count,
       fr.metadata->>'fec_committee_id'  AS spe_id
FROM   financial_relationships fr
JOIN   financial_entities      fe ON fe.id = fr.from_id
WHERE  fr.relationship_type IN ('ie_support', 'ie_oppose')
  AND  fr.amount_cents > :bound_cents
ORDER  BY fr.amount_cents DESC;

-- ── DELETE (uncomment to execute) ───────────────────────────────────────────
-- DELETE FROM financial_relationships
-- WHERE  relationship_type IN ('ie_support', 'ie_oppose')
--   AND  amount_cents > 100000000000;
