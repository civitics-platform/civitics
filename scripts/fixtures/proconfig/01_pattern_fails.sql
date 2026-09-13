-- Fixture: the inert pattern, undeclared. MUST FAIL.
CREATE OR REPLACE FUNCTION public.fixture_bad(p_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions
SET statement_timeout = '300s'
AS $$
BEGIN
  RETURN 1;
END $$;
