-- Fixture: a PROCEDURE carrying the pattern, undeclared. MUST FAIL.
CREATE PROCEDURE public.fixture_bad_proc()
LANGUAGE plpgsql
SET statement_timeout = '10min'
AS $$
BEGIN
  NULL;
END $$;
