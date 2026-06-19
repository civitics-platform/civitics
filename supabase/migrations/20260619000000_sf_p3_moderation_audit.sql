-- FIX-601 / SF-P3 — shadow moderation harness ledger.
--
-- Append-only audit table written by the read-only `data:moderation-harness`
-- pass (packages/data/src/pipelines/moderation-harness). The harness instantiates
-- each casebook fixture (state-of-franklin-bible §11.1, F1–F12) inside a
-- transaction, computes what the LIVE deterministic moderation rules would do,
-- compares to the fixture's expected verdict, ROLLS THE FIXTURE CONTENT BACK, and
-- writes ONE row here (this table is the only thing that persists across the
-- rollback). The harness confers ZERO consequence — no flag, score, hide, or
-- queue write. Read + rollback + log.
--
-- Modeled on investigation_edge_audit (20260614010000): BIGSERIAL, append-only,
-- service_role-only, never UPDATE/DELETE.

CREATE TABLE IF NOT EXISTS public.moderation_audit (
  id               BIGSERIAL PRIMARY KEY,
  run_at           timestamptz NOT NULL DEFAULT now(),
  sha              text,                       -- git sha of the code that judged
  fixture_id       text NOT NULL,              -- 'F1'..'F12'
  rule_id          text NOT NULL,              -- the live surface evaluated
  expected_verdict text NOT NULL,
  computed_verdict text NOT NULL,
  match            boolean NOT NULL,           -- computed == expected
  -- expectation drives the CI regression gate: a 'handled' row that flips to
  -- match=false is a REGRESSION (fail CI); a 'gap' row with match=false is the
  -- known-failing backlog signal (do NOT fail CI). 'partial' = evaluable sub-rule.
  expectation      text NOT NULL DEFAULT 'handled'
                     CHECK (expectation IN ('handled','partial','gap')),
  notes            text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS moderation_audit_run_idx
  ON public.moderation_audit (run_at DESC);
CREATE INDEX IF NOT EXISTS moderation_audit_fixture_idx
  ON public.moderation_audit (fixture_id, run_at DESC);

ALTER TABLE public.moderation_audit ENABLE ROW LEVEL SECURITY;
-- No client policies: the ledger is service_role-only (admin surfaces read via the
-- admin client). Append-only — never updated or deleted (mirrors
-- investigation_edge_audit). The harness writes with the service/direct-pg role.
GRANT SELECT, INSERT ON public.moderation_audit TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.moderation_audit_id_seq TO service_role;

COMMENT ON TABLE public.moderation_audit IS
  'SF-P3 (FIX-601): append-only ledger of the shadow moderation harness. One row per (fixture, rule, run): expected vs computed verdict from the LIVE rules, evaluated read-only (fixture content created in a txn and rolled back). Confers no consequence. Greppable report at docs/moderation-harness/. Never mutated.';
