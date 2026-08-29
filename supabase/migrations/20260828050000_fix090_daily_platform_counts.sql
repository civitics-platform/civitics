-- 20260828050000_fix090_daily_platform_counts.sql
-- FIX-090 — one row per day of the four Transparency stat-card headline numbers,
-- so /dashboard can draw a 30-day sparkline under each card.
--
-- WHY A NEW TABLE AND NOT status_snapshot:
-- status_snapshot is INSERT-per-tick with a 24-HOUR retention window
-- (prune_status_snapshot, migration 20260518000002). It holds hours, never days.
-- Measured on prod 2026-08-29: 5 rows spanning 1 day 12:12. Nothing else in the
-- schema records daily entity counts either — platform_usage_snapshot (31 days)
-- carries vendor/infra metrics only, and data_sync_log records per-run pipeline
-- deltas, not table totals. So a daily series has to be recorded, not sampled.
--
-- SHAPE: day-keyed, one row per calendar day, upserted from the SAME payload the
-- 10-min platform-snapshot cron already computes (writeStatusSnapshot). The
-- recorder issues no queries of its own — it persists numbers already in hand,
-- so the daily series costs nothing beyond one upsert per tick.
--
-- RETENTION: deliberately none. One row of five integers per day is ~365 rows a
-- year; a prune function here would be more machinery than the thing it prunes.
-- The read path bounds itself with LIMIT/`day >=` instead.

-- ── 1. daily_platform_counts ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.daily_platform_counts (
  day                DATE PRIMARY KEY,
  -- Every metric is NULLABLE and that is load-bearing, not laziness: the
  -- reconstructed backfill below can honestly recover `officials` and `votes`
  -- but NOT `open_proposals` or `donation_flow_usd` (see section 2). A NULL
  -- means "not measured on this day", which the read path skips — as opposed to
  -- a 0, which would assert the platform tracked nothing.
  officials          INTEGER,
  open_proposals     INTEGER,
  votes              INTEGER,
  donation_flow_usd  BIGINT,
  -- 'observed'      — recorded live from that day's status payload.
  -- 'reconstructed' — derived from created_at at backfill time (section 2).
  source             TEXT NOT NULL DEFAULT 'observed'
                     CHECK (source IN ('observed', 'reconstructed')),
  recorded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE public.daily_platform_counts IS
  'FIX-090 — daily snapshot of the four /dashboard Transparency stat-card headline '
  'numbers. Written by writeStatusSnapshot from the already-computed status payload. '
  'NULL metric = not measured that day (never conflate with 0).';

-- Admin-only read, mirroring status_snapshot: /dashboard reads this server-side
-- through createAdminClient (bypasses RLS), so no client policy is needed and a
-- deny-all default keeps it off the public PostgREST surface.
ALTER TABLE public.daily_platform_counts ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename  = 'daily_platform_counts'
      AND policyname = 'no public read daily_platform_counts'
  ) THEN
    CREATE POLICY "no public read daily_platform_counts" ON public.daily_platform_counts
      FOR SELECT USING (false);
  END IF;
END$$;

-- ── 2. Reconstructed backfill — officials + votes ONLY ────────────────────────
--
-- The series must not fabricate. Two of the four metrics can be recovered
-- truthfully from current table state and two cannot, so only two are backfilled.
--
-- RECOVERABLE (`created_at`-cumulative: "records on file today, by the day each
-- was created"). At day = today this equals the exact count the card renders, so
-- the series terminates on the headline number by construction.
--
--   VALIDATED, not assumed. The FIX-940 closeout (commit 3a7fef1c, 2026-07-31)
--   independently recorded "968,402 votes total conserved" on prod that day; this
--   reconstruction returns exactly 968,402 for 2026-07-31. Its daily deltas also
--   reproduce data_sync_log's congress_votes rows_inserted day for day
--   (07-31: +300, 08-09: +400, …). Two independent receipts, both matched.
--
--   THE ESTIMATED->EXACT CLIFF DOES NOT APPEAR HERE, AND THAT IS CORRECT.
--   Before FIX-1095 the Votes card read a pg_class.reltuples estimate of
--   1,270,118 against a true 969,302 — a displayed -31% "drop" on 2026-08-22.
--   That was a MEASUREMENT artifact: votes had autovacuum_count = 0 (never
--   vacuumed in its life until FIX-943 on 08-01), so reltuples was a stale
--   statistic predating the window entirely. The underlying table only ever grew,
--   by +1,600 rows (+0.17%) across these 30 days. Reconstructing from actual rows
--   therefore reproduces the truth and is structurally incapable of reproducing
--   the artifact — it is not smoothing a correction, it is declining to repeat a
--   bad reading.
--
-- NOT RECOVERABLE (left NULL; these accrue forward from the first cron tick):
--
--   open_proposals — the card counts status = 'open_comment' AND a future
--     comment_period_end. `status` records CURRENT state, so any proposal whose
--     period has since closed is invisible on the day it was open. Measured on
--     prod: the reconstruction climbs 111 -> 251 over 30 days, a pure
--     survivorship artifact that would render a fake +126% trend. Rejected.
--
--   donation_flow_usd — the chord total (chord_industry_flows_mv), a 4.4M-row
--     join across financial_relationships x officials x financial_entities x
--     entity_tags. Re-aggregating it once per day is neither cheap nor
--     semantically clean, and per the no-heavy-prod-ops rule it is not worth a
--     30x replay to garnish one card. Rejected on cost, recorded forward instead.

INSERT INTO public.daily_platform_counts (day, officials, votes, source)
WITH days AS (
  SELECT generate_series(CURRENT_DATE - 29, CURRENT_DATE, INTERVAL '1 day')::date AS day
),
-- Rows created inside the window, bucketed by creation day.
o_daily AS (
  SELECT created_at::date AS d, COUNT(*)::bigint AS n
  FROM public.officials
  WHERE created_at >= CURRENT_DATE - 29
  GROUP BY 1
),
v_daily AS (
  SELECT created_at::date AS d, COUNT(*)::bigint AS n
  FROM public.votes
  WHERE created_at >= CURRENT_DATE - 29
  GROUP BY 1
),
-- Everything older than the window is the running total's starting point. A NULL
-- created_at counts as "ancient" rather than vanishing from both halves.
o_base AS (
  SELECT COUNT(*)::bigint AS n FROM public.officials
  WHERE created_at < CURRENT_DATE - 29 OR created_at IS NULL
),
v_base AS (
  SELECT COUNT(*)::bigint AS n FROM public.votes
  WHERE created_at < CURRENT_DATE - 29 OR created_at IS NULL
)
SELECT
  d.day,
  ((SELECT n FROM o_base) + COALESCE(SUM(od.n) OVER (ORDER BY d.day), 0))::int,
  ((SELECT n FROM v_base) + COALESCE(SUM(vd.n) OVER (ORDER BY d.day), 0))::int,
  'reconstructed'
FROM days d
LEFT JOIN o_daily od ON od.d = d.day
LEFT JOIN v_daily vd ON vd.d = d.day
-- Never clobber a row the live recorder already wrote — 'observed' always wins
-- over 'reconstructed', including on re-apply.
ON CONFLICT (day) DO NOTHING;
