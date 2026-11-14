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

*Since 2026-10-12 there is one Transform Rule, `Origin auth (FIX-1305)`: security, not
caching. See §"Origin auth (FIX-1305)". The paragraph below still holds for caching.*

This is correct, not a casualty of the account move. FIX-796 moved CDN cache headers *out*
of `next.config.mjs` `headers()` and into per-response handler code, because config rules
are method- and status-blind — a config rule on an API path stamps POST responses and error
statuses just as happily as GET 200s (captured live on prod). Caching policy is owned by
`withPublicCdnCache`, not by the dashboard. Do not go looking for lost Cache Rules after a
future move.

The one custom rule that does exist is security, not caching:

> **Common Exploit Paths** — Block where URI Path contains `.php`, `wp-`, `.env`,
> `xmlrpc`, or `phpmyadmin`, **or the user agent is one of the Chrome 133–142 fleet's
> ten strings** (since 2026-11-14 01:34Z; below). 1 of 5 custom rules. Active.

**The fleet clause ([[FIX-1403]]).** Craig OR'd the farm's ten user agents into this
rule, option (2) of audit `docs/audits/2026-11-09-upstash-spend-census.md` §12.

- **When:** the rule's `last_updated` is **2026-11-14T01:34:46.93Z** (rule version 2,
  ruleset v6; API read, cc-276). That is Fri 11-13 17:34 PST. In the data, the fleet's
  last edge 200 and last origin request fall in the 01:34Z minute. From 01:35Z it has 0
  of each (census §16).
- **The expression, as live** (API read, cc-276):

  ```
  (http.request.uri.path contains ".php") or (http.request.uri.path contains "wp-") or (http.request.uri.path contains ".env") or (http.request.uri.path contains "xmlrpc") or (http.request.uri.path contains "phpmyadmin") or
  (http.user_agent in {"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36" "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36"})
  ```

- **The strings' source of truth is `CHROME_FLEET_UAS`**
  (`apps/civitics/src/lib/view-telemetry.ts`). cc-276 diffed the rule's set against it:
  the same ten, exact. A change to one is a change to both, by hand. The rule cannot
  read the code.
- **It matches exact strings only.** Any other user agent, including a stale Chrome on
  another version or OS, goes on to Under Attack's challenge as before. In the first 4 h
  after the Block, a spread of 24 other stale Chrome strings arrived from 136 IPs, one
  request each, and every one was challenged (census §16). A farm that rotates its
  strings leaves this clause behind.
- **The cost of a false positive is now a block.** A real Windows user whose browser
  sends one of the ten strings exactly gets Cloudflare's 403 on every path. Before the
  Block, the only cost was a `page_views` row labelled `chrome-133-142`. The zone's real
  Windows Chrome runs 155–157.
- **The probe moved off the set.** `Probe skip (FIX-1057)` skips Security Level only, so
  this clause applies to the probe like any other client. `egress-probe.yml`'s
  `browser_ua` is now Windows Chrome/157.
- **To reverse it:** in the dashboard, Security → WAF → Custom rules → `Common Exploit
  Paths`, delete the ` or (http.user_agent in {…})` clause and leave the five path
  clauses. Nothing in the app needs to change. The app-side flag ([[FIX-1404]], "The
  beacon routes" below) keeps labelling the fleet's views without the clause.

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
nothing about Cloudflare. That is the REQUEST path: the zone's analytics are readable as text
with `node scripts/cf-analytics.mjs` (edge traffic by hour, or `--by clientIP|userAgent`).

**The one scripted way through (cc-272):** a GitHub-hosted runner, carrying the
`x-civitics-probe` header that `Probe skip (FIX-1057)` matches. The dev box does not hold
`PROBE_HEADER_SECRET`; GitHub Actions does. `egress-probe.yml` sends it to a
`https://www.civitics.com/` URL and to no other host:

```
gh workflow run egress-probe.yml --ref main -f urls=https://www.civitics.com/api/cron/limiter-health
gh run view <id> --log      # the "Probe" step: status, server, cf-ray, x-civitics-ip-key, x-vercel-id
```

`cf-ray` present and a non-403 status mean the request crossed Cloudflare and reached
Vercel. A `403` with `cf-mitigated: challenge` means the header did not ride. The job holds
no `CRON_SECRET`, so a cron path answers 401; the middleware's `x-civitics-ip-key` stamp on
that 401 is the read (§Origin auth, "The limiter's key").

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
| WAF custom rules | **5** — Common Exploit Paths, `WAF - SSL` (ACME skip), Meta, `Probe skip (FIX-1057)`, `SearchBot` (FIX-1390) | all enabled; ruleset v6, last updated 2026-11-14T01:34:46Z, the fleet clause in Common Exploit Paths (API read, cc-276; v5 was 2026-11-09T05:05:18Z, cc-270). **All 5 Free slots are used**: the next rule (e.g. Pending's FIX-799 skip) must replace or merge one |
| TLS 1.3 | On | |
| Automatic HTTPS Rewrites | On | |
| Always Use HTTPS | **On** | corrected 2026-08-17; the doc said Off |
| Browser Integrity Check | On | |
| HSTS | Off | deliberate — preload is near-irreversible |
| Minimum TLS Version | 1.0 (default) | should be 1.2 |
| DNSSEC | Not enabled | disabled for the move, never re-enabled |
| Certificate Transparency Monitoring | **On since 2026-08-14** | free issuance alerts |
| Transform Rule: `Origin auth (FIX-1305)` | **On since 2026-10-12** (Craig); origin check **`enforce` since 2026-10-14 02:25Z** (cc-231) | stamps `x-civitics-origin`; the origin 403s a request without it — see §"Origin auth (FIX-1305)" |
| WAF custom rule: `Verified bots skip (FIX-1305)` | **does NOT exist** — the 10-12 row was a mis-record | the custom ruleset (API, 11-09: 4 rules, none of them this) and Transform Rules (Craig's dashboard, 11-08: only `Origin auth (FIX-1305)`) were both read. Verified bots pass Under Attack natively, so nothing was lost (cc-269 census §5, §10 item 4) |
| WAF custom rule: `SearchBot` ([[FIX-1390]]) | added 2026-11-09 05:05:18Z (Craig) | **Managed Challenge** where `(http.user_agent contains "ExaSearchBot") or (http.user_agent contains "KeenableBot")` — expression read from the entrypoint by API (cc-270). Two crawlers Cloudflare verifies as Search Engine Crawler, which is why Under Attack passed them. 24 h receipt: both at 0 origin-reaching (docs/audits/2026-11-09-upstash-spend-census.md §11). The planned name was `AI search crawlers (FIX-1390)`; the live one carries no id |

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
- [x] ~~**Flip `ORIGIN_AUTH_MODE` to `enforce` — cc-231.**~~ **Done 2026-10-14
      02:25:29Z** (deploy `cd866ff5`). 24 h of report mode logged zero `cf-ray=yes`
      misses against 26,221 zone requests. See §"Origin auth (FIX-1305)".
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

## Origin auth (FIX-1305)

**Every control on this page assumes traffic comes through this zone. On 2026-10-12 it
did not.** Two doors reach the Vercel origin around Cloudflare. cc-230 closes one with a
redirect and puts a check on the other, in report mode. cc-231 flipped the check to
enforce on 2026-10-14.

### The two doors

Probed by cc-229 (GET, 2026-10-12 23:35:27Z,
`docs/audits/2026-10-12-crawl-upstash-exhaustion.md` §G1):

```
alias  200
ip+host  307 https://www.civitics.com/officials
cf-path  403
ip+www  200
```

| line | request | reading |
|---|---|---|
| `alias` | `https://civitics-civitics.vercel.app/officials` | **Open.** Vercel's production alias, with no Cloudflare in the path. |
| `ip+host` | `--resolve civitics.com:443:76.76.21.21 https://civitics.com/officials` | The apex at Vercel's anycast IP 307s to `www`, which is the same door one hop later. |
| `ip+www` | `--resolve www.civitics.com:443:76.76.21.21 https://www.civitics.com/officials` | **Open.** Vercel serves the canonical host to anyone who resolves its IP themselves. |
| `cf-path` | `https://civitics.com/officials` | Control: the Under Attack 403 challenge. |

The 10-12 crawl came through the alias. Craig's Vercel log read named four **search
engines**: OAI-SearchBot, Googlebot, ExaSearchBot and DuckDuckBot, about 29 req/s
combined. They were indexing the alias as an un-canonicalised mirror, because the
entity pages carry no `alternates.canonical`. Cloudflare saw 0.4 % of that traffic.
The WAF, Under Attack and the FIX-1045 loop above were all blind to it, and the
limiter spent 357k Upstash commands on requests no edge control could see.

**Deployment Protection does not close the alias.** Vercel's Standard Protection lists
`civitics-civitics.vercel.app` among the PUBLIC production domains (Craig, dashboard,
2026-10-12). No Deployment Protection setting gates the alias without also gating
`www.civitics.com`. Do not go looking for that switch.

### The alias: a 308 to www, not a 403

The first statement of `apps/civitics/middleware.ts` 308s any request on the alias host
to the same path and query on `https://www.civitics.com`, with
`Cache-Control: public, max-age=3600`. The crawlers are wanted. A 403 would drop the
pages from their indexes. A 308 moves the index to `www`, where Cloudflare, the loop and
the limiter can see the traffic.

`/api/cron/*` is the one exemption, because Vercel's scheduler may call the production
deployment on the alias host. Every cron route checks the `CRON_SECRET` bearer itself.
That is therefore the redirect's one failure mode, and it is cheap to check:

```
curl -s -o /dev/null -w "alias-cron %{http_code}\n" https://civitics-civitics.vercel.app/api/cron/box-health
```

The answer must be **401**, which is the route's own gate. If it is a 308, the
scheduled jobs are being redirected, so revert the redirect.

Once on civitics.com, the crawlers meet Under Attack mode. Craig added a WAF custom rule
for that:

> **Verified bots skip (FIX-1305)** — Skip → **Security Level only**, where
> `(cf.client.bot)`.

It has the same shape as `Probe skip (FIX-1057)`, and for the same reason. It skips
Security Level only, so `Common Exploit Paths` still applies. `cf.client.bot` is
Cloudflare's verified-bot classification, not a User-Agent match, so Googlebot,
DuckDuckBot and OAI-SearchBot pass while a forged UA string does not. Whether
ExaSearchBot is on that list is unverified.

`robots.txt` also carries `Crawl-delay: 5` under `User-agent: *`. Googlebot ignores the
directive; the other three honour it.

- **AI Crawl Control** is the per-crawler allow/block lever, and the zone-side monitor
  for this bot class. Its baseline for the 24 h to 10-12 (Craig, dashboard) was Google
  422, OpenAI 312, Bing 135 and others 0, about 870 zone requests. The origin saw about
  445k in the same window, so 99.8 % bypassed the zone.
- **Bot Preference Sync stays OFF.** It prepends per-bot `User-agent` groups to
  robots.txt. A crawler that finds its own group ignores `*`, so the sync would silently
  drop FIX-513's `Disallow: /*?` and the `Crawl-delay` for every bot Cloudflare names.
  The repo's `apps/civitics/public/robots.txt` is the only robots.txt.

### The IP: an origin-auth header

A Transform Rule stamps a secret header on every request this zone forwards, and
middleware checks for it. The check keys on whether the request came through
Cloudflare, not on the hostname, so it closes the IP door. It would also close the
alias, which no longer needs it.

| | |
|---|---|
| Where | Rules → Transform Rules → **Modify Request Header** |
| Name | `Origin auth (FIX-1305)` |
| Expression | `(http.host contains "civitics.com")` |
| Action | **Set static**: header `x-civitics-origin`, value = the secret |

The secret is 32 random bytes (`openssl rand -hex 32`). It lives in exactly two places:
this rule and the Vercel env `ORIGIN_AUTH_SECRET` (Production scope only). The comparison
is constant-time, in `apps/civitics/src/lib/origin-auth.ts`. Middleware runs it after
the alias redirect and before the `BOT_PATTERNS` 404 and `checkRateLimit`, so a refused
request costs zero Upstash commands.

**The mode ladder** is set by the Vercel env `ORIGIN_AUTH_MODE` (Production scope). It
controls what happens to a request that arrives without the header:

| mode | a request without the header |
|---|---|
| `off`: the default. Also forced outside `VERCEL_ENV=production`, and whenever `ORIGIN_AUTH_SECRET` is unset | served; nothing logged |
| `report`: cc-230 to cc-231 | served, with `x-civitics-origin-check: miss` on the response; logs `[origin-auth] miss host=… path=… method=… cf-ray=yes\|no ua=…` on the first miss, then 1-in-100 per isolate |
| `enforce`: **since 2026-10-14 02:25:29Z** (cc-231) | 403 `{"error":"origin"}`, no-store; the same log line, with `refused` |

Middleware strips `x-civitics-origin` before it forwards the request
(`forwardRequest()`, cc-231), so no route handler ever sees the secret.

On a miss, `cf-ray=yes` means the request DID come through Cloudflare and the rule is
not stamping it. Fix the rule before enforcing. `cf-ray=no` is the direct-to-origin
traffic the check exists for. The only exemption is `/api/cron/*`, which the bearer
gates.

**Rotation.** Change the Transform Rule's value and the Vercel `ORIGIN_AUTH_SECRET` in
the same sitting, then redeploy: a Vercel env change reaches only new deployments. A
mismatch under `enforce` 403s civitics.com itself, for every real visitor. It is the
same class as the [[FIX-1057]] probe-secret rotation warning, with a far larger blast
radius. Under `report`, a mismatch only logs `cf-ray=yes` misses, so rotate while in
`report` if there is a choice.

**Both Vercel variables are `sensitive` type, so the dashboard never shows their values.**
cc-231's first flip edit landed on `ORIGIN_AUTH_SECRET` instead of `ORIGIN_AUTH_MODE`.
The next deploy then ran a secret that Cloudflare does not stamp, and report mode is the
only reason no visitor was refused. Before any redeploy that follows an edit here,
confirm that only the intended variable moved. The Vercel API's env metadata
(`GET /v9/projects/{id}/env`, the `updatedAt` per key, never the value) answers this
from the terminal. After a secret change, prove the new value in `report` mode before
enforcing: the deploy should show zero `cf-ray=yes` lines across a platform-snapshot
run, and an IP-door probe should log its first `cf-ray=no` miss.

### The limiter's key (FIX-1401)

**Behind this zone, `x-forwarded-for` is the Cloudflare edge, not the visitor.** Vercel
overwrites `x-forwarded-for` and `x-real-ip` with the TCP peer (cc-270's alias spoof
test), and through Cloudflare the TCP peer is the edge. On 2026-11-12 the www probe
(`egress-probe.yml`, runs 43136758112 and 43137094913, through IAD and ORD) read
`x-civitics-ip-key: cf=differs; key=xff`. Until cc-272, every visitor through one PoP
shared one limiter bucket.

The limiter now keys on **`cf-connecting-ip`** when, and only when,
`ORIGIN_AUTH_MODE=enforce` and the request carried the origin secret above
(`provedCloudflare` in `apps/civitics/src/lib/origin-auth.ts`). That proof is what makes
the header trustworthy. Vercel passes a client-sent `cf-connecting-ip` through untouched,
but only a request that crossed this zone carries the Transform Rule's secret.

- **IPv6 keys on its /64**: the first four hextets of the expanded address, lower case
  (`2001:0db8:000a:000b::/64`). One subscriber's prefix is one bucket, so rotating
  addresses inside it neither dodges the cap nor spends a first-in-window command per
  address. IPv4, and IPv4-mapped IPv6, is used whole.
- **Set the mode back to `report` or `off` and the key falls back** to the old chain
  (`x-forwarded-for` → `x-real-ip` → `unknown`): per-edge buckets again, never a
  forgeable key. The same holds outside production and when `ORIGIN_AUTH_SECRET` is unset.
- **What it costs.** Per-client keys are sparser than per-edge ones, so more checks are
  first-in-window. Under the fixed window (FIX-1391) that moves k toward 3 Upstash
  commands a check, not toward 2.13.

**Reading it.** Every answer from `/api/cron/limiter-health` carries
`x-civitics-ip-key: cf=<absent|same|differs>; key=<xff|real|cf|unknown>`, the 401
included. `cf` compares `cf-connecting-ip` with `x-forwarded-for`'s first hop, and `key`
names the header the limiter would key this request on. The stamp is a class, never an
address. Through www it should read `cf=differs; key=cf`. Through the alias it reads
`cf=absent; key=xff`, because the alias carries no origin secret. With the `CRON_SECRET`
bearer, the same path returns the limiter's health block from the middleware's own
isolate (FIX-1402). Each bearer call forces one budget-flag read, which is one Upstash
GET.

### The beacon routes (FIX-1404, FIX-1405, FIX-1406)

**The same proxy fact reaches the telemetry.** One route writes a row per page load:
`/api/track-view` (`page_views`). Its rules live in
`apps/civitics/src/lib/view-telemetry.ts`. The second beacon,
`/api/platform/web-vitals` (`web_vitals_samples`), was removed by FIX-1406 (cc-275):
the table had no reader, and Vercel Speed Insights already collects field vitals.

- **The fleet rule.** The Chrome 133–142 farm (audit
  `docs/audits/2026-11-09-upstash-spend-census.md` §12) is ten exact Windows Chrome
  strings, listed in `CHROME_FLEET_UAS`. `track-view` writes its views with
  `is_bot = true` and `bot_name = 'chrome-133-142'`. The row is still written, so
  `get_pv_bots` shows it by name and every `is_bot = false` reader drops it. A match
  is exact equality after `trim()`.
  - **To add or retire a string,** edit the set and its test
    (`view-telemetry.test.ts`, which pins the size at ten), and the fleet clause of
    `Common Exploit Paths` (§3) by hand in the dashboard.
  - **A false positive** is a real Windows user on one of those releases. Here, their
    view is labelled a bot. Since 2026-11-14 01:34Z the same ten strings are also
    blocked at the edge (§3, "The fleet clause"), so such a user is stopped by a 403
    before the route runs. The flag is what still applies if that clause is removed.
  - **Craig's reversal**, not run: `UPDATE page_views SET is_bot = false, bot_name =
    NULL WHERE bot_name = 'chrome-133-142';`. It restores the view counts, but not
    `device_type` or `browser`, which bot rows never carry. The vitals samples the
    rule skipped between FIX-1404 and FIX-1406 were never stored.
- **The country rule.** `x-vercel-ip-country` geolocates the TCP peer, which behind
  this zone is the Cloudflare edge (the same root cause as the limiter's key).
  `page_views.country_code` now reads **`cf-ipcountry`** first:
  - present → the value upper-cased, when it is two letters and not `XX`; otherwise
    null (`T1`, Tor, is null too);
  - never `x-vercel-ip-country` when `cf-ipcountry` is present, because that value
    is the edge's;
  - absent (the alias, a preview, local) → `x-vercel-ip-country`, as before.

  The header depends on the zone's **Network → IP Geolocation** setting being on.
  Under `ORIGIN_AUTH_MODE=enforce`, every production request the route sees crossed
  this zone. Under `report` / `off`, a client could send the header itself. The stake
  is a country label on an internal dashboard.

## If the zone ever moves accounts again

Cloudflare moves the registration and lets you re-import DNS. **It moves nothing else.**
SSL/TLS mode, edge certificates, every rule type, WAF rules, Bot Fight Mode, Browser Cache
TTL, HSTS, DNSSEC, Email Routing rules and notifications all reset to a fresh-zone baseline,
and analytics history stays with the old zone. Re-read §1–§4 and the posture table above
before assuming anything survived.
