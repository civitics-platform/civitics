-- =============================================================================
-- FIX-1117b — a per-arm OFF switch for the source-change gate, and the contracts
--             arm goes into it.
--
-- MEASURED ON PROD immediately after FIX-1117 landed. Nine of the ten probes are
-- pennies exactly as the design claimed:
--
--     oversight                                    46 ms
--     gifts / holds / lobbying / cosponsors /
--       appointments / investigation           20–35 ms each
--     entity_connection_stats_windows           1,440 ms
--     external          (skips an 899 s arm)    3,365 ms
--     votes                                     4,154 ms
--     contracts         (skips a  345 s arm)  111,575 ms   ← and 98,204 ms warm
--
-- The contracts probe is the one measurement the local clone got wrong, by 6x.
-- Its scope is financial_relationships WHERE relationship_type IN
-- ('contract','grant') — 3,908,956 rows inside a 12 GB table — and the plan is a
-- Parallel Bitmap Heap Scan: the bitmap index scan over
-- financial_relationships_type is cheap, the 3.9M heap fetches are not. Dropping
-- max(updated_at) does not rescue it; count(*) alone measured 98,692 ms with the
-- identical plan, because nothing indexed can serve it index-only.
--
-- 98 s to avoid a 344.6 s arm is still a net win on paper. It is not a win worth
-- taking: it spends the precise resource this whole line of work exists to
-- protect — prod's daily disk burst budget (FIX-1107) — on every cycle, up to
-- four times a day, in exchange for a 3.5:1 ratio, against 260:1 for external.
-- The right answer is a partial index on (updated_at) for that predicate, which
-- has to be built CONCURRENTLY in a supervised window and therefore cannot ride
-- a migration. That is FIX-1118.
--
-- Until then: this arm is UN-GATED. Not broken, not frozen — it runs every cycle
-- exactly as it did before FIX-1117, because a disabled arm returns a NULL
-- fingerprint and NULL is already the gate's fail-open value. The escape reuses
-- the failure path rather than adding a branch to the driver, so
-- run_entity_connections_rebuild() is not edited by this migration at all.
--
-- The list lives in pipeline_state, not in code, so FIX-1118 can re-enable the
-- arm with one UPDATE and no migration:
--
--     UPDATE public.pipeline_state
--        SET value = value || jsonb_build_object('disabled_arms', '[]'::jsonb)
--      WHERE key = 'ec_arm_source_fingerprints';
--
-- Cross-ref FIX-1117, FIX-1118, FIX-1107, FIX-885 (fail-open), FIX-1034.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ec_arm_source_fingerprint(p_arm text)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_n  bigint;
  v_ts timestamptz;
BEGIN
  -- ── FIX-1117b — the per-arm OFF switch, checked BEFORE any scan ───────────
  -- Returning NULL is the same thing the gate does when a probe errors, so a
  -- disabled arm is indistinguishable from an unprobeable one: it runs. This is
  -- deliberately the fail-open path and not a new one.
  IF EXISTS (
    SELECT 1
      FROM public.pipeline_state ps,
           jsonb_array_elements_text(COALESCE(ps.value->'disabled_arms', '[]'::jsonb)) d
     WHERE ps.key = 'ec_arm_source_fingerprints'
       AND d = p_arm
  ) THEN
    RETURN NULL;
  END IF;

  CASE p_arm

    -- votes.updated_at is indexed (votes_updated_at); whole-table is broader
    -- than the arm's vote-value filter, which is the safe direction.
    WHEN 'rebuild_entity_connections_votes' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts FROM public.votes;

    -- proposal_cosponsors has NO updated_at at all — created_at is the only
    -- timestamp it carries, so count is doing most of the work here.
    WHEN 'rebuild_entity_connections_cosponsors' THEN
      SELECT count(*), max(created_at) INTO v_n, v_ts FROM public.proposal_cosponsors;

    WHEN 'rebuild_entity_connections_appointments' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts FROM public.career_history;

    WHEN 'rebuild_entity_connections_oversight' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts FROM public.agencies;

    WHEN 'rebuild_entity_connections_investigation' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts FROM public.evidence_cards;

    -- external_relationships has neither created_at nor updated_at. ingested_at
    -- moves when a row is (re)ingested and source_updated_at when the upstream
    -- says it changed; GREATEST ignores NULLs, so either one moving is enough.
    -- 3,365 ms on prod against an arm measured at 899.1 s: the best ratio here
    -- by a wide margin, and the reason this gate is worth having at all.
    WHEN 'rebuild_entity_connections_external' THEN
      SELECT count(*), GREATEST(max(ingested_at), max(source_updated_at))
        INTO v_n, v_ts FROM public.external_relationships;

    -- ── the four FR-sourced arms, each scoped to its OWN predicate ───────────
    -- Labels read out of the shipped arm bodies and checked against pg_enum
    -- (financial_relationship_type: donation, gift, honorarium, loan,
    --  owns_stock, owns_bond, property, contract, grant, lobbying_spend, other,
    --  ie_support, ie_oppose). Three of these four carry zero rows today, which
    --  is why they probe in 20–35 ms: the bitmap index scan finds nothing and
    --  there is no heap to fetch. 'contract'/'grant' is the one with 3.9M rows
    --  and it is disabled above pending FIX-1118's partial index.
    WHEN 'rebuild_entity_connections_contracts' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts
        FROM public.financial_relationships
       WHERE relationship_type IN ('contract', 'grant');

    WHEN 'rebuild_entity_connections_gifts' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts
        FROM public.financial_relationships
       WHERE relationship_type IN ('gift', 'honorarium');

    WHEN 'rebuild_entity_connections_holds' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts
        FROM public.financial_relationships
       WHERE relationship_type IN ('owns_stock', 'owns_bond', 'property');

    WHEN 'rebuild_entity_connections_lobbying' THEN
      SELECT count(*), max(updated_at) INTO v_n, v_ts
        FROM public.financial_relationships
       WHERE relationship_type = 'lobbying_spend';

    -- FIX-1115's stats arm rides the same registry. entity_connections is its
    -- source; derived_at is indexed and DEFAULTs to now(), so any INSERT moves
    -- the max, and count(*) is what catches a delete-only cycle (the FIX-969
    -- arms that DELETE and insert nothing). Sufficient by construction for what
    -- the stats aggregate actually depends on: the conflict key is
    -- (from_type, from_id, to_type, to_id, connection_type), so an ON CONFLICT
    -- DO UPDATE can never change an entity's edge MEMBERSHIP — only an INSERT
    -- (new derived_at) or a DELETE (lower count) can, and both move this value.
    WHEN 'entity_connection_stats_windows' THEN
      SELECT count(*), max(derived_at) INTO v_n, v_ts FROM public.entity_connections;

    ELSE
      RETURN NULL;   -- unknown arm ⇒ cannot tell ⇒ the caller runs it
  END CASE;

  RETURN format('n=%s;t=%s', COALESCE(v_n, -1), COALESCE(v_ts::text, '-'));
END;
$$;

REVOKE ALL ON FUNCTION public.ec_arm_source_fingerprint(text) FROM PUBLIC, anon, authenticated;

COMMENT ON FUNCTION public.ec_arm_source_fingerprint(text) IS
  'FIX-1117/1117b — cheap (count, max-timestamp) fingerprint over ONE '
  'entity_connections arm''s own source scope, used by '
  'run_entity_connections_rebuild() to skip an arm whose source has not changed '
  'since that arm''s last successful build. Returns NULL for an unrecognised arm, '
  'for an arm listed in pipeline_state.ec_arm_source_fingerprints.disabled_arms, '
  'or on any probe failure — and NULL means RUN. The gate fails open in every '
  'direction (FIX-885), and the disable switch reuses that same path rather than '
  'adding a second one. Scope is per arm and deliberately BROADER than the arm''s '
  'own filter wherever they differ. The four financial_relationships arms MUST be '
  'scoped by relationship_type or a donation write would move all four every day; '
  'their labels come from the arm bodies and were checked against pg_enum (the '
  'FIX-073 rule). Measured on PROD: oversight 46 ms, gifts/holds/lobbying/'
  'cosponsors/appointments/investigation 20-35 ms, stats 1,440 ms, external '
  '3,365 ms (skipping an 899 s arm), votes 4,154 ms — and contracts 98,204 ms '
  'warm, which is why it is disabled pending FIX-1118''s partial index.';


-- ─────────────────────────────────────────────────────────────────────────────
-- Seed the disable list. `defaults || value` puts the existing row on the RIGHT
-- so a key already present wins — an operator who has already tuned this is not
-- stamped on by a replay — while a row that predates the key gets it.
-- ─────────────────────────────────────────────────────────────────────────────
UPDATE public.pipeline_state
   SET value = jsonb_build_object(
                 'disabled_arms',
                 jsonb_build_array('rebuild_entity_connections_contracts'))
               || value,
       updated_at = now()
 WHERE key = 'ec_arm_source_fingerprints';

-- The row is created by FIX-1117 with ON CONFLICT DO NOTHING; if a fresh
-- database somehow lacks it, create it complete.
INSERT INTO public.pipeline_state (key, value)
VALUES ('ec_arm_source_fingerprints', jsonb_build_object(
          'arms', '{}'::jsonb,
          'disabled_arms', jsonb_build_array('rebuild_entity_connections_contracts')))
ON CONFLICT (key) DO NOTHING;

NOTIFY pgrst, 'reload schema';
