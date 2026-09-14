-- FIX-1184 — supersession for orphaned fec_emit_runs rows.
--
-- THE LEAK. The pas2 arm opens a run row per (cycle, source) on EVERY fec phase
-- — it sits ahead of the FIX-193 indiv watermark short-circuit and has no gate
-- of its own — while `stampEmitRunsComplete` only ever stamps the sinks whose
-- cycleYear equals the ONE cycle FIX-754's clear names. So every cycle the pac
-- arm touches that is not that cycle leaves a row with complete_at NULL, one per
-- nightly, forever. Measured on prod 2026-09-14: three such rows
-- (96260b92/2024, 5697a031/2026, b09496d6/2024), and each of them holds a FULL
-- key set — 135,192 / 111,729 / 135,192 keys respectively. The `keys` column
-- reads 0 only because it is written at the stamp.
--
-- WHY IT MATTERS. Guard 1 of audit-fec-emit-residue.ts takes the NEWEST run for
-- a slice by started_at and refuses when its complete_at is NULL. Newest rather
-- than newest-complete is deliberate and stays: an older set's absences are last
-- week's answer, and acting on them would delete rows this week's run
-- legitimately re-emitted. But an orphan that is newest makes the whole slice
-- unauditable — (2024, fec_bulk_pac) is unauditable today, and (2026,
-- fec_bulk_pac) was on 2026-09-13, because on a caught-up weekday run with no
-- new FEC drop NEITHER cycle's indiv completes and BOTH pac rows orphan.
--
-- THE FIX, in two nullable columns. At the next begin() for a slice, any older
-- incomplete row for that same (cycle_year, source) is stamped superseded_at /
-- superseded_by, has its true key count written into `keys`, and has its
-- fec_emit_keys rows deleted. Guard 1 then walks the slice newest-first:
--
--   complete_at set                  -> use it
--   superseded_at set AND keys = 0   -> skip to the next row
--   superseded_at set AND keys > 0   -> REFUSE, naming the run and its count
--   neither set                      -> REFUSE as today (in flight, or killed
--                                       and not yet superseded by a later begin)
--
-- The `keys > 0` refusal is the same reason the guard was "newest, not
-- newest-complete": a prefix WAS written after the last complete set, so the
-- older set's absences would delete rows that prefix emitted.
--
-- A resumed run is untouched — supersession keys on run_id <> the new run, and a
-- resume computes the SAME deterministic id from (cycle, FEC Last-Modified).
--
-- Nullable, no default, no backfill: the three rows already on prod are
-- superseded by the first nightly that opens their slice again, which is the
-- receipt this FIX closes on.

ALTER TABLE public.fec_emit_runs
  ADD COLUMN IF NOT EXISTS superseded_at timestamptz,
  ADD COLUMN IF NOT EXISTS superseded_by uuid;

COMMENT ON COLUMN public.fec_emit_runs.superseded_at IS
  'FIX-1184: set when a later begin() for the same (cycle_year, source) replaced '
  'this never-completed run. Its fec_emit_keys rows are deleted at the same '
  'moment and their count is written to keys, so keys > 0 on a superseded row '
  'means "a prefix WAS emitted" and Guard 1 must refuse rather than skip.';

COMMENT ON COLUMN public.fec_emit_runs.superseded_by IS
  'FIX-1184: the run_id whose begin() superseded this row. NULL unless '
  'superseded_at is set.';
