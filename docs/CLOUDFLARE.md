# Cloudflare — civitics.com

**Last verified: 2026-08-08.**

The dashboard is the source of truth for what each setting *is*. This doc exists for
the things the dashboard cannot express: which settings are load-bearing for this app,
and why. Treat the posture table as a dated snapshot, not as truth — but treat the
couplings as normative. Changing one of those without reading its receipt has broken
production before.

---

## Zone identity

| | |
|---|---|
| Account | `Civitics.platform@gmail.com's Account` — `737d0a50e966fc83bb6703e7f83ab6f9` |
| Zone | `civitics.com`, **Free** plan, DNS setup Full |
| Nameservers | `arch.ns.cloudflare.com` / `teagan.ns.cloudflare.com` |
| Origin | Vercel — apex and `www` are both A records to `216.198.79.1`, **proxied** |
| Edge cert | Universal, `*.civitics.com, civitics.com`, expires 2026-11-05, backup issued |

The zone moved here from Craig's personal Cloudflare account on **2026-08-08**. Both the
zone ID and the account ID changed; any `CLOUDFLARE_ZONE_ID` or API token minted under the
personal account points at a zone this account cannot see, and old tokens 403. R2 and
Turnstile were already on this account — the domain was the only thing that moved.

---

## Load-bearing couplings

### 1. Browser Cache TTL must stay **Respect Existing Headers**

Cloudflare overrides the origin's browser-facing `Cache-Control` whenever the origin value
is *lower* than the zone's Browser Cache TTL. `apps/civitics/src/lib/cdn-cache.ts`
(FIX-796) deliberately leaves the browser leg alone — "browsers revalidate, edges serve the
s-maxage window" — and stamps `CDN-Cache-Control: public, s-maxage=300` so those public API
GETs are edge-cacheable. A non-zero Browser Cache TTL therefore silently converts "browser
revalidates every request" into "browser holds the payload for N hours", and **a Cloudflare
purge cannot reach a browser cache.**

The zone came out of the account move set to 4 hours. Corrected 2026-08-08.

This does *not* affect the per-user leak class (FIX-786/787): viewer payloads are
`no-store`, which Cloudflare does not cache.

### 2. Bot Fight Mode stays **OFF**

Bot Fight Mode challenges `fetch()`-issued requests, which is exactly the FIX-799
mechanism: when Cloudflare challenges a Next.js RSC fetch, the fetch receives 403
`Cf-Mitigated: challenge` HTML instead of the RSC payload and the router falls back to a
hard navigation.

~~⚠️ `docs/ARCHITECTURE.md` … and `docs/OPERATIONS.md` still describe Bot Fight Mode as
ON…~~ — **retracted 2026-08-16 (FIX-1042 sweep). Both files were already correct when
this warning was written, and re-verified line by line since:**
`docs/ARCHITECTURE.md` names "Bot Fight Mode OFF" in the request-flow diagram (§System
Overview), says it is "deliberately **off**" in §Cloudflare Proxy, and says it is "**off**
at Layer 1 by design" in the abuse-defense list — each with the FIX-799 reasoning and a
pointer back here. `docs/OPERATIONS.md` §Vercel Fluid CPU credits the `Common Exploit
Paths` WAF rule and parenthesises "Bot Fight Mode is off by design". **There was nothing
to correct; the warning was the stale artifact.** Left in place struck through rather than
deleted, because a doc that has cried stale once will be trusted next time.

What *is* still true and load-bearing: the job Bot Fight Mode is sometimes assumed to do
is carried by the `Common Exploit Paths` WAF custom rule (below), which targets the same
traffic more precisely — **and that rule is now partially validated on live data**, not
just asserted: in the 2026-08-15 crawl window `/wp-includes/fonts/index.php`,
`/defaults.php`, `/wp-admin/*` and `/wp-content/*` probes all reached the zone and were
mitigated. Watch Vercel Fluid CPU after Under Attack mode goes off — that remains the real
test of whether the custom rule alone holds the line.

### 3. The rule surface is empty **on purpose**

Cache Rules 0 · Cache Response Rules 0 · Page Rules 0/3 · no Redirect / Transform /
Configuration / Origin rules.

This is correct, not a casualty of the account move. FIX-796 moved CDN cache headers *out*
of `next.config.mjs` `headers()` and into per-response handler code, because config rules
are method- and status-blind — a config rule on an API path stamps POST responses and error
statuses just as happily as GET 200s (captured live on prod). Caching policy is owned by
`withPublicCdnCache`, not by the dashboard. Do not go looking for lost Cache Rules after a
future move.

The one custom rule that does exist is security, not caching:

> **Common Exploit Paths** — Block where URI Path contains `.php`, `wp-`, `.env`,
> `xmlrpc`, or `phpmyadmin`. 1 of 5 custom rules. Active.

### 4. SSL/TLS mode must be **Full (strict)**

Vercel serves a valid certificate for the domain and forces HTTPS at the origin. *Flexible*
would produce a redirect loop; plain *Full* would leave the Cloudflare→origin leg
unauthenticated. Full (strict) is the only correct setting here.

### 5. The Cloudflare layer cannot be verified by script

Cloudflare 403s every scripted probe to civitics.com, including browser-UA curl — both apex
and www return `403 Cf-Mitigated: challenge` (FIX-799, FIX-513). Anything that depends on a
CF-layer response header (`cf-cache-status`, `cf-mitigated`) has to be checked from a real
browser. Scripted verification sees the Vercel layer only, and a green scripted check proves
nothing about Cloudflare.

---

## Posture as of 2026-08-08

Snapshot. Verify in the dashboard before relying on any row.

| Setting | Value | Note |
|---|---|---|
| SSL/TLS mode | Full (strict) | required — see §4 |
| Browser Cache TTL | Respect Existing Headers | required — see §1 |
| Caching Level | Standard | default |
| Bot Fight Mode | **Off** | intentional — see §2 |
| Security level | **I'm Under Attack: enabled** | temporary — see Pending |
| WAF custom rules | 1/5 — Common Exploit Paths | active |
| TLS 1.3 | On | |
| Automatic HTTPS Rewrites | On | |
| Always Use HTTPS | Off | optional; Vercel already redirects |
| HSTS | Off | deliberate — preload is near-irreversible |
| Minimum TLS Version | 1.0 (default) | should be 1.2 |
| DNSSEC | Not enabled | disabled for the move, never re-enabled |
| Certificate Transparency Monitoring | Off | free issuance alerts |

**DNS records (5):**

```
civitics.com                    A    216.198.79.1                           Proxied
www.civitics.com                A    216.198.79.1                           Proxied
send.civitics.com               MX   feedback-smtp.us-east-1.amazonses.com  DNS only (10)
send.civitics.com               TXT  v=spf1 include:amazonses.com ~all      DNS only
resend._domainkey.civitics.com  TXT  p=MIGf…                                DNS only
```

Mail is Resend (via SES) on the `send.` subdomain. SPF and DKIM present; **no DMARC**.

---

## Pending

- [ ] **Turn Under Attack mode off.** While it is on, every RSC prefetch and soft-nav is a
      JS-challenge coin flip, and every non-browser client — GHA post-push verification
      curls, uptime checks, webhooks — gets 403. Drop to the default automated security
      level once the transfer has settled.
- [ ] **Add the FIX-799 Skip rule** for same-origin `RSC eq "1"` GETs, so managed challenge
      stops firing on the app's own soft navigations. More urgent while Under Attack is on.
- [ ] **Add a DMARC record** — `_dmarc.civitics.com` TXT, `v=DMARC1; p=none; rua=…` to
      start. SPF and DKIM without DMARC leave the domain spoofable.
- [ ] Minimum TLS → 1.2; enable Certificate Transparency Monitoring. One click each.
- [ ] Re-enable DNSSEC (DS record handling depends on where the domain is registered).
- [ ] Confirm Search Console is still verified — there are no verification TXT records in
      the zone, so a DNS-based verification did not survive the move.
- [x] ~~Correct the stale Bot Fight Mode claims in `docs/ARCHITECTURE.md` and
      `docs/OPERATIONS.md`~~ — **no-op, 2026-08-16.** Both files were already correct;
      §2's warning was the stale thing and has been retracted there.

## The platform now WRITES to this zone (FIX-1045)

**As of 2026-08-16 the security level is no longer a purely human setting.** The
10-minute platform-snapshot cron runs a closed loop that can raise it by itself.
Read this before you next find the level different from how you left it.

### What it does, and when

| | |
|---|---|
| **Trigger** | Origin-reaching requests ≥ **3,000/hr** in **≥2 distinct complete clock hours** within a rolling 6h window |
| **Action** | `PATCH /zones/{id}/settings/security_level` → `under_attack` |
| **Revert** | Automatically after **6 hours**, back to the level it found |
| **Re-trip** | Allowed, but not within 2h of a revert |
| **Emails** | Every transition, to `ADMIN_EMAIL` |

"Origin-reaching" means `originResponseStatus != 0` in the GraphQL Analytics
API — requests Vercel actually answered. Requests Cloudflare blocked, challenged
or served from cache are excluded, which is what makes the loop self-limiting:
**while a mitigation is working, the trigger metric collapses and the loop goes
quiet.** On 2026-08-15 the same ~7,300 edge req/hr went from 7,302 origin-reaching
at 21:00 UTC to 36 at 23:00 UTC.

The 3,000/hr figure is derived, not chosen: a census of the 147 complete hours
this Free zone retained before the crawl gave p50 77, p99 1,508, max 2,218 —
against a crawl floor of 7,158. Full derivation in
`packages/db/src/cf-mitigation-loop.ts`.

### How to tell an automatic change from a manual one

Three independent ways, in order of convenience:

1. **The dashboard** — Operations tab, Platform Costs card. The strip under the
   headline reads `Loop TRIPPED (auto, since HH:MM UTC)` whenever the level is
   the loop's doing, and `armed` / `disarmed` otherwise.
2. **The database** — `pipeline_state.cf_mitigation_loop`. If `tripped` is
   non-null, the current level was set by the loop and carries `tripped_at`,
   `previous_level` and the breach hours that justified it. If `tripped` is null,
   **the loop did not set the current level.**
3. **Your inbox** — the loop emails every transition. No email, no automatic
   change.

### It will never fight you

Escalate-only, enforced in code and covered by tests:

- It only ever **raises** the level, never lowers it — except to undo an
  escalation it made itself.
- Before reverting it **re-reads the live level**. If that is not the exact level
  it set, it concludes you changed it by hand, **writes nothing**, drops its
  claim on the setting, and emails you the discrepancy. Your value stands.
- If the level is already at or above `under_attack` when the trigger fires, it
  records **no trip at all** — it must never end up auto-reverting a level a
  human chose.

So: **if you set the security level manually, it is yours.** The worst the loop
can do to a manual setting is raise it during a genuine spike, and even that only
from strictly below `under_attack`.

### Turning it off

Any one of these disarms the WRITE while leaving detection, metrics and alerting
fully live — you never lose visibility by disabling the loop:

- Flip the **`cf_auto_mitigation` kill switch** off (Operations tab, or
  `pipeline_state.kill_switches`).
- Set **`CF_AUTO_MITIGATION_ENABLED=false`** in the Vercel env (the hard kill —
  works even if the DB read fails).
- Remove **Zone Settings:Edit** from the Cloudflare API token.

### Token scope, and how the loop proves its own (FIX-1047)

`security_level` writes need **Zone Settings:Edit**. The trap: "Zone Settings"
appears **twice** in Cloudflare's token permission dropdown — Read and Edit are
separate rows — so a token with only Read looks correctly scoped at a glance.
`Zone:Edit` is a different permission group (zone metadata) and does **not**
grant settings writes.

History on this zone: the token was Read-only until 2026-08-16
(`GET security_level` → 200, `PATCH` → **403 / 9109**), which is why the loop
shipped alert-only. Edit was added the same day and the write now returns 200.

**The loop no longer assumes any of this.** Twice a day it issues an
**idempotent `PATCH` of the level the zone already has** — a 200 proves Edit, a
9109 proves Read-only. Nothing changes at the edge and `modified_on` does not
move (verified by hand across the permission change: pinned at
`2026-08-15T22:03:19Z` through no-op PATCHes on both sides of it).

Why this exists: before it, the token's write scope was only ever discovered *at
the moment the loop first needed to write* — i.e. during a live burn. A token
minted without Edit, later rolled, re-scoped, or expired was invisible until the
mitigation was already needed. That is the same class of silent failure that made
2026-08-15 cost what it did.

Why **twice a day and not every tick**: an idempotent PATCH still writes a
Cloudflare **audit-log entry**, and the audit log is one of the ways above to
tell an automatic change from a manual one. Probing every tick would bury real
changes under ~40 no-op entries a day.

Staleness is harmless for correctness — before a real trip the loop attempts the
actual write regardless, and that write is authoritative. The cache only affects
the *reported* status.

**Where it shows:** the Platform Costs card reads `armed ✓ verified`,
`ALERT-ONLY · needs Zone Settings:Edit`, `armed (unverified)` (no probe yet), or
`disarmed`. A disarmed loop never probes — a no-op write is still a write.

### Forcing a real trip in a verify run

An alarm nobody has watched fire is an alarm nobody should trust. Set
`CF_TRIP_ORIGIN_REQ_THRESHOLD` in the Vercel env to something the zone's normal
traffic clears (e.g. `50`) and the next tick with two breached hours will trip
for real, email, hold for 6h and auto-revert.

The effective threshold rides in the snapshot payload and the card shows
`threshold OVERRIDDEN to N/hr` in amber whenever it differs from the derived
3,000 — because a verify-run value left in place is its own incident. A
non-numeric or non-positive value is ignored rather than obeyed, so an env typo
cannot set the threshold to 0 and trip the loop on every quiet hour.

## If the zone ever moves accounts again

Cloudflare moves the registration and lets you re-import DNS. **It moves nothing else.**
SSL/TLS mode, edge certificates, every rule type, WAF rules, Bot Fight Mode, Browser Cache
TTL, HSTS, DNSSEC, Email Routing rules and notifications all reset to a fresh-zone baseline,
and analytics history stays with the old zone. Re-read §1–§4 and the posture table above
before assuming anything survived.
