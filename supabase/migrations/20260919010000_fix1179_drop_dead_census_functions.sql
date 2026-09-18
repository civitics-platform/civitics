-- FIX-1179 (cc-133) — three census functions had no caller anywhere.
-- Drop two, keep and label the third.
--
-- ── THE CENSUS, ON PROD, READ 2026-09-18 04:47:48 UTC ──────────────────────
--
-- pg_stat_statements was reset by the 2026-09-15 15:09:48.238057+00 UTC
-- postmaster restart (cc-131 §7), so the window is
-- [2026-09-15 15:09:48 UTC, 2026-09-18 04:47:48 UTC] — about 61.6 hours. The
-- FIX-1179 bullet cited a zero-call census "since the 2026-09-08 15:12 UTC
-- baseline"; that window no longer exists and this is the re-read (D3).
--
--   calls in that window        0 · 0 · 0   (all three)
--   grants                      postgres:EXECUTE, service_role:EXECUTE  (all
--                               three — FIX-834/835 already revoked PUBLIC,
--                               anon and authenticated, so none is
--                               anon-reachable)
--   referenced in pg_policy     0 (qual and with_check both)
--   referenced in pg_views      0
--   referenced in a sibling     0
--     pg_proc.prosrc
--   pg_depend references        0
--   in a cron.job command       0
--   as a trigger function       0
--   callers in apps/ packages/  0 (grep; and `turbo run typecheck` passes with
--     scripts/                  the two dropped, which is the repo-side proof)
--
-- All three had their inert routine-level `statement_timeout` RESET by FIX-1128
-- (20260913000000). This migration REDEFINES nothing, so the FIX-1128 rule
-- about re-stating SET clauses on a CREATE OR REPLACE does not apply here.
--
-- ── PER FUNCTION (D2) ──────────────────────────────────────────────────────
--
-- get_group_donor_totals(uuid[])  DROP. SECURITY DEFINER, built for FIX-499
--   and superseded by the group-donor rollup: the route it existed for,
--   apps/civitics/app/api/graph/group/route.ts, reads the rollup instead.
--
-- rebuild_financial_entity_donation_totals_full()  DROP. A one-line
--   `PERFORM rebuild_financial_entity_donation_totals()` wrapper
--   (20260513010000:56) kept so one-shot backfills could use a distinct name.
--   Nothing ever did. NOT SECURITY DEFINER. The callee is NOT dropped.
--
-- has_active_official_grant(uuid,uuid)  KEEP, with a comment. It is the
--   answer-side gate mirroring has_active_constituent_grant, and the
--   constituent twin IS live (apps/civitics/app/api/comments/_lib.ts). The
--   official twin was built in 20260608030100_qa_lane.sql and never wired,
--   which makes it a half-built lane rather than a dead end — dropping it
--   would delete the mirror of a live gate and make the official-answer lane
--   re-derive it. A COMMENT recording that it is unwired is the cheaper
--   honesty, and the grant matrix already keeps it off the anon surface.
--
-- `IF EXISTS` on both drops so this is replay-safe on an empty DB.

DROP FUNCTION IF EXISTS public.get_group_donor_totals(uuid[]);

DROP FUNCTION IF EXISTS public.rebuild_financial_entity_donation_totals_full();

COMMENT ON FUNCTION public.has_active_official_grant(uuid, uuid) IS
  'FIX-1179 (cc-133): KEPT unwired — the answer-side gate mirroring '
  'has_active_constituent_grant, which IS live '
  '(apps/civitics/app/api/comments/_lib.ts). Zero callers as of 2026-09-18; '
  'service_role EXECUTE only. Wire it or drop it when the official-answer '
  'lane lands.';
