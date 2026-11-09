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
38 Cloudflare GraphQL Analytics queries and two Cloudflare REST GETs with the
existing token. No write anywhere: not prod, Upstash, Cloudflare or Vercel.
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
