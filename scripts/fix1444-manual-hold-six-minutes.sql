-- =============================================================================
-- FIX-1444 (cc-303) D8 — the model MANUAL HOLD: six minutes, self-expiring.
--
-- dispatch_one_unit (from 20261126002000) honours pipeline_state
-- dispatcher_hold.manual_until like any other hold: while it is in the future,
-- each tick with a clear box reads `skipped` / `hold: manual until <instant>
-- (<manual_set_by>)` and arms nothing. The reaps still run under it (pause, by
-- contrast, stops the tick before the reap). When it passes, the next clear tick
-- starts a ramp to manual_until + ramp_minutes: one unit at a time.
--
-- This is an UPSERT that merges manual_until and manual_set_by into the key and
-- touches no other field (D6): a landing or stall hold already standing keeps
-- its own fields, and the later of the holds is the one in force.
--
-- For a different length, edit the interval. To CLEAR a manual hold, run the
-- same statement with manual_until = now() (it then ramps like any expiry).
--
-- Run (cc-303 Item 4), from the primary's packages/data, through the gate:
--   pnpm run session:wait-for-gate:prod --expected-minutes 1 --census stop \
--     --poll-seconds 60 --max-wait-minutes 8 --reason "cc-303 six-minute manual hold exercise" \
--     --then "node ../../scripts/db-query.mjs --prod --call --yes-i-mean-prod --timeout 30s \
--             --file ../../scripts/fix1444-manual-hold-six-minutes.sql"
-- =============================================================================

INSERT INTO public.pipeline_state AS ps (key, value, updated_at)
VALUES ('dispatcher_hold',
        jsonb_build_object('manual_until', now() + interval '6 minutes',
                           'manual_set_by', 'cc-303: the six-minute manual hold exercise (by hand, scripts/fix1444-manual-hold-six-minutes.sql)'),
        now())
ON CONFLICT (key) DO UPDATE SET value = ps.value || EXCLUDED.value, updated_at = now()
RETURNING key, value, updated_at;
