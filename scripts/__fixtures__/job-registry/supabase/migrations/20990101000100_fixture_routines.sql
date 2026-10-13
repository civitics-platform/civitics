-- Fixture: the routines the fixture seed's unit_calls name.
CREATE OR REPLACE PROCEDURE public.proc_a()
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1;
END $$;

CREATE OR REPLACE FUNCTION public.probe_b(p text, q text[])
RETURNS void LANGUAGE sql AS $$ SELECT 1 $$;
