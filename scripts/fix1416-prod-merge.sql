-- FIX-1416 (cc-316) — the one prod merge after the 291 nomination rolls are re-pointed to their PN proposals: rebuild_entity_connections_votes_full(), one transaction, prints the merge NOTICE.
-- Runs ONCE, after fix1416-nomination-rolls.ts --allow-prod --apply has committed on prod. Never re-run: a second call is a 0-write pass, and nothing here is a retry path.
-- Under: pnpm run session:wait-for-gate:prod … --then "node ../../scripts/db-query.mjs --prod --call --yes-i-mean-prod --timeout 7min --file ../../scripts/fix1416-prod-merge.sql" (from the primary's packages/data).
SELECT * FROM public.rebuild_entity_connections_votes_full();
