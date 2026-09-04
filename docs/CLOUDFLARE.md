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

The second security rule was added 2026-09-04 to unblock [[FIX-1057]]:

> **Probe skip (FIX-1057)** — Skip → **Security Level only**, where
> `(http.request.headers["x-civitics-probe"][0] eq "<secret>")`. Active.

Why it is shaped exactly that way, because each choice is load-bearing:

- **Skip "Security Level", not "All remaining custom rules".** The rule buys the
  request-path probe past the Under Attack challenge and nothing else — `Common
  Exploit Paths` still applies to it. Ticking the broader box would turn a
  leaked header into a WAF bypass rather than a challenge bypass.
- **A secret header, not a UA or an IP allowlist.** GitHub-hosted runners have no
  stable egress IP, and a User-Agent is forgeable by anyone. The header value is
  32 random bytes, held in the `PROBE_HEADER_SECRET` GitHub Actions secret and in
  this rule's expression — those two places and nowhere else.
- **It does NOT change the zone posture.** `security_level` stays `under_attack`;
  the Pending item below is still open and still the real fix. This rule admits
  one client, which is why an external uptime service remains blocked.

Rotating the secret means editing the WAF expression and the GHA secret
*together*. Changing only one makes the probe fail every run — a permanently-red
pager, which is the disabled-pager failure [[FIX-1057]] existed to avoid.

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

## Posture as of 2026-08-17

Snapshot. Verify in the dashboard before relying on any row.

| Setting | Value | Note |
|---|---|---|
| SSL/TLS mode | Full (strict) | required — see §4 |
| Browser Cache TTL | Respect Existing Headers | required — see §1 |
| Caching Level | Standard | default |
| Bot Fight Mode | **Off** | intentional — see §2 |
| Security level | **`under_attack` — STILL ON as of 2026-08-17** | human-set, not the loop — see §526 |
| WAF custom rules | 4 — Common Exploit Paths, `WAF - SSL` (ACME skip), Meta, `Probe skip (FIX-1057)` | all enabled |
| TLS 1.3 | On | |
| Automatic HTTPS Rewrites | On | |
| Always Use HTTPS | **On** | corrected 2026-08-17; the doc said Off |
| Browser Integrity Check | On | |
| HSTS | Off | deliberate — preload is near-irreversible |
| Minimum TLS Version | 1.0 (default) | should be 1.2 |
| DNSSEC | Not enabled | disabled for the move, never re-enabled |
| Certificate Transparency Monitoring | **On since 2026-08-14** | free issuance alerts |

### The 2026-08-12 526 — an expired ORIGIN certificate, renewals failing silently

**2026-08-12, resolved the same day ~23:15 UTC.** `civitics.com` served Cloudflare **526
"Invalid SSL certificate"**. The cause was at the *origin*: Vercel's Let's Encrypt
certificate had **expired after renewals failed silently behind the Cloudflare proxy**. The
Cloudflare **edge** certificate was fine throughout, and the Vercel project was up the whole
time — the `civitics-civitics.vercel.app` URL kept serving normally, which is exactly why
nothing alerted (see below).

**Resolution:** Vercel dashboard → Settings → Domains → renew. It succeeded **without
gray-clouding**, i.e. the successful renewal also went through the proxy.

**Do not over-assert the mechanism.** Under Attack mode was the suspect — it 403s the
non-browser clients an ACME http-01 challenge relies on — but because the fix worked
*through* the proxy, the original renewal blocker is **UNCONFIRMED**. Treat "Under Attack
broke ACME" as a hypothesis, not the record.

**Same-day hardening, and what each part actually buys:**

| | |
|---|---|
| `WAF - SSL` skip rule on `/.well-known/acme-challenge/*` | removes the WAF as a possible blocker, whatever the original cause was |
| Under Attack off | **did not stick — see Pending; the zone is still `under_attack` as of 08-17** |
| CT Monitoring on (2026-08-14) | the real durable win: makes the *next* silent renewal failure visible |

**Next renewal window ≈ 60 days from 08-12, so ~mid-October 2026.** That is the date to
watch. If CT Monitoring is the only thing standing between a silent renewal failure and
another 526, confirm its alerts actually reach a watched inbox before then.

**Why nothing paged.** `platform-snapshot` — including the FIX-1026 request-path probe —
curls `civitics-civitics.vercel.app`, the Vercel origin. It is therefore **structurally
blind to every Cloudflare-layer failure** and stayed green through this entire outage. Same
blind spot as the 2026-08-11 522. Tracked as [[FIX-1057]]; the probe cannot simply be
repointed at `civitics.com` while Under Attack is on, because the probe itself gets 403.

**The second WAF rule is an ACME skip.** Certificate issuance and renewal validate over
`/.well-known/acme-challenge/*`, and that path must never be challenged, rate-limited or
mitigated — a blocked validation fails renewal silently and surfaces later as an edge
certificate error rather than as a WAF event. The skip rule exists so no present or future
security-level change can take the certificate path down with it. This is the one rule that
must survive any rule-surface cleanup (§3).

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

- [ ] **Turn Under Attack mode off — STILL OPEN, and re-verified on the live zone
      2026-08-17.** A planning note recorded this as done on 08-12; the zone says
      otherwise. `GET /zones/{id}/settings/security_level` returns `under_attack`, and
      `pipeline_state.cf_mitigation_loop.tripped` is **null**, which by §"How to tell an
      automatic change from a manual one" means the loop did **not** set it — this is a
      human setting still in force. The loop's own transition log agrees: on 2026-08-16 at
      06:08 and 06:12 UTC it recorded `skip_already_escalated` — *"3 breach hours, but the
      zone is already at security_level=under_attack and this loop did not set it."*
      Consequence, measured the same day: `curl https://civitics.com/`, `/officials` and
      `/api/officials/<id>/responsiveness` all return **403 `Cf-Mitigated: challenge`**,
      even with a browser User-Agent. That kept the FIX-1026 request-path probe pinned to
      the vercel.app origin until 2026-09-04, when [[FIX-1057]] shipped the narrow
      `Probe skip (FIX-1057)` WAF rule above and repointed it at civitics.com — the probe
      is no longer blocked, but **an external uptime service still is**, because that rule
      admits one client by a secret header rather than changing the posture. Turning Under
      Attack off remains the real test named in §2: watch Vercel Fluid CPU once
      `Common Exploit Paths` holds the line alone.
- [ ] **Rotate `PROBE_HEADER_SECRET` whenever the probe changes hands or leaks.** It lives
      in exactly two places — the `Probe skip (FIX-1057)` WAF rule expression and the
      GitHub Actions secret of the same name — and both must change in the same sitting.
      A mismatch does not fail open: the probe gets challenged and
      `.github/workflows/platform-snapshot.yml` goes red on a 403.
- [ ] **Add the FIX-799 Skip rule** for same-origin `RSC eq "1"` GETs, so managed challenge
      stops firing on the app's own soft navigations. More urgent while Under Attack is on.
- [ ] **Add a DMARC record** — `_dmarc.civitics.com` TXT, `v=DMARC1; p=none; rua=…` to
      start. SPF and DKIM without DMARC leave the domain spoofable.
- [ ] Minimum TLS → 1.2. ~~enable Certificate Transparency Monitoring~~ — **CT Monitoring
      enabled 2026-08-14**; the TLS minimum is still 1.0 and still one click.
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
