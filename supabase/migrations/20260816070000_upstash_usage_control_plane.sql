-- Upstash usage becomes a LIVE metric — the leading half of FIX-1038.
--
-- 20260816030000 seeded `upstash.period_commands` with has_public_api = false,
-- on the then-correct finding that this repo held only the per-database REST
-- credentials and Upstash exposes command counts solely through its management
-- API. A management key has since been minted, so the gap is closed and the
-- row's metadata has to stop describing a limitation that no longer exists.
--
-- What changed, measured on the vendor 2026-08-16:
--
--   GET /v2/redis/database/{id} → db_request_limit: 500000, auto_upgrade: false
--   GET /v2/redis/stats/{id}    → total_monthly_requests: 498964
--                                 (read 230550 / write 268414)
--                                 daily_net_commands: 1
--
-- **The allotment is MONTHLY, not daily.** The 20260816030000 notes recorded
-- this as open, on data-plane evidence only (the counter had not reset 5h38m
-- after exhaustion, across a 00:00 UTC boundary). `total_monthly_requests` is
-- the vendor confirming it. That matters well beyond bookkeeping: the
-- 2026-08-15 crawl did not cost a day of rate limiting, it cost the remainder
-- of the billing cycle — `daily_net_commands: 1` alongside 498,964 monthly is
-- that fact in two numbers. Nothing is being spent today because nothing CAN be.
--
-- billing_cycle was already 'monthly_reset'; it stays, and is now confirmed
-- rather than assumed.
--
-- included_limit is left at 500000 here but is no longer authoritative: the
-- snapshot writer overwrites it each tick from the vendor's own
-- `db_request_limit`, the same self-correcting pattern FIX-351 uses for the
-- Supabase disk size. A tier change therefore fixes itself.
--
-- Thresholds: warning stays 80, critical drops 100 → 95. Neither is a guess.
--   * at baseline traffic the allotment lasts ~55 days, i.e. a normal month
--     lands near ~55% — so 80% does not fire on ordinary use, and 95% is ~10×
--     above any ordinary month-end;
--   * at the 2026-08-15 crawl rate (~9 commands/sec) 80→95% is roughly 2.5
--     hours of notice and 95→100% another ~45 minutes, versus the previous
--     behaviour of alarming only once the cap was ALREADY crossed.
--   * critical_pct = 100 was structurally UNREACHABLE on this metric, which is
--     the real reason for the change. Measured at the same instant on
--     2026-08-16: billing said 498,964/500,000 = 99.79% while enforcement was
--     already refusing with `Usage: 500002`. The billing counter lags and
--     appears to stop at/below the cap, so a 100% trigger on a lagging counter
--     can never fire — the row would sit at "warning" through a total outage.
--     95 is reachable. (upstash.limiter_degraded remains the hard liveness
--     signal; this is the leading one, and a leading indicator that cannot
--     escalate is not one.)
--
-- NB `period_commands` and the number parsed out of Upstash's refusal message
-- are DIFFERENT counters and they disagree — 498,964 (billing) vs `Usage:
-- 500002` (enforcement) at the same moment. Billing lags enforcement. Which is
-- why `limiter_degraded` is still driven by the PING probe and never by this
-- percentage: "under quota" does not imply "working".
--
-- Idempotent: plain UPDATEs, safe to re-run. No-op if 20260816030000's rows are
-- absent.

UPDATE platform_limits
   SET has_public_api = true,
       display_label  = 'Monthly Commands',
       critical_pct   = 95,
       notes = 'Upstash free-tier allotment: 500,000 commands per MONTH '
            || '(vendor-confirmed 2026-08-16 via /v2/redis/stats: '
            || 'total_monthly_requests), auto_upgrade=false so exhaustion '
            || 'throttles the database rather than billing — a hard $0 ceiling. '
            || 'Value is total_monthly_requests from the Upstash MANAGEMENT API '
            || '(UPSTASH_EMAIL + UPSTASH_API_KEY + UPSTASH_DATABASE_ID); '
            || 'included_limit is refreshed each snapshot tick from the '
            || 'vendor''s own db_request_limit, so a tier change self-corrects. '
            || 'Measured 2026-08-15: a ~7,200 req/hr crawl spent the entire '
            || 'MONTH''S allotment in 15.5 hours (~9 commands/sec) against ~55 '
            || 'days at baseline traffic, and it stayed spent — one crawl costs '
            || 'the rest of the cycle, not a day. This counter LAGS enforcement '
            || '(498,964 here vs Usage: 500002 in the refusal message at the '
            || 'same instant), so it is a leading indicator only — never read '
            || '"under quota" as "limiter working". upstash.limiter_degraded, '
            || 'driven by the PING probe, is the liveness signal. critical_pct '
            || 'is 95, not 100, because the lagging billing counter appears to '
            || 'stop below the cap and a 100% trigger on it can never fire.'
 WHERE service = 'upstash'
   AND metric  = 'period_commands';

-- The liveness row gains a pointer to its new companion so the two are not read
-- as duplicates of each other on the card.
UPDATE platform_limits
   SET notes = notes
            || ' PAIRED WITH upstash.period_commands, which is the LEADING '
            || 'indicator (how close to the cap) while this row is the LIVENESS '
            || 'one (is it refusing right now). They disagree by design: the '
            || 'billing counter lags enforcement, so this row can read 1 while '
            || 'period_commands still reads under 100%.'
 WHERE service = 'upstash'
   AND metric  = 'limiter_degraded'
   AND notes NOT LIKE '%PAIRED WITH%';
