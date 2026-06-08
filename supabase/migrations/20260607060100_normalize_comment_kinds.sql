-- FIX-526 (C1 Wave A): kind/stance normalization data pass.
--
-- C0 left initiatives double-encoding "side" as BOTH a kind ('support'/'oppose')
-- AND a stance. Stance is the canonical axis; the double-encoding poisons Wave
-- B's bridge-scorer inputs (it would read a side off two columns that can
-- disagree). This pass collapses the kind onto stance:
--
--   kind IN ('support','oppose')  →  kind = 'discussion',
--   and stance := the old kind WHERE stance IS NULL
--   (rows that already carry a stance keep theirs — kind is just neutralized).
--
-- 'support'/'oppose' are simultaneously removed from every kinds vocab in
-- packages/db/src/comment-kinds.ts, so the API rejects them as kinds going
-- forward and initiative stance-grouped display derives side purely from stance.
--
-- Idempotent + replay-safe: after one run no row has kind IN ('support',
-- 'oppose'), so re-running matches zero rows; no-ops on an empty/clean DB.
UPDATE public.entity_comments
SET
  stance = COALESCE(stance, kind),
  kind   = 'discussion'
WHERE kind IN ('support', 'oppose');
