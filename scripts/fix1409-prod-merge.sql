-- FIX-1409 (cc-288) — the one prod merge of the vote edge rule: rebuild_entity_connections_votes_full(), one transaction, prints the merge NOTICE.
-- Runs ONCE, after 20261117000000 is on prod. Never re-run: a second call is a 0-write pass, and nothing here is a retry path.
-- Under: pnpm run session:wait-for-gate:prod … --then "node ../../scripts/db-query.mjs --prod --call --yes-i-mean-prod --timeout 7min --file ../../scripts/fix1409-prod-merge.sql" (from the primary's packages/data).
SELECT * FROM public.rebuild_entity_connections_votes_full();
