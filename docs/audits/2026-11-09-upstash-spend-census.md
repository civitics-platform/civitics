# Upstash spend census — 2026-11-02 → 2026-11-08 (cc-269)

**Question (Craig, Sun 11-08 18:16 PST):** "upstash had significant usage over the
last week (40k Thu, 22–30k Fri-Sat-Sun) — on track to blow through our usage —
think it has some to do with the bots that are getting through to vercel."

**Answer.** Yes, and the bots have names. Since **10-23 23:00Z** a flat crawl
reaches the origin at ~650 requests/hr, about 7× the mid-October level and 21 %
of the 3,000/hr trip that would set off the mitigation loop. Of its bucketed entity-page GETs, **70.5 % are two
crawlers Cloudflare verifies as "Search Engine Crawler"**: ExaSearchBot (all 256
IPs of `172.245.122.0/24`) and KeenableBot (~20 Google Cloud IPs). Under
Attack mode lets them through, and each one costs the edge limiter **~4.1
Upstash commands** to allow. The limiter is **92 %** of the spend. It issued
**zero 429s** all week: no IP came within 50× of a cap. The drizzle began 8 days
before anyone could see it, because October's quota had been frozen since the
10-12 crawl. The 11-01 reset revealed it. It did not start it.

Prod contact: read-only. Two `db-query --prod` reads of `platform_usage_snapshot`
and one of `pipeline_state` (each under `SET LOCAL statement_timeout = '30s'`).
38 Cloudflare GraphQL Analytics queries, two Cloudflare REST GETs with the
existing token (security level, custom-rules entrypoint), and the zone-id lookup
(`GET /zones?name=civitics.com`, the same call `cf-analytics.mjs` makes) once
per script run, 10 in all. No write anywhere: not prod, Upstash, Cloudflare or Vercel.
Scratch scripts: `cc269-cf.mjs` / `cc269-cf-analyze.mjs` / `cc269-read4.mts` in the session
scratchpad (not committed); every number below is reproducible from the queries
they print.

---

## §1 The model and the floor (read 0)

**Unit cost, from the installed library — not the 3 the prompt assumed.**
`apps/civitics/src/lib/ratelimit.ts:167-174` builds every bucket as
`Ratelimit.slidingWindow(cfg.tokens, cfg.window)`, `analytics: false`. The
installed package is `@upstash/ratelimit` **v2.0.8**
(`node_modules/.pnpm/@upstash+ratelimit@2.0.8_@upstash+redis@1.38.0`). Its
single-region `slidingWindowLimitScript` runs `GET currentKey`, `GET previousKey`,
then — only when allowed — `INCRBY currentKey`, plus `PEXPIRE` when that INCRBY
created the key (the identifier's first request in its 1-minute window), inside
one `EVALSHA` (`safeEval` falls back to `EVAL` only on `NOSCRIPT`). Upstash's own
costs page (`upstash.com/docs/redis/sdks/ratelimit-ts/costs`), quoted:

| Cache Result | Algorithm State | Command Count | Commands |
|---|---|---|---|
| Hit/Miss | First | 5 | EVAL, GET, GET, INCR, PEXPIRE |
| Hit/Miss | Intermediate | 4 | EVAL, GET, GET, INCR |
| Miss | Rate-Limited | 3 | EVAL, GET, GET |
| Hit | Rate-Limited | 0 | _utilized cache_ |

So an **allowed** check is 4–5 commands. The "3" is the rate-limited row, and
this week nothing was rate-limited. Fixed window is 3 (first) / 2 (intermediate)
/ 2 (rate-limited). The FIX-1304 flag adds one `GET` per isolate's first check,
then one per ≥ 200 checks AND ≥ 60 s (`ratelimit.ts:373-374`, `refreshBudgetIfDue`).

**Which requests are checked** (`apps/civitics/middleware.ts`, copied verbatim
into the classifier). Order: alias 308 → origin-auth door (403) → `BOT_PATTERNS`
404 → `/agencies/<uuid>` 308 → malformed-UUID 404s (`/jurisdictions/<x>`,
`/(districts|officials|proposals|meetings)/<x>`) → `getRateLimitBucket` →
`checkRateLimit`. Everything before the bucket costs zero. The matcher excludes
`_next/static|_next/image|favicon.ico|*.svg|png|jpg|jpeg|gif|webp`, so those never
run middleware at all. Buckets: `/api/search*` → `search`;
`/api/graph/narrative*` → `graph_ai`; `/api/graph*` → `graph`; mutating verbs on
`^\/api\/(comments|positions|statements)(\/|$)` → `write`; GET on
`^\/(jurisdictions|districts|officials)\/[^/]+` → `entity_leaf`; GET on
`^\/(jurisdictions|officials|proposals|institutions|agencies|districts|meetings|donors|initiatives|investigations)\/[^/]+`
→ `entity_pages`. A prefetch-tagged GET (`Sec-Fetch-Dest: empty`,
`Sec-Purpose: prefetch`, …) of either family goes to `entity_prefetch`. A HEAD
is not a GET and is not checked.

**The flat floor** — every non-limiter caller of Upstash, from the tree:

```
F = ring 2,160 + arm 96 + snapshot probe 192 + receipts 1  =  2,449 commands/day
```

- **Ring:** 3 commands per sample × 720 samples/day. `box-health-store.ts:96`
  `BOX_HEALTH_COMMANDS_PER_SAMPLE = 2` (LPUSH + LTRIM, `:429-434`) **plus**
  `:98` `BOX_HEALTH_HEAD_READS_PER_SAMPLE = 1` (the LINDEX head read FIX-1375 added,
  `runBoxHealth` → `readBoxHealthHead`, `:578`). The cadence is `*/2`
  (`apps/civitics/vercel.json` `/api/cron/box-health`). The head read landed in
  `5d23037f` (11-03 02:49Z). Before that the ring was 2/sample, so F was
  **1,729** on 11-02 and ~2,365 on 11-03.
- **Arm:** 1 `MGET` per tick (`front-door-restart.ts:333`), plus a pipeline only
  on a DOWN tick (`:350`). The cadence is **`*/15`**: `vercel.json` schedules
  `/api/cron/front-door-watch` at `*/15 * * * *`, and the route's own header
  says "Fires every 15 minutes". That gives 96/day. The `*/2` / "~25k/month" in
  `upstash-usage.ts:440` is stale.
- **Snapshot probe:** `*/30` (`/api/cron/platform-snapshot`). 3 PINGs
  (`PROBE_ATTEMPTS`, `upstash-usage.ts:53-57`: "3 commands × 48 ticks =
  144/day"), plus 1 flag `SET`/`DEL` per tick (`platform-snapshot.ts:631-639`):
  4 × 48 = 192/day.
- **Receipts:** one `LRANGE` per nightly (`receipts-daily.ts:898`).
  `data:box-health:series` is by hand only.
- **Per request, ~0:** `auth/actions.ts`' `auth_send_ip` / `auth_send_email` run
  only on an OTP send.
- **No other caller.** Grepping `apps packages` for `upstashRequest | new Redis( |
  UPSTASH_REDIS_REST_URL` finds only the files above. The `SET … latest`
  duplicate is **gone** (cc-153; `offBoxCommands` is LPUSH + LTRIM only).

**The model under test:** `commands/day ≈ k × B + F`, where B is the day's
bucketed origin-reaching requests. k should be 4–5. The prompt's 3 is tested
alongside.

---

## §2 The Upstash curve and the projection (read 2a, 2b)

437 snapshot rows from 10-31T00:01Z to 11-09T03:31Z. `payload.upstash.usage` is
present on all 437. The key names match the prompt
(`platform-snapshot.ts:259-282`): `usage.{used_commands, daily_commands,
limit_commands, used_pct, plan, auto_upgrade, read_commands, write_commands}`,
`state`, `budget.{pct, used, state, commands, flag_written, flag_error}`.
`daily_commands` resets at 00:00Z: every day's 00:01Z row reads 0–16.

**(2a) by UTC day.** The day total is the day's last `daily`, read at ~23:31Z.
It misses the last ≤ 29 min, ~2 %.

| UTC day | day total (`daily` @23:31) | last `used` | Δ`used` vs prior day | agree? | state |
|---|---:|---:|---:|---|---|
| 10-31 | 209 | 503,289 | — | — | quota_exhausted (October spent) |
| 11-01 | 23,964 | 22,171 | reset | — | healthy |
| 11-02 | 19,774 | 40,686 | 18,515 | ✓ −6 % | healthy |
| 11-03 | 31,413 | 72,568 | 31,882 | ✓ | healthy |
| 11-04 | 34,314 | 110,870 | 38,302 | ✓ +12 % (lag) | healthy |
| 11-05 | **40,406** | 151,914 | 41,044 | ✓ | healthy |
| 11-06 | 30,253 | 183,121 | 31,207 | ✓ | healthy |
| 11-07 | 22,206 | 205,521 | 22,400 | ✓ | healthy |
| 11-08 | 24,347 | 229,954 | 24,433 | ✓ | healthy |
| 11-09 (to 03:31Z) | 4,758 | 235,893 | — | — | healthy |

- **The reset:** `10-31T23:31:07Z used=503,289 quota_exhausted` →
  `11-01T00:00:58Z used=0 daily=6 healthy`. It is calendar again, not the 13th
  anchor `created_at` implies (FIX-1314's finding, re-observed).
- **FIX-1313's step lag:** `used` moves in 3 h steps at :01 past 01, 04, 07, …,
  22Z (11-07, 11-08). Δ`used` therefore lumps a 21:00–24:00 tail into the next
  day. That is why 11-04 reads +12 % and 11-02 −6 %. The sums agree:
  Σ`daily` 11-01…11-08 = 226,677, against `used` at 11-09 00:01Z = 231,725.
  The ~5k difference is the eight ≤ 29-min tails.
- **Latest:** `11-09T03:31:07Z used=235,893 / lim=500,000 = 47.18 %`,
  `plan=free`, `auto_upgrade=false`, `state=healthy`,
  `budget={pct 70, commands 350,000, state clear, flag_written true}`. Every row
  since 11-01 reads `budget clear / flag_written true`. **The hold has never
  engaged**, so D4's record branch does not apply.
- **October, for context** (a second read of the same table, 10-01 → 10-30):
  `daily` 55,657 (10-10) → 68,779 (10-11) → **307,396 (10-12)**, `used` 499,669
  on 10-12. From then on `used` was frozen at 499,7xx–503,068 and `daily` was
  41–463/day through 10-30. **The limiter, ring and arm sat on the quota for 19
  days.** That is why the drizzle below was invisible until 11-01.

**(2b) The projection.** Start: `used` ≈ 236,483 at 11-09T03:31Z. That is the
00:01Z `used` of 231,725 plus today's `daily` of 4,758, since the 02:31Z step
reading lags.

| rate | commands/day | → 350,000 (FIX-1304 hold) | engages by (+3 h step + 30 min probe) | → 500,000 (only if the hold fails) |
|---|---:|---|---|---|
| (i) 7-day mean, 11-02…11-08 = 202,713 / 7 | 28,959 | 113,517 / 28,959 = 3.920 d → **11-13 01:35Z** | 11-13 05:05Z | 263,517 / 28,959 = 9.100 d → 11-18 05:54Z |
| (ii) max day (11-05) | 40,406 | 113,517 / 40,406 = 2.809 d → **11-11 22:56Z** | 11-12 02:26Z | 263,517 / 40,406 = 6.522 d → 11-15 16:02Z |
| (iii) last 3 days, 11-06…11-08 = 76,806 / 3 | 25,602 | 113,517 / 25,602 = 4.434 d → **11-13 13:55Z** | 11-13 17:25Z | 263,517 / 25,602 = 10.293 d → 11-19 10:32Z |

- If the hold works at (i), the limiter takes the memory path from ~11-13 for
  the rest of the month (~17.9 days). Only the floor spends after that:
  350,000 + 2,449 × 17.9 ≈ **394k at 12-01**. The quota is not exhausted, and
  the ring and the arm keep writing. That is FIX-1304's design, and it would be
  its first real engagement.
- The 500k column happens only if the flag never lands. Example: the probe's
  `SET` refused, or the TTL lapsing for 2 h with no probe.

---

## §3 Origin-reaching by hour, and the step (read 2c, 3f)

`payload.cloudflare_edge.hours[]` flattened and deduped on `hour`, with the
newest row winning: 222 complete hours from 10-30T21Z to 11-09T02Z, **no gaps**
from 10-31 to 11-08. The hourly half's 17 h hole is not in this window. 15
snapshot rows carry an `error`: 14 are `vercel: HTTP 404: costs_not_found`
(11-01 00:00–06:30Z), and 1 is `supabase_sql: Could not query the database for
the schema cache` (11-02 04:32Z). None of them touches the Upstash or Cloudflare
blocks.

| UTC day | origin | edge | max hour | hours ≥ 1,000 | hours ≥ 3,000 (trip) |
|---|---:|---:|---|---:|---:|
| 10-31 | 9,255 | 30,712 | 1,198 @23Z | 1 | 0 |
| 11-01 | 22,747 | 57,429 | 1,313 @06Z | 10 | 0 |
| 11-02 | 13,757 | 33,812 | 1,158 @12Z | 2 | 0 |
| 11-03 | 14,865 | 32,236 | 1,220 @11Z | 1 | 0 |
| 11-04 | 15,548 | 39,826 | 1,075 @01Z | 2 | 0 |
| 11-05 | 16,477 | 41,006 | **1,721 @16Z** | 3 | 0 |
| 11-06 | 15,163 | 39,356 | 1,515 @07Z | 3 | 0 |
| 11-07 | 12,351 | 28,613 | 1,232 @12Z | 2 | 0 |
| 11-08 | 19,787 | 52,245 | 1,279 @14Z | 8 | 0 |

The prompt's step rule picks **11-01 04:00Z**: the first hour above 2× the
10-31→11-04 median of 602. That baseline is inside the drizzle, so the rule
dates the Upstash reset, not the traffic. The October read places the real step:

| UTC day | 10-13 | 10-14 | 10-15 | 10-16 | 10-17 | 10-18 | 10-22 | 10-23 | **10-24** | 10-25 | 10-26 | 10-27 | 10-28 | 10-29 | 10-30 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| origin/day | 2,612 | 2,464 | 2,078 | 2,068 | 2,038 | 1,826 | 2,664 | 4,454 | **22,696** | 15,847 | 21,730 | 23,232 | 17,139 | 16,429 | 22,197 |

By hour: `10-23T22Z = 209 → 10-23T23Z = 1,028`, then 855–1,329 every hour of
10-24 (median ~960). It is a step to a plateau, not a ramp: a scheduled crawler
switching on. 10-19 → 10-21 (4.3k–7.1k, with a 106,316-edge 10-19) is a separate,
shorter episode.

**(3f) The drizzle began 10-23 23:00Z. Nothing in the deploy list coincides.**
`git log --first-parent --since 2026-10-22 origin/main` minus `[skip vercel]`
shows only docs / receipts / FIXES commits from 10-23 02:00Z to 10-25. The
nearest `apps/civitics` commit before the step is FIX-1337 (`e32bb326`, 10-23
01:15Z, 22 h earlier): the gha-dispatch nightly-request target, a cron route
and not a public page. Before it came FIX-1316 (10-16), FIX-1304 / FIX-1308
(10-15) and FIX-1305's enforce flip (10-14). None changes a public page, the
sitemap or robots. The first public-surface change after the step is FIX-1306
(`b8010cc0`, 11-01 00:23Z: canonical URLs + the sitemap's origin constant). The 11-05 01:59Z restart and cc-262's sampler
(`5d23037f`, 11-03 02:49Z) are later still. Who started it on 10-23 is past
Cloudflare's 8-day retention. This week's 53 %-of-checks crawler (§4) is the
**candidate**, not a finding.

---

## §4 The population (read 3a–3e)

Cloudflare GraphQL, `httpRequestsAdaptiveGroups`, one UTC day per query
(Free-zone 1-day clamp), 11-02 → 11-08. 11-01 is past the 8-day retention
("1w1d", `cloudflare-analytics.ts:36`) for a 00:00Z start and was not queried.
"Origin-reaching" means `originResponseStatus_gt: 0`. That is the definition
the snapshot and the loop use (`cloudflare-analytics.ts:256`), and the right
population here: a challenged request, or one Cloudflare serves from cache,
never reaches middleware. **The 10,000-row group cap never bound.** The largest
day had 7,909 distinct origin-reaching paths, so path counts are complete, not
floors.

**(3a) Cross-check.** GraphQL origin-reaching vs 2c: 13,756 / 13,757 · 14,865 /
14,865 · 15,547 / 15,548 · 16,477 / 16,477 · 15,160 / 15,163 · 12,351 / 12,351 ·
19,787 / 19,787. They agree within 3 requests a day. Cloudflare cache hits were
28–1,707/day.

**(3b) Path families → B → the residual.** Every origin-reaching path was run
through the verbatim middleware sequence. Method comes from per-family
`clientRequestPath_like` queries with the method dimension: **every
entity-family request this week was a GET** (one POST on `/donors`), and all
1,422 requests on the write paths were GETs, so `write` = 0. The prefetch split
(`entity_prefetch`) is invisible here, because the analytics carry no request
header. It is counted inside leaf and pages.

| UTC day | entity_leaf | entity_pages | api (search+graph) | **B** | F | `daily` (full-day ≈ ×1440/1411) | 3B+F (resid) | **4B+F (resid)** | 5B+F (resid) | implied k |
|---|---:|---:|---:|---:|---:|---:|---|---|---|---:|
| 11-02 | 1,692 | 3,176 | 15 | 4,883 | 1,729 | 20,180 | 16,378 (+23.2 %) | 21,261 (**−5.1 %**) | 26,144 (−22.8 %) | 3.78 |
| 11-03 | 3,261 | 3,783 | 15 | 7,059 | 2,365 | 32,059 | 23,542 (+36.2 %) | 30,601 (**+4.8 %**) | 37,660 (−14.9 %) | 4.21 |
| 11-04 | 2,265 | 5,358 | 15 | 7,638 | 2,449 | 35,019 | 25,363 (+38.1 %) | 33,001 (**+6.1 %**) | 40,639 (−13.8 %) | 4.26 |
| 11-05 | 2,358 | 6,437 | 0 | 8,795 | 2,449 | 41,236 | 28,834 (+43.0 %) | 37,629 (**+9.6 %**) | 46,424 (−11.2 %) | 4.41 |
| 11-06 | 2,668 | 4,627 | 45 | 7,340 | 2,449 | 30,875 | 24,469 (+26.2 %) | 31,809 (**−2.9 %**) | 39,149 (−21.1 %) | 3.87 |
| 11-07 | 1,843 | 3,503 | 3 | 5,349 | 2,449 | 22,662 | 18,496 (+22.5 %) | 23,845 (**−5.0 %**) | 29,194 (−22.4 %) | 3.78 |
| 11-08 | 2,194 | 2,811 | 19 | 5,024 | 2,449 | 24,847 | 17,521 (+41.8 %) | 22,545 (**+10.2 %**) | 27,569 (−9.9 %) | 4.46 |
| **week** | 16,281 | 29,695 | 112 | **46,088** (6,584/day) | 16,339 | 206,878 (29,554/day) | | | | **4.13** |

**Verdict on the model:** `commands ≈ 4B + F` holds within ±10.2 % on every
day, which confirms the unit cost at **~4 per allowed check** (4.13 measured).
**3B + F is rejected:** it under-predicts by 22–43 %, more than +30 % on four of
seven days. The residual is not a hidden caller. It is the INCRBY that only an
allowed check pays, plus a PEXPIRE share of ~13 %. That share is lower than this
crawl's sparseness predicts; see §10, item 13. The limiter's share of the week:
(206,878 − 16,339) / 206,878 = **92.1 %**.

Entity-family shapes, 7 days: `/donors/<id>` **19,842** (43 % of B) ·
`/officials/<id>` 12,283 · `/proposals/<id>` 9,497 (4,176 of them answered 307 by
the page, after the check) · `/jurisdictions/<id>` 3,992 · `/institutions/<id>`
342 · `/investigations/<id>` 8 · `/initiatives/<id>` 7 · `/agencies/<uuid>` 19,
all `guard308`, which costs 0. Unbucketed origin traffic is mostly the app's own
beacons: `/api/platform/web-vitals` 8,337 · `/api/notifications` 3,748 (401) ·
`/_vercel/insights/view` 3,528 · `/api/track-view` 2,943. Static traffic is led by
`/favicon.ico` at **25,012 origin requests in 7 days, every one answered 404**.
That costs 0 commands but is a real origin hit. It is noted, not chased.

**(3c) Who — the UA ladder.** These are the bucketed entity GETs only, which
is the population that spends. 49 distinct UAs; the top 5 cover 89.3 %.
`verifiedBotCategory` is readable on this Free zone (query 37, 11-08); it is
quoted where Cloudflare set it.

| # | requests (7 d) | share | UA (as seen) | class | CF `verifiedBotCategory` |
|---:|---:|---:|---|---|---|
| 1 | 24,534 | 53.3 % | `Mozilla/5.0 (compatible; ExaSearchBot/1.0; +https://crawler.exa.ai/)` | verified-bot family (Exa) | Search Engine Crawler |
| 2 | 7,907 | 17.2 % | `… (KHTML, like Gecko; compatible; KeenableBot/1.0; +https://keenable.ai/bot)` | verified-bot family (Keenable) | Search Engine Crawler |
| 3 | 4,129 | 9.0 % | `… Nexus 5X … Chrome/153.0.8010.52 Mobile Safari/537.36 (compatible; Googlebot/2.1; …)` | verified-bot family (Googlebot) | Search Engine Crawler |
| 4 | 3,337 | 7.3 % | `… compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/116…` | verified-bot family (Bingbot) | Search Engine Crawler |
| 5 | 1,172 | 2.5 % | `Mozilla/5.0 (Windows NT 10.0; Win64; x64) … Chrome/142.0.0.0 Safari/537.36` | browser | — |
| 6 | 576 | 1.3 % | `… Chrome/131.0.0.0 Safari/537.36; compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot` | verified-bot family (OpenAI) | Search Engine Crawler |
| 7–15 | 465 · 437 · 419 · 413 · 406 · 402 · 400 · 396 · 371 | 8.2 % | `… (Windows NT 10.0; Win64; x64) … Chrome/1{39,33,40,35,41,34,38,36,37}.0.0.0 Safari/537.36` | browser (rotating) | — |

By class (bucketed): verified-bot family **88.6 %** (Exa + Keenable alone
70.5 %; Google 9.8 %, Bing 7.3 %, OpenAI 1.3 %), browser 11.1 %, blank/library
0. **Edge→origin pass rate:** ExaSearchBot 24,621 edge → 24,583 origin (99.8 %),
KeenableBot 7,947 → 7,945. Under Attack challenges neither of them. The ten
"Windows Chrome 133…142" UAs are a different shape. They pass at ~30 %
(51,482 edge → 15,405 origin for Chrome/142), the challenged rest show as edge
403s from US/SG/IN/BR/DE, and at origin they hit the app's beacons
(`/favicon.ico`, web-vitals, `_vercel/insights`, `/api/notifications` 401). That
is a JS-executing client, so a browser farm or real browsers. They are only
~11 % of checks, so they are not the Upstash story. All origin traffic, by
class: browser 58.4 %, other-bot 30.2 % (Exa + Keenable, which my
family-classifier did not list by name), Google 4.7 %, Bing 3.2 %, curl 2.9 %.

Candidate join: KeenableBot's day counts track the ~20 Google Cloud IPs below
(11-02 2,173 vs 1,803; 11-06 2,665 vs 2,337; 11-07 2,194 vs 1,858). That makes
it a **candidate**, not a join.

**(3d) The IP ladder.** Bucketed entity GETs: **5,382 distinct IPs** over the
week; top 10 → 14.7 %, top 100 → 42.7 %, top 500 → 89.4 %. Prefixes:

| prefix | requests | share | IPs | who (candidate) |
|---|---:|---:|---:|---|
| `172.245.122.0/24` | 24,517 | 53.3 % | **256** (every address) | ExaSearchBot (24,534 by UA) |
| `66.249.79.0/24` | 4,495 | 9.8 % | 11 | Googlebot |
| `40.77.167.0/24` | 1,966 | 4.3 % | 63 | Bingbot |
| `52.167.144.0/24` | 1,360 | 3.0 % | 56 | Bingbot |
| `34.x / 35.x / 104.154–198.x / 136.x` (GCP) | ~7,700 | ~17 % | ~20, one per /24 | KeenableBot |

**Is any single IP near a cap? No.** The busiest is `66.249.79.32` (Googlebot)
with 1,237 entity GETs on 11-03: **0.86/min** against the strictest cap of
45/min, **52× under**. An Exa address averages 24,517 / 256 / 7 / 1,440 ≈
**0.01/min**, about 4,700× under. On 08-15 the busiest IP ran at 1.82/min. This
crawl is wider and slower still, and it defeats per-IP limiting by arithmetic.

**(3e) The status mix.** **HTTP 429 = 0 on every day, at the edge and at the
origin.** The limiter allowed everything it checked: the 08-15 shape, every
command spent issuing allows.

| UTC day | edge | origin | origin 200 | 304 | origin 403 (door) | edge 403 (CF) | origin 404 | 307 | 308 | 401 | 5xx | **429** |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 11-02 | 33,811 | 13,756 | 7,617 | 1 | 0 | 10,917 | 3,803 | 1,206 | 1 | 685 | 443 | **0** |
| 11-03 | 32,227 | 14,865 | 10,681 | 84 | 0 | 9,166 | 3,142 | 271 | 2 | 660 | 24 | **0** |
| 11-04 | 39,816 | 15,547 | 10,658 | 181 | 0 | 14,028 | 4,059 | 132 | 4 | 499 | 14 | **0** |
| 11-05 | 41,006 | 16,477 | 11,847 | 5 | 0 | 13,590 | 3,980 | 210 | 5 | 383 | 47 | **0** |
| 11-06 | 39,367 | 15,160 | 11,067 | 0 | 0 | 12,169 | 1,857 | 1,442 | 2 | 784 | 8 | **0** |
| 11-07 | 28,613 | 12,351 | 7,923 | 7 | 0 | 7,905 | 2,667 | 1,184 | 3 | 533 | 34 | **0** |
| 11-08 | 52,248 | 19,787 | 12,521 | 11 | 0 | 17,114 | 5,514 | 313 | 7 | 1,405 | 16 | **0** |

The origin door refused nothing that came through Cloudflare (origin 403 = 0).
Edge 403s are Cloudflare's challenge / Common Exploit Paths, at 27–36 % of edge.
The origin 404s are mostly `/favicon.ico`.

---

## §5 The edge today (read 4)

- `GET /zones/{zone}/settings/security_level` (the loop's
  `getZoneSecurityLevel()`): **`{"level":"under_attack","modified_on":"2026-08-15T22:03:19.215781Z","editable":true}`**.
- `pipeline_state.cf_mitigation_loop`: **`tripped: null`**, `breaches: []`,
  `transitions: []`, `scope_probe.writable: true` (checked 11-08 16:00:51Z). The
  level is **Craig's**, set 08-15, not the loop's. FIX-1039 is still the open item.
- `GET /zones/{zone}/rulesets/phases/http_request_firewall_custom/entrypoint`:
  **HTTP 200** (the token has the scope). `last_updated 2026-09-04T01:48:03Z`,
  **4 rules**:
  1. `Common Exploit Paths` — block — path contains `.php` / `wp-` / `.env` / `xmlrpc` / `phpmyadmin`
  2. `WAF - SSL` — skip (securityLevel, waf, bic, …) — `starts_with(http.request.uri.path, "/.well-known/acme-challenge/")`
  3. `Meta` — **block** — `(http.user_agent contains "meta-webindexer")`
  4. `Probe skip (FIX-1057)` — skip `securityLevel` — the `x-civitics-probe` header (value not printed)

  **`Verified bots skip (FIX-1305)` is not in this phase.** `docs/CLOUDFLARE.md`
  §Posture records it as "added 2026-10-12 (Craig) — not script-verified", but
  the entrypoint has not changed since 09-04. Verified bots pass Under Attack
  anyway: Exa and Keenable reach origin at 99.8 % with no skip rule in the
  custom phase. So either the skip lives in another product (a Configuration
  Rule can set Security Level), or Under Attack does not challenge a verified bot
  on its own. One of those is true, and it is a dashboard read for Craig, not a
  script read here. **One of the five Free custom-rule slots is open.**
- Bot Fight Mode and AI Crawl Control have no Free-plan API read. Those are
  Craig's rows.

---

## §6 The verdict

- **A — the limiter's share.** **92.1 %** of the week's 206,878 commands
  (190,539). The flat floor is 2,449/day, or 7.9 %. The limiter spends
  27.1k/day, **~5.4×** the ~150k/month (5k/day) human-traffic figure in
  FIX-1304's header.
- **B — the families.** `entity_pages` **64.4 %** of checks (`/donors/<id>`
  alone is 43 % of B; `/proposals/<id>` 20.6 %) and `entity_leaf` **35.3 %**
  (`/officials/<id>` 26.7 %, `/jurisdictions/<id>` 8.7 %). The API buckets are
  0.2 % (`graph` 110, `search` 2, `graph_ai` 0, `write` 0).
- **C — who.** Many IPs, few actors. **ExaSearchBot is 53.3 %** of checks from
  the 256 IPs of `172.245.122.0/24`, and **KeenableBot is 17.2 %** from ~20
  GCP IPs. Both are Cloudflare-verified "Search Engine Crawler" bots. Googlebot
  is 9.8 %, Bingbot 7.3 % and OAI-SearchBot 1.3 %. Browser-class UAs are 11.1 %.
- **D — when it began.** **10-23 23:00Z**: 209 → 1,028 origin requests/hr, then
  a flat ~950/hr. It became visible only at the 11-01 00:00:58Z reset, because
  the 10-12 crawl had frozen October's quota at ≥ 499,669. Nothing in the deploy
  list coincides.
- **E — how far under the trip.** The week's max hour is **1,721** (11-05 16Z),
  57 % of 3,000. The mean is 643/hr (21 %). **0** hours reached 3,000, so the
  loop's 2-of-6-hours rule never came close. 21 hours reached 1,000.
- **F — does the limiter limit any of it.** **No: 0 HTTP 429 in 7 days.** The
  busiest IP ran at 0.86/min against a 45/min cap (52× under), and an Exa
  address at ~0.01/min.
- **G — the dates.** The FIX-1304 hold lands **11-13 01:35Z** at the 7-day mean
  (11-11 22:56Z at the max day, 11-13 13:55Z at the last-3 mean), each + ≤ 3.5 h.
  If the hold failed, 500k would come at 11-18 05:54Z / 11-15 16:02Z / 11-19
  10:32Z. With the hold working, month-end is ≈ 394k.

---

## §7 The proposal for Craig (a dashboard action; nothing here was written)

**A fifth WAF custom rule, in the free slot.**

- **Name:** `AI search crawlers (FIX-1390)`
- **Expression:** `(http.user_agent contains "ExaSearchBot") or (http.user_agent contains "KeenableBot")`
- **Action:** **Managed Challenge**, never Block. A crawler cannot solve it and
  a browser can, so a mis-match costs a human one interstitial, not a page.
- **Slot:** the **5th, currently empty** (§5: the live entrypoint holds 4). Put
  it after `Probe skip (FIX-1057)`. Do not merge it into `Meta`: `Meta`'s action
  is Block, and merging would either block Exa outright or soften Meta.
  *If `Verified bots skip (FIX-1305)` is later re-added to this phase, the
  zone is at 5 of 5. That is the moment to fold `Meta` into this rule as a third
  `or` and accept a challenge for meta-webindexer instead of a block.*
- **Why a UA match is safe here:** both are Cloudflare-**verified** bots, so
  Cloudflare has already tied the UA to its IP ranges. A UA match on them is not
  a spoofable bypass. A spoofer claiming to be Exa only buys itself a challenge.
- **Fields:** Cloudflare's fields reference
  (`developers.cloudflare.com/ruleset-engine/rules-language/fields/reference/`)
  marks restricted fields per entry ("Enterprise add-on", "Pro or above",
  "Business or above", "Enterprise"). `http.user_agent`, `http.request.uri.path`,
  `cf.client.bot` and `cf.verified_bot_category` carry no such label, so all four
  are available on Free. `cf.client.bot` already runs on this zone, and this
  week's GraphQL returns `verifiedBotCategory` values on the Free zone.
- **What it saves** (§4, this week's rate): Exa + Keenable made 32,441 checks
  in 7 days, **4,634/day**. That is **−19.1k commands/day** at 4.12, about
  −65 % of the daily spend, and **−4.6k origin renders/day**, about −30 % of
  origin-reaching traffic. Spend falls to ~9.9k/day. From today's 236k that is
  ≈ 452k at 12-01 even with no hold, and the hold would not land before
  ~11-20.
- **What it costs:** Exa's and Keenable's search indexes stop refreshing civic
  pages. Both are AI search engines, and that is a reach question, not a cost
  one, so it is Craig's call. Googlebot, Bingbot and OAI-SearchBot are untouched.

**Alternatives considered:**

- **AI Crawl Control → "block AI crawlers"** (the dashboard toggle). On this zone
  Cloudflare's own `verifiedBotCategory` puts Exa, Keenable **and** OAI-SearchBot
  under **Search Engine Crawler**, not "AI Crawler". A toggle keyed on the
  AI-crawler category is **not expected to stop either of the two that spend**.
  Craig can confirm in the dashboard which bots the toggle lists. Not
  recommended as the primary lever.
- **`cf.verified_bot_category eq "Search Engine Crawler"`** — rejected. Googlebot
  and Bingbot are in the same category: 17 % of checks, and the search engines
  this site wants.
- **Cloudflare's Free rate-limiting rule** (per-IP, 10 s) — useless here. Exa runs
  at ~0.01/min per address.
- **Turning Under Attack off (FIX-1039)** — would not help. The spenders are the
  clients Under Attack already waves through, and turning it off would add the
  challenged ~27–36 % of edge to origin.
- `robots.txt` was not considered; it is out of scope by the prompt.

---

## §8 The code lever, sized ([[FIX-1391]], filed — not built)

The limiter is 92 % of spend, above D3's 60 % line, so the code lever is filed.
**Sliding → fixed window** on `search`, `graph`, `graph_ai`, `entity_pages`,
`entity_leaf` and `entity_prefetch`:

- **Per check:** an allowed sliding check is 4 (5 first-in-window), and an
  allowed fixed check is 2 (3 first-in-window). At this week's ~13 % first-in-window
  share that is 4.13 → ~2.13, **−48 %**. The prompt's "3 → 2, −33 %" understates it.
- **Per day:** 6,584 checks/day × 2.0 ≈ **−13.2k commands/day (−395k/month)** at
  this week's B. If the §7 rule lands first, B ≈ 1,950/day and the swap is worth
  ≈ −3.9k/day (−117k/month).
- **Cost:** up to 2× the cap across a window boundary. The memory fail-over
  already accepts that (`memoryLimit`'s header).
- **`entity_prefetch` on the memory path only:** not sized. The prefetch split is
  invisible to the edge analytics, and browser-class UAs are only 11 % of checks,
  so the ceiling is ~11 % × k × B ≈ 3k/day.

Measure one lever at a time (rule 74): the edge rule first, then 48 h, then
FIX-1391 sized on the new B.

---

## §9 FIX-1372's egress facts (read 5 — the probe from `main`)

`.github/workflows/egress-probe.yml` (`eb49308b`), run **42559755911**,
2026-11-09T04:04:30Z, conclusion `success`. Two GETs per URL, 20 s each, no
retry. The first GET used the collector's UA `node` (`members.ts` `fetchText()`
sends no headers, and Node's fetch sends `node`); the second used Chrome/142.

```
runner egress IP        20.236.52.84 (GitHub-hosted, Azure)
senate.gov roll XML     node → 403 · Server: AkamaiNetStorage · text/html · <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.0 Transitional//EN">
  vote1192/vote_119_2_00001.xml   Chrome → 403 · same; no X-Akamai-* / AkamWAFRefId / Retry-After header
GovTrack /api/v2/vote   node → 403 · cf-mitigated: challenge · server: cloudflare · cf-ray a579ef297a8575e2-SEA · "Just a moment..."
                        Chrome → 403 · cf-mitigated: challenge · cf-ray a579ef2a0df6a365-SEA
congress.gov            node → 404 · application/json · x-ratelimit-limit 20000 · remaining 19999 (the key is good)
  /v3/senate-vote (api_key)       Chrome → 404 · remaining 19998
```

**What it means for the design: GHA is challenged too.** The nightly's own
egress gets the same answer as the dev box from all three sources. senate.gov
refuses per IP class, not per UA; GovTrack's challenge is UA-blind; congress.gov
has no Senate-vote family whatever the key. So a fix cannot be "run it from
the runner". FIX-1372 needs a different source or a different transport, and
that design is Cowork's. The workflow stays in the tree for the next prompt to
re-run (`gh workflow run egress-probe.yml --ref main`).

---

## §10 What contradicted the prompt

1. **The unit cost is 4, not 3.** The installed `@upstash/ratelimit` v2.0.8
   sliding window charges 4 for an allowed check and 5 for the first in a
   window. 3 applies only when rate-limited (§1, the costs page). The week
   measured **4.13**: 4B+F fits within ±10.2 % on every day, and 3B+F misses by
   +22…+43 %. Fixed window is 2/3, not a flat 2, so D3's "3 → 2, −33 %" is
   −48 % (§8).
2. **The ring is 3 commands a sample, and cc-262's ledger was right.**
   `BOX_HEALTH_COMMANDS_PER_SAMPLE = 2` names only the write pipeline. FIX-1375's
   LINDEX head read (`BOX_HEALTH_HEAD_READS_PER_SAMPLE = 1`, `5d23037f`, 11-03
   02:49Z) makes it 3, so 2,160/day.
3. **The arm runs at `*/15`, not `*/2`.** That is 96 MGETs/day (≈ 2.9k/month), so
   `upstash-usage.ts`'s "~25k/month" is stale. The floor also carries the
   snapshot probe's 3 PINGs + 1 flag command per `*/30` tick (192/day), which
   the prompt's floor omitted. F = 2,449/day.
4. **The custom rules number 4, not 5, and `Verified bots skip (FIX-1305)` is not
   among them.** The entrypoint was last updated 09-04T01:48:03Z. Verified bots
   pass Under Attack anyway (Exa 99.8 % edge→origin). One Free slot is open (§5).
5. **Under Attack's door is the verified-bot list, and the AI toggle is unlikely
   to close it.** Cloudflare classifies Exa, Keenable and OAI-SearchBot as
   `Search Engine Crawler`, not `AI Crawler` (§7).
6. **The step came 10-23 23:00Z, not 11-01.** The prompt's 2× rule dated the
   Upstash reset, because its 10-31→11-04 baseline sits inside the drizzle. The
   drizzle ran 8 days unseen while October's quota stayed frozen from the 10-12
   crawl (§3). For 19 days (10-12 → 10-31) the limiter, the ring and the arm
   all sat on an exhausted quota.
7. **The analytics joins the prompt called impossible are possible.**
   `clientRequestPath_like` + `originResponseStatus_gt` filters with a
   `userAgent` / `clientIP` / method dimension give per-family UA and IP ladders.
   `verifiedBotCategory` is also readable on this Free zone.
8. **`cf-analytics.mjs`'s hourly mode has no origin column.** It prints 200 / 403
   / other / cache-hit. Origin-reaching needs `originResponseStatus`, the
   `cloudflare-analytics.ts` definition, which agreed with the snapshot's 2c
   within 3 requests a day. Retention is 8 days ("1w1d"), not ~7. The
   10,000-row cap never bound (max 7,909 paths/day).
9. **The keys matched.** The snapshot keys in read 2 were the prompt's
   (`platform-snapshot.ts:259-282`). The `SET … latest` duplicate is **gone**.
   FIX-1314's calendar reset was re-observed: 11-01T00:00:58Z, 503,289 → 0.
10. **The hold has not engaged** (every row since 11-01: `budget clear,
    flag_written true`). D4's record branch did not apply, and FIX-1304's
    receipt is projected (§2b).
11. **The 08-15 shape repeats, wider.** 0 HTTP 429 in 7 days. Every command was
    an allow. The busiest IP ran at 0.86/min (Googlebot), and Exa runs at
    ~0.01/min per address across a whole /24.
12. **The door refused nothing via Cloudflare.** Origin 403 = 0 every day, so all
    origin-reaching traffic carried the FIX-1305 header.
13. **Open, not measured: the identifier's density.** The fitted PEXPIRE share
    is ~13 %. Per-client-IP keys at this crawl's ~0.01/min would make nearly every
    check the first in its window (k ≈ 5). One candidate: the limiter's key
    (`x-forwarded-for` first hop at Vercel, `middleware.ts:152-158`) is denser
    than Cloudflare's `clientIP`, for example if Vercel substitutes the
    connecting Cloudflare edge IP. Then the "per-IP" buckets would be per-PoP
    buckets. A header-echo read settles it. The FIX-1391 sizing holds either
    way, because it is fitted on the measured 4.13.
14. **Side note, not chased:** `/favicon.ico` answered 404 to 25,012 origin
    requests in 7 days. That is 0 commands (outside the middleware matcher) but a
    real origin hit per request.

---

## §11 cc-270's receipts (2026-11-11; appended, nothing above edited)

Prod contact was read-only throughout. It covered Cloudflare GraphQL (the new
`cf-analytics.mjs --origin` / `--path-like`, plus multi-dimension scratch
queries) and one REST GET of the custom-rules entrypoint, which printed the
expression of the new rule only. It also covered one `db-query --prod` of
`platform_usage_snapshot` (`SET LOCAL statement_timeout = '30s'`) and GETs of
`/favicon.ico` and `/api/cron/limiter-health`. Nothing was written to prod,
Upstash or Cloudflare.

### FIX-1390's receipt: MET

**The rule as live** (entrypoint, ruleset v5, 5 rules, last updated
2026-11-09T05:05:18Z): **`SearchBot`**, `managed_challenge`, enabled,
`(http.user_agent contains "ExaSearchBot") or (http.user_agent contains "KeenableBot")`.
That is §7's expression exactly. The name carries no FIX id.

| window (UTC) | Exa origin | Exa edge | Keenable origin | Keenable edge |
|---|---:|---|---:|---|
| 11-09 00–05Z, pre-rule, quoted apart | 972 | 972, all 200 | 30 | 30 (15 × 200, 15 × 307) |
| 11-09 05–24Z | **0** | 1,153 (1,152 × 403, 1 × 499) | **2** | 31 (29 × 403) |
| 11-10, full day | **0** | **0**: Exa stopped asking | **0** | 20, all 403 |
| threshold: 5 % of the 11-02→08 daily mean (§4) | 175 (of 3,505) | | 56 (of 1,129) | |

- Keenable's 2 post-05Z origin requests are both in the 05:00Z hour (one 500,
  one 307), before the rule's 05:05:18Z.
- No browser-class UA moved to a 403. Edge 403s were 17,114 on 11-08 and 17,265
  on 11-10, with the same top ten both days: the rotating Windows Chrome
  133–142 family that Under Attack challenges. The rule matches two substrings
  that no browser UA carries.
- 429s at the origin: 0 on 11-09 and 0 on 11-10.
- Upstash `daily` for 11-09 was **13,548** at 23:31Z (≤ ~15k ✓). 11-10 was
  16,561.

### The model's first out-of-sample days

B comes from the verbatim middleware sequence. The classifier reproduces §4's
11-08 B of 5,024 exactly.

| UTC day | entity_leaf | entity_pages | api | **B** | `daily` @23:31 | full day (×1440/1411) | 4.13B + F | residual | implied k |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 11-09 | 1,157 | 1,310 | 2 | **2,469** (1,240 pre-rule / 1,229 post) | 13,548 | 13,826 | 12,646 | **+9.3 %** | 4.61 |
| 11-10 | 991 | 1,814 | 0 | **2,805** | 16,561 | 16,901 | 14,034 | **+20.4 %** | 5.15 |

- **11-09 passes** (±10 %). It is the model's first out-of-sample day, and it
  is part pre-rule.
- **11-10 misses by +20 %, and the miss is k, not F.** With Exa's dense /24
  gone, nearly every remaining check is the first in its window. A sliding
  first-in-window check is 5 commands (EVAL, GET, GET, INCRBY, PEXPIRE). The
  ~0.15 above 5 is about the size FIX-1304's flag GETs on cold isolates would
  be (~420/day), but that is a hypothesis, not a measurement.
  **Consequence for [[FIX-1391]]:** at that share, the fixed window costs 3 a
  check, not 2.13. That is −40 %, not −48 %. The owed k receipt (cc-270
  report) says so.

**Origin totals:** 8,482 on 11-09 (353/hr) and **24,256 on 11-10 (1,011/hr)**,
against the census week's 643/hr. The 11-10 rise is not bucketed traffic. The
rotating Windows Chrome 133–142 family from §4 (3c) reached the origin 23,151
times on 11-10, 95 % of the day. That was 2,787 IPs in 125 countries (BR 2,532
· IN 2,442 · VN 1,699 · US 1,331 · MX 1,028), about 8 requests an IP, almost
all on the app's beacons: `/favicon.ico` 5,773, `/api/platform/web-vitals`
4,208 (POST), `/icon.svg` 2,239, `/api/notifications` 2,047 (401),
`/_vercel/insights/view` 2,000 and `/api/track-view` 1,551. Its daily origin
count was 7,523 (11-06), 6,735 (11-07), 15,668 (11-08), 6,269 (11-09) and
23,151 (11-10). It spends function invocations, not Upstash commands. It is
named here for a future census and was not chased.

### The re-projection (read 3)

At 11-11T00:01:27Z, `used` was 262,231 of 500,000, `state` `healthy`, and
`budget` was `{pct 70, commands 350,000, state clear, flag_written true}`. The
hold has still never engaged.

| rate | per day | → 350k | hold engages by (+3 h step + 30 min) | → 500k |
|---|---:|---|---|---|
| (i) post-rule, still sliding (11-10's full day) | 16,901 | 5.19 d → 11-16 04:39Z | 11-16 08:09Z | 14.07 d → 11-25 01:39Z |
| (ii) post-swap, k 2.13 (B 2,805) | 8,424 | 10.42 d → 11-21 10:05Z | 11-21 13:35Z | past 12-01 |
| (iii) post-swap, k 3.15 (11-10's share) | 11,285 | 7.78 d → 11-18 18:41Z | 11-18 22:11Z | past 12-01 |

The swap deployed at 11-11 00:32:42Z, so (ii)–(iii) is the rest of the month.
**The hold still lands in November, between 11-18 and 11-21**, unless B falls
further. Once it holds, the floor alone carries the month to ~373–380k by
12-01, and 500k is out of reach either way.

### The identifier (§10 item 13): still OPEN, but narrower

**Read 4 could not run as written.** Every scripted GET through
www.civitics.com was challenged (`403`, `cf-mitigated: challenge`, `server:
cloudflare`, `cf-ray …-SEA`, 00:33:30Z and 00:34Z), with or without the
bearer. docs/CLOUDFLARE.md §5 holds: the request never reaches Vercel. The
FIX-1057 header that skips Under Attack lives only in the WAF rule and a GHA
secret.

The same route through the vercel.app alias (00:34:25Z). `/api/cron/*` is
exempt from both the alias redirect and the origin door:

- `401 {"error":"Unauthorized"}` without the bearer, and `200` with it. Both
  carry `cache-control: no-store`.
- `ip`: `x_forwarded_for` = `x_real_ip` = `key_in_use` = the dev box's public
  IPv4 (not recorded here), and `cf_connecting_ip` was null.
- With client-sent TEST-NET values (`X-Forwarded-For: 192.0.2.1`,
  `X-Real-IP: 192.0.2.3`, `CF-Connecting-IP: 192.0.2.2`), **Vercel overwrote
  both forwarded headers with the TCP peer** (the dev box) and **passed
  `cf-connecting-ip: 192.0.2.2` through untouched**.

What this settles: Vercel sets `x-forwarded-for` from whoever opened the TCP
connection. Behind the proxy, that is a Cloudflare edge, so the limiter's key
is very likely the PoP. That fits §4's 13 % first-in-window share across 256
sparse Exa IPs.

What it does not settle: the value as seen through Cloudflare, which the
criterion needs (`x_forwarded_for` ≠ `cf_connecting_ip`, and inside a
Cloudflare range). So the identifier is **not confirmed and not refuted**. No
FIX was filed and no keying code changed.

The alias read also shows that D2's trust boundary is real. A client-sent
`cf-connecting-ip` survives Vercel, so a request may be keyed on it only after
it has passed the origin door in `enforce`.

**How to read it:** a `workflow_dispatch` job that sends `x-civitics-probe`
(the FIX-1057 skip) and `CRON_SECRET`, as `platform-snapshot.yml` already does,
GETs `/api/cron/limiter-health` through www, and prints `ip`.

### The health block cannot be the middleware's

`/api/cron/limiter-health` (edge) returns its own isolate's
`getLimiterHealth()`. On both alias reads that was `mode null, transitions 0,
deny_cache_size 0, memory_keys 0, budget_hold null, budget_reads 0`. The
build's `.next/server/middleware-manifest.json` lists `middleware: ['/']` and
`functions: ['/api/cron/limiter-health/route', …]`. Those are two edge
bundles, each with its own copy of `ratelimit.ts`'s module state. So the edge
runtime does not put the route in the middleware's isolate, and the block
cannot serve [[FIX-1304]]'s receipt. For that, the middleware would have to
answer the path itself.

### FIX-1395, the favicon (read 6)

`GET https://www.civitics.com/favicon.ico` at 00:34Z returned `200`,
`content-type: image/vnd.microsoft.icon`, `cache-control: public,
max-age=86400, stale-while-revalidate=604800`, `cf-cache-status: EXPIRED` and
`x-vercel-cache: MISS`. It was 15,086 bytes with magic `00 00 01 00 03 00` (an
ICO holding 3 images), and it was not challenged.

Cloudflare, `/favicon.ico`, compared:

- **Hour before the deploy (23:33–00:33Z):** 233 requests, all of them 404s at
  the edge. 227 were `revalidated` against the origin (origin 304); a cached
  404 was being re-asked a few times a minute.
- **First 4 minutes after (00:33Z on):** 6 at edge 200 from origin 200
  (`expired` / `miss`, as each colo drops its 404), then 2 `hit` with origin
  status 0.

Deploy: `c949fa20` reached `main` at 00:30:58Z; the Vercel commit status went
from `pending` to `success` at 00:32:42Z.

## §12 cc-272 — the identifier, the health block, the Chrome 133–142 fleet (2026-11-12; appended, nothing above edited)

Prod contact was read-only, with three exceptions, all stated here.

- **The two deploys:** the code's own, on `main`.
- **The bearer GETs** of the health path: each one now forces one Upstash flag GET.
- **One local `next start` smoke test.** Its `.env.local` carries the project's one
  Upstash database, so it spent one fixed-window limiter check on a 60 s key, plus two
  flag GETs.

Everything else was reads: Cloudflare GraphQL, three `db-query --prod` reads under
`statement_timeout 30s`, and the GHA `egress-probe.yml` runs through www.

### The identifier (§10 item 13): CONFIRMED, and fixed ([[FIX-1401]])

`egress-probe.yml` now sends `x-civitics-probe` to `https://www.civitics.com/` only. The
middleware stamps `x-civitics-ip-key: cf=<absent|same|differs>; key=<xff|real|cf|unknown>`
on every `/api/cron/limiter-health` answer, the 401 included. The probe holds no
`CRON_SECRET`, so it read the stamp off the 401:

| when (UTC) | run | edge → Vercel | UA | status | `x-civitics-ip-key` |
|---|---|---|---|---|---|
| 01:46:07 (deploy A) | 43136758112 | IAD → iad1 | node, Chrome/142 | 401, `cf-ray` present | **`cf=differs; key=xff`** |
| 01:49:07 (deploy A) | 43137094913 | ORD → cle1 | node, Chrome/142 | 401, `cf-ray` present | **`cf=differs; key=xff`** |
| 01:58:43 (deploy B) | 43138160863 | ORD → cle1 | node, Chrome/142 | 401 | **`cf=differs; key=cf`** |
| 01:59:41 (deploy B) | 43138264706 | LAX → sfo1 | node, Chrome/142 | 401 | `cf=differs; key=cf` |
| 02:01:37 (deploy B) | 43138500014 | PDX/SEA → pdx1 | node, Chrome/142 | 401 | **`cf=differs; key=cf`** |

So, through Cloudflare, `x-forwarded-for` was the edge and `cf-connecting-ip` was the
client: the limiter's "per-IP" key was per-PoP. Since deploy B, a request that carries
the origin secret under `enforce` keys on `cf-connecting-ip`. IPv6 keys on its /64 and
IPv4 is used whole (`client-ip.ts`, `origin-auth.ts` `provedCloudflare`). Through the
alias, with the bearer, the key is unchanged at `cf=absent; key=xff`: the dev box, via
`x-forwarded-for`.

**Consequence for k (owed, after 11-14 06:00Z).** One page per IP (below) means nearly
every fleet check is now first-in-window: 3 commands under the fixed window. That is
§11's bound (iii), and it puts the FIX-1304 hold near 11-18, not 11-21.

### The health block ([[FIX-1402]])

The middleware now answers `/api/cron/limiter-health` (`src/lib/limiter-health.ts`). The
route and its test are gone. Six bearer GETs through the alias after deploy A (01:46:25 →
01:48:56Z, 30 s apart) gave the same row each time:

- `health_scope: "middleware"`, `budget_read: "read"`, `budget_hold: false`, `budget_detail: null`
- `isolate.id` `b86e2198-c284`, `started_at` 01:45:06.674Z, which is deploy A's success instant
- `checks: 0`, `mode: null`, `transitions: 0`
- `budget_reads` stepped 1 → 6, one forced read per GET

0 of 6 landed on an isolate with `checks > 0`. pdx1 serves the dev box, and almost
nothing bucketed lands there. The single read after deploy B (01:59:24Z) did land warm:
isolate `9f43bc14-e9cf`, `checks: 1`, `mode: "upstash"` since 01:58:53Z, `budget_reads: 2`.

The same isolate id across 3.5 minutes is also the first direct evidence that module
state survives between requests on a middleware isolate, which FIX-1304's design
assumed.

**What FIX-1304's receipt looks like through it:**

- On any isolate, `budget_hold: true` and `budget_detail: "<used>/<limit>"`, because the
  forced read is the flag as of the call.
- On a warm isolate (`checks > 0`) that has served a check since the flag was set,
  `mode: "memory"` with `reason: "budget hold: …"`.

### The fleet (§4 (3c), §11): census, read-only ([[FIX-1403]])

**Classifier:** `userAgent_in` the ten exact strings `Mozilla/5.0 (Windows NT 10.0;
Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/1{33..42}.0.0.0
Safari/537.36`. Days run 00:00Z ≤ t < 24:00Z (`datetime_lt`).

**Self-test:** 11-10 origin-reaching = **23,020**, against §11's 23,151 (−0.57 %, inside
±1 %). All-origin for 11-10 is 24,256, the same as §11. All-origin for 11-02 → 11-08
matches §4 (3a) exactly, so Cloudflare still held 11-01 → 11-04 on 11-12 (cc-272 report, What
contradicted).

**(a) Edge vs origin**

| | 11-10 | 11-11 (newest full day) |
|---|---:|---:|
| fleet at the edge | 56,796 | 38,110 |
| reached the origin | 23,020 (40.5 %) | 11,195 (29.4 %) |
| edge status | 200 23,491 · 403 15,724 · 499 6,022 · 404 5,767 · 204 3,174 · 401 2,539 | 200 18,824 · 403 9,673 · 499 4,138 · 204 2,134 · 400 1,654 · 401 1,543 |
| share of all origin traffic | 94.9 % | 86.5 % |

Every version passes the challenge at the same rate on a given day: 41 % on 11-10, for
133 (4,494 → 1,841) and for 142 (15,641 → 6,411) alike. Chrome/142 carries ~3× each of
the other nine.

**(b) Origin paths and methods**

| | 11-10 | 11-11 |
|---|---|---|
| top paths | `/favicon.ico` 5,767 · `/api/platform/web-vitals` 4,194 · `/icon.svg` 2,235 · `/api/notifications` 2,034 (401) · `/_vercel/insights/view` 1,996 · `/api/track-view` 1,546 · `/75c49be622312150/vitals` 714 · `/api/questions` 519 · `/api/constituent-status` 518 · `/api/comments` 511 · `/api/follows` 505 | web-vitals 2,809 · `/icon.svg` 1,542 · insights 1,365 · notifications 1,351 · track-view 927 · speed-insights 434 · `/favicon.ico` **315** · comments 211 · questions 200 · follows / constituent-status 192 |
| distinct paths | 2,181 | 1,561 |
| methods | GET 14,570 · POST 8,450 | GET 5,660 · POST 5,535 |

- `/75c49be622312150/vitals` is Vercel Speed Insights (`<SpeedInsights />` in
  `app/layout.tsx`), a fourth beacon.
- `/favicon.ico` fell from 5,767 to 315 because cc-270's favicon is now an edge-cached 200.

**(c) Countries.** ASN and referer are refused to this Free zone: `clientAsn`,
`clientASNDescription` and `clientRefererHost` all return "does not have access to the
field".

- **11-10:** 125 countries. BR 2,532 · IN 2,442 · VN 1,699 · US 1,242 · MX 1,028 · TH 944 ·
  ID 703 · GB 676 · PH 671 · TR 588 · AU 529 · SA 462 · CO 438 · ES 406 · FR 374
- **11-11:** 110 countries. IN 1,329 · BR 1,217 · VN 933 · US 630 · MX 538 · ID 440 · TH 387 ·
  GB 326 · PH 287 · TR 231 · CO 229 · SA 208 · ES 199 · MY 199 · AU 197

**(d) IPs**

| | 11-10 | 11-11 |
|---|---:|---:|
| distinct IPs at origin | 2,784 | 1,641 |
| of them IPv6 | **0** | **0** |
| requests per IP, p50 / p95 / max | 9 / 14 / 24 | 7 / 11 / 20 |
| distinct /24s | 2,732 | 1,627 |
| /24s holding more than one IP | 45 (max 4) | 14 (max 2) |
| IPs at the edge | 5,454 (2,670 never reached origin) | 3,915 (2,274 never reached origin) |

**(e) Origin by hour (UTC)**

- **11-10:** `00` 831 · `01` 757 · `02` 560 · `03` 883 · `04` 943 · `05` 1,185 · `06` 1,077 ·
  `07` 1,058 · `08` 1,151 · `09` 1,146 · `10` 1,025 · `11` 1,108 · `12` 1,073 · `13` 1,099 ·
  `14` 1,142 · `15` 1,113 · `16` 1,045 · `17` 1,112 · `18` 922 · `19` 1,359 · `20` 1,027 ·
  `21` 511 · `22` 493 · `23` 400. A flat plateau of ~1,000–1,150 an hour from 05Z to 20Z.
- **11-11:** `00` 325 · `01` 479 · `02` 900 · `03` 1,130 · `04` 1,132 · `05` 863 · `06` 767 ·
  `07` 703 · `08` 651 · `09` 657 · `10` 817 · `11` 821 · `12` 514 · `13` 179 · `14` 218 ·
  `15` 188 · `16` 146 · `17` 184 · `18` 122 · `19` 62 · `20` 57 · `21` 54 · `22` 128 ·
  `23` 98. It ramps to 02–04Z, then winds down after 12Z.

Neither day is human-shaped for a population split between UTC−3 (BR) and UTC+7 (VN).

**(f) Pages: the fleet walks the deep-link long tail, about one page an IP**

| | 11-10 | 11-11 |
|---|---:|---:|
| page renders at origin | **2,459** over 2,148 distinct paths (1.14 a path) | 1,604 over 1,529 (1.05) |
| by family | `/donors/*` 1,436 · `/jurisdictions/*` 801 · `/officials/*` 130 · `/proposals/*` 86 · `/institutions/*` 4 · `/agencies/*` 2 | donors 935 · jurisdictions 564 · officials 56 · proposals 36 · institutions 9 · agencies 4 |
| origin status | 200 2,435 · 500 22 · 308 2 | 200 1,591 · 500 9 · 308 4 |

- Page requests are `cacheStatus: dynamic` at origin; the rest are `none` / 403
  (challenged) or 499.
- At the edge the fleet also requests `/cdn-cgi/challenge-platform/…` (12,061 on 11-10)
  and Cloudflare's `/cdn-cgi/rum` (3,216): it runs the challenge's JS and Cloudflare's own
  RUM beacon.
- **These renders are bucketed.** `/donors/*` and `/proposals/*` are `entity_pages`;
  `/jurisdictions/*` and `/officials/*` are `entity_leaf`. On 11-10 that was 931 leaf +
  1,528 pages = 2,459 checks, **~88 % of §11's B of 2,805** (leaf 991, pages 1,814). The
  fleet is most of the limiter's bucketed traffic since Exa stopped.
- At one page per IP, no per-IP cap can touch it.

**(g) The daily series (origin-reaching; extends §11)**

| UTC day | fleet origin | all origin | share | fleet edge | IPs | track-view forwarded (200 + 499) | `page_views` rows | web-vitals forwarded (200 + 499) | `web_vitals_samples`: fleet / all (%) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 11-01 | 17,254 | 22,748 | 75.8 % | 46,006 | 2,197 | 963 | 975 | 3,886 | 3,802 / 3,910 (97.2) |
| 11-02 | 8,406 | 13,756 | 61.1 % | 24,575 | 1,317 | 355 | 394 | 1,434 | 1,386 / 1,545 (89.7) |
| 11-03 | 7,276 | 14,865 | 48.9 % | 21,959 | 1,068 | 238 | 259 | 1,672 | 1,647 / 1,721 (95.7) |
| 11-04 | 7,265 | 15,547 | 46.7 % | 27,036 | 1,278 | 115 | 152 | 1,081 | 1,065 / 1,233 (86.4) |
| 11-05 | 6,266 | 16,477 | 38.0 % | 23,245 | 1,165 | 215 | 221 | 811 | 797 / 1,008 (79.1) |
| 11-06 | 7,490 | 15,160 | 49.4 % | 25,412 | 1,231 | 578 | 596 | 2,156 | 2,161 / 2,239 (96.5) |
| 11-07 | 6,318 | 12,351 | 51.2 % | 19,751 | 916 | 384 | 418 | 1,538 | 1,517 / 1,596 (95.1) |
| 11-08 | 15,086 | 19,787 | 76.2 % | 44,101 | 2,126 | 880 | 932 | 3,577 | 3,515 / 3,629 (96.9) |
| 11-09 | 6,105 | 8,482 | 72.0 % | 25,075 | 1,236 | 212 | 231 | 1,064 | 1,057 / 1,102 (95.9) |
| 11-10 | 23,020 | 24,256 | 94.9 % | 56,796 | 2,784 | 1,549 | 1,583 | 7,589 | 7,430 / 7,502 (99.0) |
| 11-11 | 11,195 | 12,943 | 86.5 % | 38,110 | 1,641 | 933 | 946 | 5,109 | 5,035 / 5,120 (98.3) |

§11's series read 7,523 · 6,735 · 15,668 · 6,269 · 23,151 for 11-06 → 11-10. The exact
ten-string classifier reads 0.4–6 % lower on those days, while all-origin agrees to the
request, so cc-270's family was slightly wider than the ten strings.

**The 499s reach the origin.** Fleet web-vitals at the edge on 11-10 were 4,194 `200/200`
+ **3,395 `499/0`** + 29 `403`. The DB holds 7,430 fleet rows for that day, against
4,194 + 3,395 = 7,589. `sendBeacon` on unload drops the connection before the answer
comes back. Cloudflare logs a 499 with `originResponseStatus 0`, but it had already
forwarded the request and the function ran. Speed Insights had the same split: 714
`200` + 2,553 `499`. So `originResponseStatus_gt: 0`, the `--origin` definition,
**under-counts origin work for beacons**. The fleet's real arrivals on 11-10 were nearer
29k than 23k.

### The DB side (read 7)

- **`page_views`, 11-01 → 11-11:** 6,707 rows. Each day's rows ≈ distinct `session_id`
  (one view per session). `is_bot` true on 1 row in 11 days. `browser` is `Chrome` on
  95–100 % of every day.
- **`page_views.country_code` is the EDGE's country.** Top 5 on 11-10: US 215 · SG 208 ·
  BR 187 · FR 131 · HK 83. Cloudflare's countries for the fleet that day are led by BR,
  IN and VN, and IN and VN are missing from the DB's top 5. `x-vercel-ip-country`
  geolocates the Cloudflare egress, the same root cause as the key. **One-line follow-up
  (D8, not built):** `track-view/route.ts` reads `cf-ipcountry`, set by Cloudflare,
  before `x-vercel-ip-country`.
- **`web_vitals_samples`, 11-01 → 11-11:** the fleet's ten UAs are **29,412 of 30,605
  rows (96.1 %)**.
- **The fleet's share of `page_views`:** forwarded fleet track-views sum to 6,422 against
  6,707 rows, **≈ 95.8 %**. `page_views` carries no UA, so this ratio crosses the two
  sources.
- **Sizes:**
  - `page_views`: 3.1 MB heap / 6.6 MB total, `reltuples` 14,903, `n_dead_tup` 2.
  - `web_vitals_samples`: 16.1 MB / 23.4 MB, `reltuples` 64,522, `n_dead_tup` 16.
  - Both are small. The fleet's cost here is meaning, not bytes.
- **The newest `platform_usage_snapshot`** (01:31:08Z 11-12, month to date, 11 days):
  - `total_overage_cost` **3.5648**.
  - The Vercel keys are `vercel_account`, `vercel_billing`, `vercel_billing_shadow` and
    `vercel_breakdown`.
  - `vercel_breakdown.services[]` (`service`, `usd`, `quantity`, `unit`, `metric`):
    - `Function Invocations` 269,523 ($0.441)
    - `Web Analytics Events` 7,764 ($0.635)
    - `Observability Events` 2,382,634 ($7.798, the largest metered line, not attributed)
    - `Fluid Active CPU` 5.08 h ($1.884) · `Fluid Provisioned Memory` 84.6 GB-h ($2.491) ·
      `ISR Writes` 229,679 ($2.506) · `Fast Origin Transfer` 2.92 GB ($0.548)
  - `vercel_billing`: `usage_mtd_usd` 6.11 of `included_credit_usd` 20
    (`credit_used_pct` 30.6), `projected_usage_usd` 16.68, `billable_overage_mtd_usd` 0.

### Who, what it costs, how much of the data

- **A farm, not people.** The real Chrome visitors on this zone run 155–157. Its ten
  Windows strings are 13–24 releases stale, and every version passes the challenge at the
  same rate. 2,784 IPs spread over 2,732 /24s, with zero IPv6, each loading about one
  deep-link page and its beacons, on a flat 05–20Z plateau. That is a residential-proxy
  browser farm executing JS.
- **A day costs little in dollars; the cost is elsewhere.** 11-10 cost about 15.7k
  function invocations: 2,459 renders, 7,589 web-vitals, 1,549 track-views, 2,034
  notifications and ~2,050 reads of the four page APIs. That is ~$0.03 at the snapshot's
  own rate, against a month-to-date average of ~24.5k a day. The day also brought ~2,000
  Web Analytics events (up to ~$0.16 if all were billed; the snapshot bills only 7,764
  month to date) and ~9k DB rows. Vercel overage is $0 at 30.6 % of the credit. The real
  costs are ~2,460 bucketed checks a day, ~7k Upstash commands at k ≈ 3 toward the
  FIX-1304 hold, and the analytics themselves.
- **It is ~96 % of both telemetry tables since 11-01**: ~95.8 % of `page_views` and
  96.1 % of `web_vitals_samples`.

### Options for Craig (nothing built)

| option | what it does | saves a day (11-10 scale) | risks |
|---|---|---|---|
| **(1) Leave it** | nothing | 0 | `page_views` / `web_vitals_samples` stay ~96 % fleet; anything built on them reads the farm. ~2.5k bucketed checks a day (~7k Upstash commands at k ≈ 3) pull the FIX-1304 hold toward 11-18. The 11-01 / 11-08 / 11-10 peaks recur. |
| **(2) Edge rule** | All 5 Free slots are used, so OR a clause into **`Common Exploit Paths`** (Block): `(http.user_agent in {"…Chrome/133.0.0.0 Safari/537.36", …, "…Chrome/142.0.0.0 Safari/537.36"})`, the ten exact strings. The signature has held every day since 11-01. Merging into `SearchBot` instead (managed_challenge) buys little, because the farm already passes Under Attack's challenge 30–41 % of the time. | all ~23k origin requests, ~2.5k renders, ~9k rows, the analytics events | It blocks any real Windows user still on Chrome 133–142. The zone's non-fleet Chrome is 155–157, but stale Windows Chrome cannot be told apart from the farm. The farm can rotate strings at will. It is a dashboard edit to a Block rule. |
| **(3) App-side** | `/api/track-view` and `/api/platform/web-vitals` answer 204 without the INSERT, or `track-view` writes `is_bot: true` with `bot_name: 'chrome-133-142'`, when the UA is one of the ten. The UA is the only field the census can tell apart. A real browser sends the same string, so nothing else separates them. | ~9k rows a day; `page_views` / `web_vitals_samples` clean | It saves no invocations: the function still runs, unless middleware answers first. It does nothing for renders, Upstash checks or the `/_vercel/*` beacons. A real stale-Chrome user loses only telemetry. `is_bot` is the reversible form. |

## §13 cc-273 — the beacon routes flag the fleet, and the visitor's country (2026-11-12; appended, nothing above edited)

Prod contact was read-only, plus the code's own deploy on `main` (`0e51771c`, Vercel
commit status `success` at **05:07:32Z**). The reads were Cloudflare GraphQL, one REST
GET of the zone's `ip_geolocation` setting, and four `db-query --prod` calls under
`statement_timeout 30s`. Reads 2, 3 and 4 returned rows. The first try at read 3 failed at
its first statement (a temp table, refused by the read-only wrapper) and read nothing.

### What was built (option (3) of §12, and the `cf-ipcountry` follow-up)

- **`apps/civitics/src/lib/view-telemetry.ts`** is pure (no `next/*` import). It holds:
  - `CHROME_FLEET_UAS`: §12's ten exact strings;
  - `isChromeFleetUa()`: exact equality after `trim()`;
  - `CHROME_FLEET_BOT_NAME = "chrome-133-142"`;
  - `visitorCountry()`: `cf-ipcountry` when present (two letters, upper-cased, not
    `XX`; otherwise null), else `x-vercel-ip-country`.
- **`/api/track-view`** writes fleet views with `is_bot = true` and `bot_name =
  'chrome-133-142'`. `device_type` and `browser` are null, as for any bot, and the row
  is still written. `country_code` comes from `visitorCountry()` on every row.
- **`/api/platform/web-vitals`** answers a fleet sample `{ ok: true }` without the INSERT.
  It does so after payload validation, so a bad payload still gets 400. The header comment
  now says what is true: no reader, no retention ([[FIX-1406]]).
- Filed [[FIX-1404]] (the flag) and [[FIX-1405]] (the country), and closed both `local`.
  Filed [[FIX-1406]] (`web_vitals_samples`), not built. Rules:
  `docs/CLOUDFLARE.md` §Origin auth, "The beacon routes".

### Read 2: `web_vitals_samples` has no reader and no retention

On prod, about 04:55Z 11-12:

| what was looked for | found |
|---|---|
| `cron.job` rows whose command names `web_vitals` or `page_views` | 0 |
| `public` functions whose `prosrc` names the table | 0 |
| views or matviews over the table | 0 |
| span of `recorded_at` | 2026-04-22 06:00:19Z → 2026-11-12 04:47:04Z |
| `reltuples` | 64,522 |

The tree agrees: the route, `packages/db/src/types/database.ts` and the creating
migration are the only references. FIX-049's "aggregated into platform_usage by nightly
job" and "retained 30 days" were never built. The table's RLS (creating migration, and
read on local) allows anon INSERT and public SELECT, so the publishable key can write to
it without the route.

### Read 3: the 24 h before the deploy

Window 04:56:44Z 11-11 → 04:56:44Z 11-12.

| table | rows |
|---|---|
| `page_views` | 610, all `is_bot = false`; 0 bot rows |
| `page_views.country_code`, top 8 | US 102 · SG 74 · BR 64 · FR 52 · HK 39 · IN 30 · ES 18 · AT 17 |
| `web_vitals_samples` | fleet **3,730**, the rest 62 |

The country list is still the edge set.

### Read 5: the fleet's 400s on 11-11 are Cloudflare's challenge, not the origin

§12 (a) lists 1,654 fleet `400`s on 11-11 and none on 11-10. All 1,654 are on
Cloudflare's own `/cdn-cgi/challenge-platform/…`, 1,610 of them on the `/h/b/fo/…`
submission path. Every one is a POST, with `originResponseStatus 0` and `cacheStatus
none`: Cloudflare refused the fleet's challenge submissions, and none reached Vercel.

The same path's edge status shows the turn:

| day | edge statuses on `/fo/` |
|---|---|
| 11-10 | `200` 5,783 · `400` 32 · `499` 18 |
| 11-11 | `200` 3,850 · `400` **1,610** · `499` 10 |

The 400s were at most 3 an hour until 11Z, then **238 at 12Z** and 85–159 every hour
after. That is the hour §12 (e)'s origin series fell from ~500–800 an hour to ~50–200.
On 11-12 the fleet still sends ~1,000 edge requests an hour, but reaches the origin far
less. From 02Z to 05Z that was 166 requests over 81 paths: `/icon.svg` 78, `/favicon.ico`
8, and about 80 single deep-link page renders, mostly `/donors/*`. In that span **no
fleet beacon reached the origin**; the last were 12 track-views at 00Z and 7 at 01Z.
**Cloudflare's challenge, not anything in the app, has been holding the fleet off the
origin since 11-11 12Z.**

### Read 4: the receipt

**THIN, so both receipts are owed.** The window ran from deploy success, 05:07:32Z.

| window | CF: fleet track-views forwarded (edge 200 + 499) | CF: fleet web-vitals forwarded | CF: beacons forwarded, any UA |
|---|---:|---:|---:|
| + 30 min (to 05:37:49Z) | **0** | 0 | 0 |
| + 60 min (to 06:07:49Z) | **0** | 0 | 0 |

In the hour the fleet reached the origin only for `/icon.svg` (42), `/favicon.ico` (4) and
single `/donors/*` pages. It sent no beacon, so the routes never saw it.

The one DB read covered 05:07:32Z → 06:07:58Z:

| table | rows in the window |
|---|---|
| `page_views` | 0 in total, so none flagged and no country list |
| `web_vitals_samples` | 0 from the fleet, 0 from anyone else |

0 fleet vitals is not a pass: the pass needs fleet vitals POSTs above 0.

**The zone side of FIX-1405 is on.** A read-only GET of the zone's `ip_geolocation`
setting returned `value: "on"`, so Cloudflare adds `CF-IPCountry` to what it forwards.
Whether the route sees it, and what it says, needs a forwarded track-view: that is the
owed read.

**The fleet's vitals rows began on 10-22, not 11-01.** The same read counted every row:

| `user_agent` | rows | first | last |
|---|---:|---|---|
| one of the ten | **53,047** | 2026-10-22 07:42:25Z | 2026-11-12 01:33:21Z |
| any other | 15,787 | 2026-04-22 | 2026-11-12 04:47Z |

§12's 29,412 counted 11-01 → 11-11 only.

**Owed, after deploy + 24 h (2026-11-13T05:08Z), from a full UTC day:**

- **[[FIX-1404]]:** rows with `bot_name = 'chrome-133-142'` within ±15 % of the fleet's
  forwarded track-views, and 0 fleet vitals rows while its vitals POSTs are above 0.
- **[[FIX-1405]]:** the flagged rows' countries against Cloudflare's `clientCountryName`
  for the same track-views. If the challenge keeps the fleet's beacons off the origin,
  any forwarded track-view will do: the `is_bot = false` countries against Cloudflare's
  countries for all forwarded track-views.

If the fleet never sends a beacon again, FIX-1404 cannot get its receipt from the fleet's
own traffic, and it stays `local` until one arrives.
