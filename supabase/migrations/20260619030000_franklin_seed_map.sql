-- FIX-607 — data:seed:franklin idempotency ledger.
--
-- Maps each authored logical `seed_key` to the physical row it created, so the
-- pipeline can be re-run any number of times without duplicating, and the gated
-- reset path can delete exactly (and only) the rows it authored — all of which
-- are synthetic.
--
-- This is internal seed bookkeeping. It is NOT a public surface: RLS is enabled
-- with no policies, so anon/authenticated cannot read it via PostgREST. The seed
-- pipeline writes it over a direct `postgres` connection, which bypasses RLS.

create table if not exists public.franklin_seed_map (
  seed_key   text primary key,
  table_name text not null,
  row_id     uuid not null,
  created_at timestamptz not null default now()
);

comment on table public.franklin_seed_map is
  'FIX-607: maps State of Franklin seed_key -> physical row_id for idempotent re-seeding and scoped reset. All mapped rows are synthetic.';

alter table public.franklin_seed_map enable row level security;
-- No policies: deny-all to anon/authenticated. Seed runs as postgres (RLS bypass).
