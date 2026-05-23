-- FIX-328 — per-section wall-clock timings captured by computeStatusPayload.
-- Null on rows written before this migration. Map: { section_name: ms }.
ALTER TABLE public.status_snapshot
  ADD COLUMN IF NOT EXISTS section_times JSONB;
