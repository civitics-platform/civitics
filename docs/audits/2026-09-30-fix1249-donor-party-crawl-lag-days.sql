-- FIX-1249 — donor_party_crawl.full_rebuild_lag_days: 14 (default) → 30.
--
-- A ONE-ROW DATA WRITE, not a migration (cc-174 carries none by design: a
-- second migration file sorting above cc-173's would make `db push` skip one
-- silently). Applied from this committed file under `session:wait-for-gate`,
-- read back on prod, and recorded by an allow-empty `Verified: prod` commit.
--
-- WHY 30 (cc-167 §3.3, Craig's decision 5; read on prod 2026-09-30 ~02:22 UTC)
--
--   refresh_donor_party_rollup_incremental() (latest body
--   20260927020000_fix918_primary_industry_tag.sql:1304) reads this key on
--   every CALL:
--     v_full_lag := make_interval(days => GREATEST(
--                     COALESCE((v_cfg->>'full_rebuild_lag_days')::int, 14), 1));
--   and picks mode = 'full' when lag > v_full_lag, unless a live cursor younger
--   than c_cycle_max_age = 22 days (FIX-1216) resumes first. lag =
--   LEAST(max(fr.updated_at), fr_watermark_horizon()) − watermark.
--
--   A completed full cycle sets the watermark to the cycle TARGET — the last
--   FR write before firing 1. So a cycle that takes k weekly firings (jobid 17,
--   `0 15 * * 2`) completes ≈ 7(k−1) d + hours behind, and the NEXT firing
--   reads lag ≈ 7k d:
--     k = 1 → ~7 d    crawl
--     k = 2 → ~14 d   a coin flip against 14
--     k = 3 → ~21 d   > 14 → FULL again, indefinitely
--   With a 22-day cycle age the longest resumable cycle is 3 firings, so the
--   threshold must exceed ~21 d with slack → 30.
--
--   The crawl arm fits a 30-day lag: jobid 17 on 2026-09-29 ran crawl in
--   67.8 s — 747 dirty donors, 3 units, lag 6 d 22 h (8.6 d wall since the
--   09-21 watermark), `caught_up` — against max_units 40, the procedure's own
--   unit_budget_seconds 1500, and cron_job_budget 1,800 s. ~4× the lag is
--   ~12 units at that density: inside the cap and the budget.
--
--   Prod state at the read: NO donor_party_crawl row (absent = defaults,
--   20260902110000_fix1112…:118-124); watermark 2026-09-27 22:37:07; no cursor.
--   jobid 17 next reads this row Tue 2026-10-06 15:00 UTC.
--
-- A MERGE, never a wholesale write: the key's other fields (max_units,
-- unit_budget_seconds, slice_rows, chunk_ids) belong to other writers — the
-- paced runner merges `max_units` in the same way since FIX-1249.

INSERT INTO public.pipeline_state (key, value)
VALUES ('donor_party_crawl', '{"full_rebuild_lag_days": 30}'::jsonb)
ON CONFLICT (key) DO UPDATE
  SET value = public.pipeline_state.value || EXCLUDED.value,
      updated_at = clock_timestamp();

SELECT key, value, updated_at FROM public.pipeline_state WHERE key = 'donor_party_crawl';
