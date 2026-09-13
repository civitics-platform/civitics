-- Fixture: the REAL mechanisms. MUST PASS — none of these is inert.
SET statement_timeout = '90min';

CREATE OR REPLACE PROCEDURE public.fixture_ok()
LANGUAGE plpgsql
AS $$
BEGIN
  -- a SET inside the BODY is code, not a proconfig
  SET statement_timeout = '60s';
  PERFORM set_config('statement_timeout', '60s', false);
  COMMIT;
END $$;

ALTER FUNCTION public.fixture_ok() RESET statement_timeout;
ALTER ROLE some_role SET statement_timeout = '8s';
