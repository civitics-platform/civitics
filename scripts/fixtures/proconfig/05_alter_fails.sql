-- Fixture: the ALTER form, undeclared. MUST FAIL.
ALTER FUNCTION public.fixture_bad(uuid) SET statement_timeout = '300s';
