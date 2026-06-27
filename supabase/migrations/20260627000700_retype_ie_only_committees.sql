-- FIX-669 — re-type independent-expenditure-only committees mistyped as 'other'.
--
-- cmteTypeToEntityType() (packages/data/src/pipelines/fec-bulk/writer.ts) only
-- mapped FEC committee type 'O' (Super PAC) to 'super_pac'; types 'U'
-- (single-candidate IE committee) and 'I' (Form-5 IE filer) fell through to
-- 'other'. Diagnostic (scripts/diagnose-ie-udp.sql, query 4) found 154 'other'
-- entities making Schedule E independent expenditures; 147 of them are type
-- I/U. The remaining 7 are H/S/P candidate committees (and junk Schedule E
-- rows) that are NOT super PACs and are deliberately excluded.
--
-- Predicate keys on the committee's registered FEC type
-- (metadata->>'fec_cmte_type_raw') intersected with the IE-spender signal, so
-- it is self-contained and env-portable — no hardcoded ids. Idempotent: the
-- entity_type='other' guard makes re-runs no-ops once the rows are flipped.
-- This is a re-type (UPDATE), not destructive. Affects ~147 rows.
UPDATE financial_entities fe
SET entity_type = 'super_pac'
WHERE fe.entity_type = 'other'
  AND fe.metadata->>'fec_cmte_type_raw' IN ('I', 'U')
  AND EXISTS (
    SELECT 1 FROM financial_relationships fr
    WHERE fr.from_type = 'financial_entity'
      AND fr.from_id = fe.id
      AND fr.relationship_type IN ('ie_support', 'ie_oppose')
  );
