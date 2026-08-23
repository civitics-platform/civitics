-- FIX-1089 / FIX-1090 — Platform Costs R4a: the data plane.
--
-- Four schema moves, all additive. Nothing is dropped and no existing column
-- changes meaning, because platform_usage_snapshot persists the WHOLE response
-- including display strings and the GHA snapshot cron drifts hours — the
-- dashboard renders the OLD payload until the next tick, and it must stay
-- correct throughout (the FIX-1076 lesson).
--
--   1. platform_subscriptions  — the recurring charges that are not metrics.
--   2. platform_limits.is_displayed — generic flag for API-only companion rows.
--   3. New self-counted metric rows (resend.emails_sent) + mapbox re-notes.
--   4. supabase.db_size_bytes band re-base, forced by the pct correction.

-- ── 1. platform_subscriptions ────────────────────────────────────────────────
--
-- WHY A TABLE AND NOT A CONSTANT. The dashboard headline has always been built
-- out of platform_limits rows, and a subscription is not expressible as one: it
-- has no quantity, no limit, and no overage. So Supabase Pro's $25/mo — a real,
-- known, recurring charge — had nowhere to live and was silently absent from
-- every total the platform has ever printed. Vercel's $20 only appeared because
-- it happens to ride inside vercel_billing.projected_total_bill_usd.
--
-- Rows are retunable with an UPDATE (same discipline as
-- vercel.included_usage_usd) rather than needing a deploy. `source` records
-- provenance so the card can caveat: 'api' = read off the vendor this tick,
-- 'configured' = a stated price we cannot source programmatically.
--
-- Unknown prices are NEVER guessed. A provider with no sourceable subscription
-- price gets no row, and the payload reports the omission — same principle as
-- ai-pricing.ts throwing on an unpriced model rather than billing it cheap.

CREATE TABLE IF NOT EXISTS public.platform_subscriptions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service      TEXT NOT NULL,
  name         TEXT NOT NULL,
  -- Normalized to USD PER MONTH. An annual charge stores its amortized monthly
  -- twelfth here and carries cadence='annual' so the card can footnote it
  -- instead of implying a monthly invoice.
  monthly_usd  NUMERIC NOT NULL CHECK (monthly_usd >= 0),
  cadence      TEXT NOT NULL DEFAULT 'monthly'
                 CHECK (cadence IN ('monthly', 'annual')),
  source       TEXT NOT NULL DEFAULT 'configured'
                 CHECK (source IN ('api', 'configured')),
  -- true = counted in the headline. false = tracked but footnoted (annual
  -- amortizations land here, per the R4a design decision).
  in_headline  BOOLEAN NOT NULL DEFAULT true,
  notes        TEXT,
  is_active    BOOLEAN NOT NULL DEFAULT true,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (service, name)
);

ALTER TABLE public.platform_subscriptions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'platform_subscriptions'
       AND policyname = 'public read subscriptions'
  ) THEN
    CREATE POLICY "public read subscriptions"
      ON public.platform_subscriptions FOR SELECT USING (true);
  END IF;
END $$;

INSERT INTO public.platform_subscriptions
  (service, name, monthly_usd, cadence, source, notes, sort_order)
VALUES
  ('vercel', 'Pro', 20.00, 'monthly', 'api',
   'Read live each tick from GET /v2/teams/{id} billing.invoiceItems.pro '
   '(price 2000 = cents, quantity 1). The seed is the fallback when the API is '
   'unreachable. This $20 also BUYS $20 of included usage — see '
   'vercel.included_usage_usd; do not double-count it as consumption.', 1),
  ('supabase', 'Pro', 25.00, 'monthly', 'configured',
   'Craig-stated. NOT sourceable: the Management API exposes the org plan '
   '(GET /v1/organizations/{slug} -> plan="pro", which we DO verify each tick) '
   'but every billing endpoint 404s — /billing/subscription, /billing/usage and '
   '/billing/addons are absent at org scope, and the project-scope '
   '/billing/addons returns only the compute add-on. Probed 2026-08-22.', 2),
  ('supabase', 'Compute (Micro)', 0.00, 'monthly', 'api',
   'GET /v1/projects/{ref}/billing/addons -> compute_instance ci_micro at '
   '$0.01344/hour (~$10/month). Pro includes a $10/month compute credit, so a '
   'Micro instance is exactly covered and the NET charge is $0. Kept as a live '
   'row rather than omitted so an instance resize shows up as money the moment '
   'it happens instead of silently.', 3)
ON CONFLICT (service, name) DO NOTHING;

-- ── 2. platform_limits.is_displayed ──────────────────────────────────────────
--
-- FIX-1076 dropped `vercel.overage_present` from the card by NAME:
--   metrics.filter(m => !(m.service === "vercel" && m.metric === "overage_present"))
-- That row exists only because warning_pct is an INTEGER and $0.01 of a $20
-- credit rounds to 0% (the FIX-1050 trap). It is wire format, not a quantity.
-- Hardcoding its name means the next companion row is invisible to the filter,
-- so the property becomes a column and the UI filters generically.
--
-- Deliberately NOT applied to upstash.limiter_degraded: that 0/1 IS the answer
-- to a question a human asks ("is the limiter alive"), and it is what the
-- Upstash strip renders. Only genuine wire-format companions get flagged.

ALTER TABLE public.platform_limits
  ADD COLUMN IF NOT EXISTS is_displayed BOOLEAN NOT NULL DEFAULT true;

UPDATE public.platform_limits
   SET is_displayed = false
 WHERE service = 'vercel'
   AND metric  = 'overage_present';

-- ── 3. Self-counted provider rows ────────────────────────────────────────────
--
-- RESEND. No usage API worth building on: GET /emails returns only the retained
-- tail (84 rows, has_more=false at limit=100, oldest 2026-07-27), so it can
-- cross-check a month but cannot be the counter. Counted at the sendEmail()
-- choke point instead — every one of the 12 send sites funnels through it.
-- Free tier is 3,000 emails/month; over it Resend blocks rather than bills, so
-- there is no overage rate to record and inventing one would be a guess.
INSERT INTO public.platform_limits (
  service, metric, plan, included_limit, unit,
  overage_unit_cost, overage_unit,
  display_label, display_group, warning_pct, critical_pct,
  billing_cycle, sort_order, notes, has_public_api
) VALUES
  ('resend', 'emails_sent', 'free', 3000, 'emails',
   NULL, NULL, 'Emails Sent', 'Email', 80, 95,
   'monthly_reset', 1,
   'Self-counted at the sendEmail() choke point (apps/civitics/src/lib/email.ts). '
   'LOWER BOUND: counting starts when this ships, so the first calendar month is '
   'partial, and a send whose counter write fails is still a send (counting is '
   'best-effort and never blocks an alert). Free tier blocks rather than bills, '
   'so there is no overage rate.', true)
ON CONFLICT (service, metric, plan) DO NOTHING;

-- MAPBOX. Retires manual entry for this provider (design decision 8). The
-- has_public_api=false machinery stays in place for any future provider that
-- genuinely needs it; Mapbox no longer qualifies because we now count it
-- ourselves. One metric by design: map mounts and server-side geocode requests
-- are summed against the map-load free tier, which is the SMALLER of the two
-- vendor allowances (50k loads vs 100k temporary-geocode requests) and is
-- therefore the conservative denominator. The split rides in metric metadata.
UPDATE public.platform_limits
   SET notes = 'Self-counted from service_usage (FIX-1090). Sums client map '
               'mounts (beacon, best-effort) and server-side Geocoding v6 '
               'requests (exact) against the 50k map-load free tier — the '
               'smaller of the two Mapbox allowances, so the percentage errs '
               'conservative. LOWER BOUND: a dropped beacon is an uncounted '
               'load. There is no usable Mapbox usage API on the credentials we '
               'hold — the token is a pk. publishable token and analytics/v1 '
               'answers 403 "requires a token with analytics:read scope" '
               '(probed 2026-08-22).',
       display_label = 'Map Loads + Geocodes',
       has_public_api = true
 WHERE service = 'mapbox' AND metric = 'map_loads';

-- ── 4. supabase.db_size_bytes band re-base ───────────────────────────────────
--
-- Forced by the pct correction, and called out here because it is the one place
-- in FIX-1089 where a band's INPUT changes.
--
-- Before: pct divided by display_limit (the 53 GiB provisioned disk FIX-353
-- writes each tick for capacity context), so the row read 56% and sat healthy
-- under 80/95 — while its LABEL said "29.6 GB / 8.0 GB". Two denominators in
-- one row.
--
-- After: pct divides by included_limit like every other row, so it reads ~370%
-- — which is true, and which is what the $2.70/month we already pay looks like
-- as a percentage. Left at 80/95 that is a PERMANENT critical: summary.
-- any_critical never clears, the dashboard's red banner never goes out, and the
-- per-metric escalation email fires once and then the band is useless forever.
-- That is the FIX-1050 permanent-warning trap wearing a different hat.
--
-- So the bands are re-based onto the meaning the row now carries. It is no
-- longer a capacity gauge — supabase.disk_used_bytes is, against the actual
-- provisioned disk, and it stays at 80/95. This row is a COST gauge, and the
-- bands are set where the disk-overage line becomes worth acting on:
--
--   included 8 GiB, $0.125/GB over
--   500%  = 40 GiB  → ~$4.00/month   (warning)
--   750%  = 60 GiB  → ~$6.50/month   (critical — and past the 53 GiB disk,
--                                     so it also implies a disk resize)
--
-- Today's 29.6 GiB / 370% / $2.70 stays healthy, which is the correct reading:
-- it is a known, budgeted, already-paid cost, not an incident.
UPDATE public.platform_limits
   SET warning_pct  = 500,
       critical_pct = 750,
       notes = '8 GiB included, $0.125/GB over. Bands are a COST signal, not a '
               'capacity one: pct is value/included_limit (FIX-1089), so 100% '
               'is the quota edge and 370% is the steady state we already pay '
               '$2.70/month for. 500% ~= $4/month, 750% ~= $6.50/month and past '
               'the provisioned disk. Capacity headroom is '
               'supabase.disk_used_bytes, which keeps 80/95 against the real '
               'disk size; display_limit here still carries the provisioned '
               'disk for the additive capacity_pct field.'
 WHERE service = 'supabase' AND metric = 'db_size_bytes' AND plan = 'pro';

-- PostgREST caches the schema; a new table + new column need a reload or the
-- API 404s/ignores them until the next restart.
NOTIFY pgrst, 'reload schema';
