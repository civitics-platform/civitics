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

⚠️ `docs/ARCHITECTURE.md` (request-flow diagram + the "Layer 1" abuse-defense list) and
`docs/OPERATIONS.md` still describe Bot Fight Mode as ON and credit it with eliminating the
PHP/WordPress scanner traffic that was burning Vercel Fluid CPU. **That is stale.** The job
is now carried by the `Common Exploit Paths` WAF custom rule (below), which targets the
same traffic more precisely. Watch Vercel Fluid CPU after Under Attack mode goes off — that
is the real test of whether the custom rule alone holds the line.

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
- [ ] Correct the stale Bot Fight Mode claims in `docs/ARCHITECTURE.md` and
      `docs/OPERATIONS.md` (see §2).

## If the zone ever moves accounts again

Cloudflare moves the registration and lets you re-import DNS. **It moves nothing else.**
SSL/TLS mode, edge certificates, every rule type, WAF rules, Bot Fight Mode, Browser Cache
TTL, HSTS, DNSSEC, Email Routing rules and notifications all reset to a fresh-zone baseline,
and analytics history stays with the old zone. Re-read §1–§4 and the posture table above
before assuming anything survived.
