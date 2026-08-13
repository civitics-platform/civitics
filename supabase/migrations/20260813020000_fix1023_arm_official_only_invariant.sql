-- =============================================================================
-- FIX-1023 — every donor-rollup arm is officials-only, and the two regimes are
-- now made to agree about that by an assertion rather than by convention.
--
-- BACKGROUND. Arm 1 (official_donor_rollup_mv) was the one arm written for
-- EVERY recipient rather than only officials: neither regime filtered it —
-- donor_rollup_rebuild_recipients() deletes/inserts on `official_id = ANY(...)`
-- with no to_type predicate, and donor_rollup_rebuild_bulk()'s arm-1 DELETE /
-- INSERT pair omits the is_official filter that arms 2-6 all carry. That was a
-- deliberate FIX-704 property (the rollup keyed recipients of BOTH kinds so a
-- super-PAC focus could read it).
--
-- FIX-1018 then added `AND fr.to_type = 'official'` to every dirty-set
-- enumeration site, so those non-official recipients stopped being enumerated —
-- their rows were no longer refreshed, and nothing deleted them either
-- (reconcile_donor_rollup_orphans() only removes recipients with NO surviving
-- qualifying FR row at all). They froze and drifted.
--
-- Craig chose option (a) on 2026-08-12: DELETE them, and accept that a
-- financial-entity focus always takes the raw entity_connections fallback —
-- which is what every other arm already does. The reader census found no
-- confirmed reader of the frozen rows: /api/graph/connections gates the rollup
-- behind isOfficialFocus with a raw fallback, /api/graph/treemap-pac's entityId
-- mode keys on an official, and while /api/graph/treemap entity mode does read
-- official_donor_rollup_mv without probing `officials` first, no caller supplies
-- a PAC id to it. For that hypothetical call the delete turns STALE into EMPTY,
-- which is indistinguishable from the route's perspective.
--
-- THIS MIGRATION is the durable half — the delete itself is a one-off data
-- operation, not a schema change, and was performed separately under
-- supervision. Without an assertion the two regimes can diverge again the next
-- time one of them grows a predicate the other lacks, and the drift is silent
-- for weeks (this one was found by accident while implementing FIX-1018).
-- donor_rollup_bulk_assert_invariants() exists for exactly this class, so the
-- check goes there and runs on every bulk rebuild.
--
-- ONE ARM IS DELIBERATELY NOT OFFICIALS-ONLY. treemap_individuals_rollup keys
-- on scope_id and carries a GLOBAL scope row-set under the all-zeros sentinel
-- uuid (3,034 rows on prod, 2026-08-13), maintained by
-- refresh_treemap_individuals_global() / pg_cron job 26. That is legitimate and
-- must be exempted by value, not by skipping the arm — skipping it would leave
-- the one arm with a non-uuid-keyed scope unguarded.
--
-- COST. Each arm is one anti-join against `officials` with LIMIT 1. In the
-- healthy (empty) case that is a scan, so the whole assertion is O(sum of arm
-- sizes) — a few seconds against a bulk rebuild that runs for hours. It is
-- deliberately not indexed for: the check should be cheap to keep correct, not
-- cheap to run.
--
-- Cross-ref FIX-1018, FIX-974, FIX-704, FIX-943.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.donor_rollup_bulk_assert_invariants()
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $function$
DECLARE
  v_bad_from_type text;

  -- FIX-1023 — (arm table, official-key column). All six arms, so a new arm or
  -- a changed predicate cannot quietly reintroduce non-official recipients.
  c_arms text[][] := ARRAY[
    ['official_donor_rollup_mv',        'official_id'],
    ['official_donor_totals',           'official_id'],
    ['official_small_dollar_rollup',    'official_id'],
    ['official_sector_affinity_rollup', 'official_id'],
    ['official_donor_bracket_totals',   'official_id'],
    ['treemap_individuals_rollup',      'scope_id']
  ];
  v_tbl  text;
  v_col  text;
  v_bad  uuid;
  v_n    bigint;
  i      int;
BEGIN
  -- ── FIX-974b — arm 2 has no from_type predicate; the bulk regime can only
  -- see from_type='financial_entity'. A non-empty gap means the two regimes
  -- disagree, so refuse rather than publish a quietly-low number.
  SELECT fr.from_type INTO v_bad_from_type
  FROM public.financial_relationships fr
  WHERE fr.relationship_type = 'donation'
    AND fr.to_type   = 'official'
    AND fr.from_type <> 'financial_entity'
  LIMIT 1;

  IF v_bad_from_type IS NOT NULL THEN
    RAISE EXCEPTION
      'donor_rollup_rebuild_bulk(): donation->official rows exist with from_type=% . '
      'The bulk regime reads financial_relationships_donor_rollup_idx, whose partial '
      'predicate is from_type=''financial_entity'', so official_donor_totals (arm 2, '
      'which has no from_type predicate) would understate those officials. Widen the '
      'bulk scan or the index before running this again.', v_bad_from_type;
  END IF;

  -- ── FIX-1023 — every arm is officials-only ────────────────────────────────
  FOR i IN 1 .. array_length(c_arms, 1) LOOP
    v_tbl := c_arms[i][1];
    v_col := c_arms[i][2];

    EXECUTE format(
      'SELECT t.%1$I, count(*) OVER () '
      '  FROM public.%2$I t '
      ' WHERE t.%1$I <> ''00000000-0000-0000-0000-000000000000''::uuid '
      '   AND NOT EXISTS (SELECT 1 FROM public.officials o WHERE o.id = t.%1$I) '
      ' LIMIT 1',
      v_col, v_tbl)
    INTO v_bad, v_n;

    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION
        'donor_rollup_bulk_assert_invariants(): %.% holds rows for recipient % , which is '
        'not in officials (at least % row(s) in this arm). Since FIX-1018 every dirty-set '
        'enumeration is scoped to fr.to_type = ''official'', so these rows can never be '
        'refreshed again — they freeze and drift silently, which is exactly what FIX-1023 '
        'cleaned up. Either delete them (option (a), what FIX-1023 chose) or give this arm '
        'its own broader enumeration; do not leave them unmaintained.',
        v_tbl, v_col, v_bad, v_n;
    END IF;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.donor_rollup_bulk_assert_invariants() IS
  'Pre-flight invariants for donor_rollup_rebuild_bulk(). FIX-974b: no '
  'donation->official row may carry from_type <> ''financial_entity'' (arm 2 '
  'has no from_type predicate but the bulk index does). FIX-1023: no arm may '
  'hold rows for a recipient absent from `officials` — since FIX-1018 scoped '
  'every dirty-set enumeration to to_type=''official'', such rows can never be '
  'refreshed again. The all-zeros uuid is exempt: it is treemap_individuals_'
  'rollup''s legitimate GLOBAL scope sentinel.';

REVOKE ALL ON FUNCTION public.donor_rollup_bulk_assert_invariants() FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.donor_rollup_bulk_assert_invariants() TO service_role;
