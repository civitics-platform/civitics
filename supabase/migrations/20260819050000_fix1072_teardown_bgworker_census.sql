-- =============================================================================
-- FIX-1072 — tear down the bgworker census, and record what it measured.
--
-- FIX-1058 shipped this sampler on 2026-08-18 with an explicit contract: "NEXT
-- READ: Wednesday 2026-08-19 08:00 UTC and its tail, then Thursday read the
-- census to answer WHICH backends hold the slots. TEARDOWN, one line, do not
-- leave this armed." The read happened 2026-08-20 01:5x UTC. This is the
-- teardown, and the header is the record — the table is dropped below, so the
-- findings have to outlive it here.
--
-- ── COVERAGE ────────────────────────────────────────────────────────────────
-- 13,963 row-groups across 1,182 distinct samples, 08-18 01:12 -> 08-20 01:10
-- UTC. The sampler no-opped on schedule at its 48h expiry, as designed.
--
-- ── THE ANSWER IS: NOBODY WAS HOLDING THE SLOTS ─────────────────────────────
-- Through the 08-19 saturation, non-client backends peaked at EIGHT against
-- max_worker_processes = 12, and every backend_type present was a singleton
-- (max_concurrent = 1 for all nine): archiver, autovacuum launcher, background
-- writer, checkpointer, logical replication launcher, pg_cron launcher, pg_net
-- worker, walwriter, and an occasional autovacuum worker. There was no pool of
-- workers competing for slots at any sampled moment. Client backends peaked at
-- 25 against max_connections = 60, so connections were not exhausted either.
--
-- ── AND THE HYPOTHESIS WAS STRUCTURALLY UNAVAILABLE ANYWAY ──────────────────
-- cron.use_background_workers is OFF on this cluster. With that setting pg_cron
-- does not request a background worker per job at all — it opens a libpq CLIENT
-- CONNECTION and sends the command as a single simple query. (That is the same
-- fact FIX-1063 depends on for its invalid-transaction-termination finding, and
-- it was already written down in that migration's header.) So FIX-1058's
-- central arithmetic — "pg_cron may request 32 concurrent job workers from a
-- 12-slot pool" — describes a request pg_cron never makes. cron.max_running_jobs
-- = 32 bounds concurrent libpq CONNECTIONS, and 32 against max_connections = 60
-- is not over-subscribed.
--
-- Which relocates "job startup timeout": it is a failure to ESTABLISH A
-- CONNECTION inside pg_cron's task-start window, not a failure to acquire a
-- worker slot. The bottleneck is the postmaster's ability to fork and complete a
-- handshake. FIX-1058's own log evidence already showed this and read it as
-- corroboration for the wrong mechanism — "could not accept SSL connection: EOF
-- detected" and "Connection reset by peer" are clients dying IN the handshake,
-- which is the signature of a postmaster that cannot accept, not of a full
-- worker pool.
--
-- ── THE CENSUS CORROBORATED A BOX-WIDE STALL BY ITS OWN ABSENCE ─────────────
-- Which is exactly what it was built to do — FIX-1058 put it on the same 2-min
-- cadence as the watchdog "so a MISSING sample is itself data". Samples landed
-- per 30-min bucket on 08-19 (15 expected each):
--
--     07:00  15    09:00   8    11:00   9    13:00   1
--     07:30  15    09:30   4    11:30   2    14:00   1
--     08:00  15    10:00  10    12:00   —    14:30   1
--     08:30  15    10:30   8    12:30   —
--
-- Zero samples in BOTH the 12:00 and 12:30 buckets — precisely the window in
-- which 91 of 91 cron firings died. The sampler could not get a connection
-- either.
--
-- ── WHAT IS *NOT* ESTABLISHED HERE ──────────────────────────────────────────
-- The census proves the NEGATIVES (not worker slots, not connection count) and
-- the box-wide stall. It does NOT identify which resource saturated. The
-- I/O-starvation reading — roughly 265 GB of physical reads against a 256 MB
-- shared_buffers (confirmed here as shared_buffers = 32768 8kB pages) — comes
-- from the 08-19 triage's own measurement, not from this table. Do not record
-- I/O starvation as census-proven; record it as consistent with the census and
-- measured elsewhere.
--
-- Cross-ref FIX-1058 (the hypothesis this refutes), FIX-1063 (the setting that
-- makes it structurally unavailable), FIX-1052, FIX-1022, FIX-1069, FIX-1071.
-- =============================================================================

-- Unschedule first, so no firing can land between the drops below.
SELECT cron.unschedule('bgworker-census')
  FROM cron.job WHERE jobname = 'bgworker-census';

DROP FUNCTION IF EXISTS public.sample_bgworker_census();

DROP TABLE IF EXISTS public.bgworker_census;

DELETE FROM public.pipeline_state WHERE key = 'bgworker_census';
