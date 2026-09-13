-- Fixture: the same pattern, declared. MUST PASS.
CREATE OR REPLACE FUNCTION public.fixture_waived(p_id uuid)
RETURNS int
LANGUAGE plpgsql
SET search_path = public, extensions
-- fix1128: deliberate — kept only to document the value the caller must arm
SET statement_timeout = '300s'
AS $$
BEGIN
  RETURN 1;
END $$;
