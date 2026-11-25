-- FIX-1442 — official_redirects rows for the three 2026-09-17 promotions (Harris, Menendez, Marshall), which predate FIX-1278's table and its backfill (cc-307 read 6, cc-315).
-- Run ONCE on prod; a row failing a guard (survivor missing, old id still a live official, survivor itself retired) is not inserted and is absent from RETURNING. Revert: DELETE FROM public.official_redirects WHERE reason = 'promotion:fix1187-set2-2026-09-17';
-- From the PRIMARY's packages/data: pnpm run session:wait-for-gate:prod --expected-minutes 1 --census stop --poll-seconds 60 --max-wait-minutes 8 --reason "FIX-1442 three official_redirects rows" --then "node ../../scripts/db-query.mjs --prod --call --yes-i-mean-prod --timeout 30s --file ../../scripts/fix1442-insert-promotion-redirects.sql"
INSERT INTO public.official_redirects (old_id, new_id, merged_at, reason)
SELECT v.old_id, v.new_id, v.merged_at, 'promotion:fix1187-set2-2026-09-17'
  FROM (VALUES
    ('afc05fd0-1d98-4de9-b9ac-f69fe0f1d773'::uuid, 'c0af0396-bf73-47e5-8e5d-291d3122ef68'::uuid, '2026-09-17T23:19:14Z'::timestamptz),  -- Mark Harris
    ('ac7de9f0-be89-4def-8143-3597908f9658'::uuid, '747c96d0-962a-4448-a405-e055dbce8f69'::uuid, '2026-09-17T23:19:32Z'::timestamptz),  -- Robert Menendez
    ('27090d3a-ed66-47de-8f45-24a262cf9e35'::uuid, '60f87348-1ffc-427f-b80c-5f416967cd41'::uuid, '2026-09-17T23:20:28Z'::timestamptz)   -- Roger Marshall
  ) AS v(old_id, new_id, merged_at)
 WHERE EXISTS (SELECT 1 FROM public.officials o WHERE o.id = v.new_id)
   AND NOT EXISTS (SELECT 1 FROM public.officials o WHERE o.id = v.old_id)
   AND NOT EXISTS (SELECT 1 FROM public.official_redirects r WHERE r.old_id = v.new_id)
ON CONFLICT (old_id) DO NOTHING
RETURNING old_id, new_id, merged_at, reason;
