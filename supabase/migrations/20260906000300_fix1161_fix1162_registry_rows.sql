-- FIX-1161 + FIX-1162 — two declaration rows. Data-only, idempotent, no DDL.
--
-- ============================================================================
-- FIX-1161 — entity_connection_stats_rebuild: an orphaned watch, declared.
-- ============================================================================
-- FIX-1115/FIX-1117 moved the entity-connection stats work into the bounded
-- ec-crawl arm (jobid 45, */15). Its own job -- jobid 16,
-- `entity-connection-stats-rebuild`, 0 16 * * 1,3 -- was deactivated then and
-- has been active='f' since; its last data_sync_log row is 2026-08-26 16:00 UTC
-- and there are only 12 rows in total.
--
-- What was NOT done at the time is the half FIX-1059 made mandatory: the
-- CONVENTION recorded in packages/db/CLAUDE.md and in
-- 20260903000000_fix1135_1059_1011_rollup_watch_registry.sql is that any
-- cron.unschedule or alter_job deactivation of a job whose procedure writes
-- data_sync_log lands a rollup_watch_overrides row in the SAME migration. This
-- one did not, which is exactly why FIX-1135's own header could name the
-- measured orphan set as "exactly {entity_connection_stats_rebuild}". The
-- canary has listed it every run since, report-only, and a report-only finding
-- that is expected forever is noise that trains people to skip the section.
--
-- This is the declaration, arriving late. The job STAYS PAUSED: resuming jobid
-- 16 would double-write work the ec-crawl arm already owns. Retired, not held
-- -- held is for work we intend to resume.
INSERT INTO public.rollup_watch_overrides (pipeline, retired_at, note)
VALUES (
  'entity_connection_stats_rebuild',
  TIMESTAMPTZ '2026-08-26 16:00:00+00',
  'FIX-1161. Retired: the entity-connection stats rebuild moved into the bounded '
  'ec-crawl arm (jobid 45, */15) by FIX-1115/FIX-1117, and its own job -- jobid 16, '
  'entity-connection-stats-rebuild, 0 16 * * 1,3 -- was deactivated at that point '
  'and is active=f today. retired_at is its LAST OBSERVED RUN (2026-08-26 16:00 UTC, '
  'the newest of only 12 data_sync_log rows), not the deactivation instant, which '
  'was never recorded. Declared here because FIX-1115/1117 skipped the '
  'same-migration override row the FIX-1059 convention requires, leaving this the '
  'sole standing entry in the canary orphans[] array. DO NOT RESUME jobid 16: the '
  'ec-crawl arm owns this work now and a second writer would duplicate it. '
  'Cross-ref FIX-1059, FIX-1135, FIX-1115, FIX-1117.'
)
ON CONFLICT (pipeline) DO UPDATE
  SET retired_at = EXCLUDED.retired_at,
      note       = EXCLUDED.note,
      updated_at = now();

-- ============================================================================
-- FIX-1162 — isr_writes gets a platform_limits row.
-- ============================================================================
-- FIX-1160 (2026-09-05) gave Vercel's "ISR Writes" charge line its own
-- platform_usage metric, `isr_writes`, instead of folding a paid write line
-- into the read series. It named its own follow-up: the metric persists a value
-- but has no platform_limits row, so the Platform Costs card has nowhere to put
-- it and a live ~$3.29/mo line stays invisible. This is that row.
--
-- included_limit = -1 is DELIBERATE and is this table's existing encoding for
-- "context only, no threshold, no alerting" -- see the two
-- cloudflare/edge_requests_hourly rows (FIX-1044), which use it for the same
-- reason. It is used here because ISR Writes on Pro is credit-based rather than
-- a fixed allotment, and because this session could not verify Vercel's
-- published Pro/Hobby ISR-Writes denominator from a first-party source. The
-- sibling isr_reads rows carry 1,000,000 as an explicit Hobby REFERENCE, not a
-- Pro entitlement; copying that shape here without a sourced number would have
-- asserted a quota nobody checked, and the observed ~1.1M writes/mo would then
-- render as a fabricated >100% bar. -1 makes the metric appear on the card with
-- its true quantity and cost and no invented ceiling.
--
-- FOLLOW-UP: replace -1 with the sourced Hobby reference once someone reads it
-- off Vercel's pricing page, and then the warning/critical bands become live.
INSERT INTO public.platform_limits
  (service, metric, plan, included_limit, unit, display_label, display_group,
   warning_pct, critical_pct, billing_cycle, sort_order, is_active,
   has_public_api, is_displayed, notes)
VALUES (
  'vercel', 'isr_writes', 'pro', -1, 'writes', 'ISR Writes', 'Edge Cache',
  80, 100, 'monthly_reset', 9, true, true, true,
  'FIX-1162. The platform_limits row FIX-1160 identified as missing: ISR Writes is '
  'a live paid line on this account (~$3.29/mo, ~1.1M writes on the observed charge '
  'lines) whose platform_usage series exists but had no limit row, so the Platform '
  'Costs card rendered no entry for it. included_limit -1 = context only, no '
  'threshold and no alerting, the same encoding the FIX-1044 edge_requests_hourly '
  'rows use: ISR Writes on Pro is credit-based, and no first-party Pro/Hobby '
  'denominator was verified when this row was written, so no quota is asserted. The '
  'series itself STARTS AT THE FIX-1160 DEPLOY (2026-09-05) -- earlier absence is '
  'not evidence of zero ISR write traffic. Replace -1 with the sourced Hobby '
  'reference to make the bands live. Cross-ref FIX-1160, FIX-1041, FIX-1044.'
)
ON CONFLICT (service, metric, plan) DO UPDATE
  SET included_limit = EXCLUDED.included_limit,
      unit           = EXCLUDED.unit,
      display_label  = EXCLUDED.display_label,
      display_group  = EXCLUDED.display_group,
      sort_order     = EXCLUDED.sort_order,
      is_displayed   = EXCLUDED.is_displayed,
      notes          = EXCLUDED.notes,
      updated_at     = now();
