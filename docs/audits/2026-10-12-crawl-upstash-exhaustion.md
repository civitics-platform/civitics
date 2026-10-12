# 2026-10-12 crawl: Upstash exhausted, Vercel spike, 04:11Z restart, enrichment-tail partial (cc-229)

Read on 2026-10-12 between 22:58Z and 23:12Z by cc-229, with the prod-reads posture: `db-query.mjs --prod`
(READ ONLY), `cf-analytics.mjs` (GraphQL), the Supabase Logs API through
`data:census:cancellations:prod`, the Upstash ring through `data:box-health:series`,
and `gh run view`. No prod write, no `cron.*` change, no Cloudflare, Upstash or Vercel
change. "Prod" means the Supabase Pro project `xsazcoxinpgttgquwvuf`. Every number
names the read (R0–R8) it came from.

**The verdict in one line:** a crawl hit the Vercel origin **around Cloudflare**
three times in 23 hours: ~445k Supabase-gateway requests in total, while Cloudflare logged
6,170 requests for the whole day. It spent the rate limiter's Upstash allotment, and its
morning wave pushed the box out of swap and into the 04:11Z restart. The front-door
auto-restart did not cause that restart. It is now **disarmed** until Upstash's quota resets.

---

## §A Timeline (UTC)

| when | event | read |
|---|---|---|
| 10-11 19:30Z | **Burst 1 starts.** Supabase-gateway requests go from 151 to 12,712 per 15 min. Cloudflare logs 86 requests for the 19Z hour and 287 for 20Z | R5, R4 |
| 10-11 20:45Z | Burst 1 ends (633 per 15 min). **98,026** requests in 75 min, 12 5xx. The Upstash counter steps up **+52,545** between the 19:01Z and 22:01Z snapshots | R5, R2 |
| 10-12 01:34Z | The box is already near its swap ceiling before any burst: swap used **989 of 1,024 MB** | R6 |
| 10-12 03:15Z | **Burst 2 starts** (9,790 per 15 min, up from 339) | R3, R5 |
| 03:53:00Z | `platform-counts-daily` starts. Its run ends `server restarted` | R3 |
| 04:00:09Z | `ec-crawl` starts. Its run ends `server restarted` | R3 |
| 04:00:23Z | Ring sample: **swap 1,023 of 1,024 MB, MemAvailable 210 MB, load1 13.97**. The 04:00 gateway bucket has 13,344 requests, **9,183 5xx, 7,277 52x** (RED) | R6, R3 |
| 04:02Z, 04:07:02Z | `job startup timeout` firings, so the old scheduler is still alive at 04:07 | R3 |
| **04:11:32Z** | **`pg_postmaster_start_time()`: the current epoch begins.** The front-door arm logs `action: none`, `down_ticks: 0`, `state_store: ok` on every tick | R3 |
| 04:12:22Z | The ring resumes after a 12-min gap: swap 186 MB, MemAvailable 524 MB | R6 |
| 04:45Z | Burst 2 ends (126 per 15 min). **61,990** requests in 90 min. Upstash steps up +15,016 (03:31→04:31Z) and then +31,355 (04:31→07:01Z) | R5, R2 |
| 16:30Z | **Burst 3 starts** (20,959 per 15 min, up from 129). It peaks at **37,132** in the 16:45 bucket | R5 |
| 17:56:22Z | The day's lowest MemAvailable: **183 MB** | R6 |
| 19:15Z | Burst 3 ends (63 per 15 min). **284,819** requests in 2 h 45 min, 31 5xx. Upstash steps up **+134,475** (16:01→19:01Z) | R5, R2 |
| 20:00–21:00Z | 66 cancelled renders (37 `get_jurisdiction_page`) on only ~400 gateway requests. The box is still swapping: swap 898 MB at 19:54Z, swap-in 1,867/s at 19:32Z | R5, R6 |
| **20:30:22Z** | **The last ring write that landed.** No ring sample after it, while the route keeps running (`box_health_mem` was stamped at 23:00:23Z). So Upstash has refused writes since **~20:30–20:32Z, which is the exhaustion instant** | R6, R1 |
| 21:00:12Z | Nightly dispatched (`gha_dispatch_nightly`, HTTP 204) | R1 |
| 21:15:25Z | `ai-summaries` work-list read cancelled by statement timeout. `enrichment-tail` ends `partial` after 395.9 s, and the GHA job reports `failure` | R0 |
| 21:16Z | The receipts job's ring read is refused: `Limit: 500000, Usage: 500001` | receipts 10-13 §9 |
| 22:01Z | The Upstash counter freezes at **499,669** | R2 |
| 22:30:46Z | `upstash_limiter_health` flips `healthy → quota_exhausted`, **2 h after the writes stopped** | R1 |
| 22:00–23:00Z (last complete hour) | Cloudflare: 93 requests. Gateway: 7, 5 and 1 per 15 min. **The crawl is not running** | R4, R5 |

---

## §B The four questions

### B1. Why is Upstash over quota? (R1, R2, R6)

Three bursts of **off-Cloudflare** traffic spent the rate limiter's allotment. The Upstash
counter (`platform_usage_snapshot`, Management API `total_monthly_requests`, which lags
enforcement) moved in steps that line up with the gateway bursts:

| snapshot step | Δ commands | matches |
|---|---|---|
| 10-11 19:01 → 22:01Z | +52,545 | burst 1 |
| 10-12 03:31 → 04:31Z | +15,016 | burst 2 |
| 10-12 04:31 → 07:01Z | +31,355 | burst 2 (the counter lags) |
| 10-12 07:01 → 16:01Z | +2,538 in 9 h | **baseline ≈ 141 per 30 min** |
| 10-12 16:01 → 19:01Z | +134,475 | burst 3 |
| 10-12 19:01 → 22:01Z | +123,780 | burst 3, plus the tail up to exhaustion |
| 10-12 22:01 → 23:01Z | 0 (frozen at 499,669) | over quota |

- The bursts account for **357,171** commands. The gateway logged **444,835** requests
  in the same bursts, about 1.25 gateway calls per limiter check. That fits one entity-page
  render per check (`get_official_page` / `get_jurisdiction_page` plus a side read).
- **Acceleration began** in the 10-11 19:01→22:01Z step (burst 1 started at 19:30Z).
- **The cap was hit** at ~20:30–20:32Z on 10-12. The ring's 2-min LPUSH+LTRIM landed
  every time from 19:15Z to 20:30:22Z (no gaps) and has not landed since. The gateway
  burst had ended at ~19:15Z, so ~75 min of spend comes after it. That fits the crawl
  continuing against **edge-cached** pages: middleware runs the limiter before the cache
  answers, so a cached page costs one check and no Supabase call. **This is not proven**;
  Vercel's request log would settle it.
- **Spend:** the counter read 121,016 at 10-10 21:08Z and 123,462 (24.7 %) at 10-11
  00:08Z, so ~376.5k commands went into the ~44 h before the cap.

`cf_origin_requests_hourly` across the spike, from R2 (each snapshot carries the previous
complete hour), against the mitigation loop's **3,000/hr** trigger:

| snapshot | 16:01 | 17:01 | 18:01 | 19:01 | 20:01 | 21:01 | 22:01 | 23:01 | 04:31 (burst 2) |
|---|---|---|---|---|---|---|---|---|---|
| origin req/hr | 64 | 108 | 128 | 141 | 201 | 382 | 146 | 62 | 225 |

The highest value in 48 h is **384**. The loop's trigger never held.

### B2. Why did Vercel usage spike? (R2, R5)

The same crawl reached the Vercel origin directly. The snapshot's Vercel figures are
month-to-date and land about once a day near 07:00Z, so the 10-12 day is not in them
yet:

| `function_invocations` raw (MTD) | value | Δ |
|---|---|---|
| landed 10-11 07:38Z | 99,998 | +25,239 |
| landed 10-12 07:31Z | 149,412 | **+49,414**, most likely the 10-11 billing day, i.e. burst 1 (2× the day before) |

Bursts 2 and 3 (346,809 gateway requests) land in the ~07:00Z snapshot on 10-13.
`edge_requests.raw_window_value` reads **0 in all 99 rows**: the charges API does not
meter it, so it cannot be used as a rate.

### B3. What restarted prod? (R3, R6)

- **The restart instant was not 03:53Z.** `pg_postmaster_start_time()` reads **2026-10-12
  04:11:32.480Z** (uptime 18:50:52 when read). 03:53:00Z is when `platform-counts-daily`
  *started*. pg_cron marks a run `server restarted` when it finds it still `running` on the new
  postmaster's startup. That happened to `platform-counts-daily` (03:53) and `ec-crawl` (04:00:09).
  Startup timeouts at 04:02 and 04:07:02Z show the old scheduler was still alive, so the old
  postmaster went down **between 04:07:02Z and 04:11:32Z**.
- **The front-door auto-restart did NOT do it.** Every `front_door_watch` tick from 01:30Z
  to 05:45Z reads `restart.action: "none"`, `down_ticks: 0`, `state_store: "ok"`,
  `issued: null`, `emailed: null`. Only one bucket went RED (04:00, 7,277 52x of 13,344),
  and the Logs arm needs **two consecutive** RED closed buckets to count a DOWN tick. The
  04:15 tick read `no sustained 52x`, the 04:45 tick read `recovered`, and the state store
  was reachable throughout because the quota was not yet spent. **Check your inbox for
  `front-door` mail around 03:50–04:30Z; per these rows, none was sent.**
- **The restart coincided with the ramp (crawl → wedge → restart).** Burst 2 started at 03:15Z.
  The box had started the night near its swap ceiling (989 MB at 01:34Z). The ring at
  04:00:23Z read **swap 1,023 of 1,024 MB, MemAvailable 210 MB, load1 13.97**, and the
  next sample was 04:12:22Z (swap 186 MB). In the 03:00–04:30Z window, MemAvailable bottomed
  at 210 MB (04:00:23Z) and swap-in peaked at 1,177.5/s (03:04:22Z). The crawl kept going
  through the restart and ended at ~04:45Z.
- **Not readable tonight:** who restarted it (a Supabase health action or an OOM-driven
  postmaster exit) and the restart class. `postgres_logs` is outside this prompt's
  posture. cc-204's method answers it: grep `postgres_logs` for `received fast
  shutdown request` and `was not properly shut down`. `box_health_mem.oom_kill` reads
  **0** at 23:00:23Z, so either no kernel OOM kill has happened since the VM last booted, or
  a reboot reset the counter. The two cannot be told apart from here.

### B4. Why did `enrichment-tail` go partial? (R0)

`ai-summaries` **failed with a statement timeout**. The cause was not Anthropic (the run is in
queue mode, `Mode: queue — staging to enrichment_queue, no API calls`) and not a kill
switch. The GHA log (run 38307846855):

```
2026-10-12T21:15:25.0442890Z [nightly] ai-summaries failed: ai-summaries open-proposals work list read failed: canceling statement due to statement timeout
2026-10-12T21:15:25.0452954Z   Errors (1): AI summaries: ai-summaries open-proposals work list read failed: canceling statement due to statement timeout
2026-10-12T21:15:25.9308343Z Nightly phase 'enrichment-tail' completed with 1 error(s) — exiting 1 (FIX-757)
```

`data_sync_log` agrees:

| started_at | status | errors | ai | duration |
|---|---|---|---|---|
| 10-12 21:08:49.104Z | **partial** | `["AI summaries: … canceling statement due to statement timeout"]` | tag_ai complete (0 entities), tag_rules complete, **ai_summaries failed** | 395.9 s |
| 10-11 22:43:49.458Z | complete | `[]` | all complete | 550.6 s |
| 10-10 22:28:10.097Z | complete | `[]` | all complete (tag_ai 184) | 449.2 s |

The failing statement is the supabase-js work-list read in `fetchOpenProposals`
(`packages/data/src/pipelines/ai-summaries/index.ts:160-168`): `proposals` filtered
`metadata->>comment_period_end > now`, ordered by the same expression, limit 200. It ran
~8.5 s (21:15:16.566Z → 21:15:25.044Z), which matches the service_role 8 s cap. The
expression index `proposals_metadata_comment_period_end_expr` (migration
`20260524100001`) backs it, and the same read passed the previous two nights. The R5 census
counts one `proposals` cancellation in the 21Z hour. **No code bug is shown.** This looks like a
transient cancel on a box still recovering from burst 3 (ring dark after 20:30Z; 66
cancelled renders in the 20Z hour). No FIX is filed for it, as the prompt asked. If it recurs,
EXPLAIN that read on prod before blaming load.

---

## §C The crawl (R4, R5)

**Cloudflare never saw it.** From `cf-analytics.mjs`, window 10-11 23:01:56Z → 10-12
23:01:56Z:

- **6,170 requests in 24 h.** The busiest hour was 619 (08Z). 2,659 got 200 and 2,936 got 403
  (47.6 % mitigated). **429: zero.** 5xx: 25 (500 ×24, 504 ×1).
- In burst 3's window (`--since 2026-10-12T16:00Z --hours 4`), Cloudflare saw **1,138
  requests** from 271 IPs and 72 UAs. The Supabase gateway saw **284,819**, so **Cloudflare
  carried 0.4 % of it.** Burst 2's window (03–05Z): 490 requests from 136 IPs. The 10-11
  hourly series has no hour above 475.
- Host split: `www.civitics.com` 4,348 (70.5 %), `civitics.com` 1,771, port variants 51.
  **A `*.vercel.app` host cannot appear in this dataset**, because it is not in the zone.
  So the 08-15 audit's H2 ("traffic hitting `*.vercel.app` directly — KILLED") cannot be
  re-confirmed from Cloudflare. On tonight's numbers **H2 is the live hypothesis**: the
  limiter was spent (so the requests passed through Vercel middleware) and Cloudflare did
  not count them.
- Day-level shape, for the record: 1,315 distinct IPs (top 20 cover 56.7 %, top 30 cover
  63.1 %); 190 distinct UAs (top 20 cover 69.7 %, top: empty UA 564, then a Chrome/155
  string 474 and `curl/8.5.0` 434); 1,472 distinct paths (top: `/` 628,
  `/api/notifications` 313, `/donors/8a8d1487-…` 198, `/officials` 149, the usual exploit
  probes for `.env`, `wp-*` and so on). **None of these is the crawl.**

**The crawl's own identity** (distinct IPs, the coverage ladder, UA strings, path families,
host) is **not capturable from here**. It lives only in Vercel's request log. To get it:
Vercel dashboard → Observability / Logs, 2026-10-12 16:30–19:15Z, filter path prefix
`/officials/` and `/jurisdictions/`, then group by host, user agent and IP. What the DB side
does show: the cancelled renders are `get_official_page` (96 renders) and
`get_jurisdiction_page` (48), so the crawl walked the **entity-leaf families** that the
`entity_leaf` bucket guards.

**Front-door cost (R5, Logs API).** Cancellation census over 10-11 23:00Z → 10-12 23:00Z:
**297 renders (496 events)** against λ 47.5 at the 0.033/min baseline, a **ratio of 6.25:
FAIL**. Pages: `get_official_page` 96 / 149, `get_jurisdiction_page` 48 / 118,
`get_ec_crawl_health` 29 / 31 (the FIX-1293 background).

| | gateway requests | 5xx | 5xx rate | cancelled renders |
|---|---|---|---|---|
| burst 1 (10-11 19:30–20:45Z) | 98,026 | 12 | 0.012 % | (outside the 24 h census) |
| burst 2 (10-12 03:15–04:45Z) | 61,990 | 9,417 | **15.2 %** (9,183 in the 04:00 bucket) | 167 (03Z 103, 04Z 64) |
| burst 3 (10-12 16:30–19:15Z) | 284,819 | 31 | **0.011 %** | 24 (16Z 4, 17Z 7, 18Z 13) |
| after burst 3 (20Z) | ~396 | — | — | 66 |

Baseline p0 is 0.23 %. **Burst 3 was the largest and cost the least**: the role bound
cancelled the slow renders and the box held. **Burst 2 cost real renders and a restart**,
because it arrived on a box already at its swap ceiling. The 20Z cancellations came after
burst 3, on ordinary traffic, while the box was still swapping.

**Still running?** No. In the last complete hour (22Z), Cloudflare logged 93 requests and the
gateway logged 7, 5 and 1 per 15 min. With the limiter on memory fail-over, Upstash can no
longer show a resumed crawl. **The gateway series is now the instrument for that.**

---

## §D Blast radius while over quota (R7, R6)

**The front-door auto-restart is DISARMED for as long as the quota is exhausted.** Its state
lives in the same Upstash database (`front-door-restart.ts:47-51`):

> When Upstash does not answer, the decision is `none` — fail SAFE (no restart), never fail open.

```ts
// front-door-restart.ts:149-153
if (input.stateError) {
  return { action: "none",
    reason: `state store unreachable (${input.stateError}) — fail safe, no restart`, … };
```

That is half of it. **The other half is that the hold is a write.** The tick counter
advances with `["INCR", K.downTicks]` (`:306`), and `countDownTick` computes
`downTicks = (stored?.downTicks ?? 0) + 1` (`:216`). Over quota, reads land
intermittently: R6's LRANGE landed 3 of 3 at 23:06Z, the receipts' read was refused at
21:16Z, and the probe's PINGs read healthy at 21:01, 21:31 and 22:01Z. Writes do not land:
**none of ~75 consecutive 2-min ring writes after 20:30:22Z landed**. So on a tick where the
MGET lands and `state_store` reads `ok`, the INCR still fails (`state_write: FAILED`), the
stored count stays null, `down_ticks` sticks at 1, and the 4-tick restart can never fire.
**Both paths end the same way: no auto-restart until Upstash comes back.** A 10-06-class
wedge (8 h 40 m, ended only by hand) is unbounded again until then.

**The rate limiter fails over and does not fail open, as FIX-1038 intended.** `checkRateLimit` is
documented `NEVER throws` (`ratelimit.ts:370`). On any Upstash error (`:432-445`):

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  // 3. Fail OVER, not open.
  noteMode("memory", message);
  …
  return memoryLimit(bucket, identifier);
}
```

`memoryLimit` (`:345-367`) is a **per-instance** fixed-window counter on the same
`BUCKET_LIMITS`. It can return 429, never 500. The caps now apply per edge instance rather than
globally, so a distributed crawler meets them even less often than before. Under the 08-15
reading (busiest IP 25× under the strictest cap) that changes little, because the limiter
was never going to stop a distributed crawl.

**The saturation gate is not blinded; only the series is.** The box-health route writes
off-box first and then mirrors on-box (`box-health/route.ts:15-21`; `runBoxHealth`).
`pipeline_state.box_health_mem` was stamped at **23:00:23Z** (R1), 2.5 h after the last
ring write, so the mirror keeps working. `box_is_saturated()` reads the per-minute probe's
age, and `pipeline_state.box_health` was stamped at **23:01:00Z** (R1). What is lost is
the off-box ramp, which is exactly what a wedge investigation needs.

**FIX-1289's banked window:** receipts 10-13 reads `Memory window … 2026-10-11T21:00Z
→ 2026-10-12T21:00Z, **not banked**` (`receipts-format.ts:956`) because the 21:16Z ring
read was refused. **That is a quota artefact, not a FIX-1289 defect.** For cc-219's
verifier, read 1b: the ring itself **still holds that window up to 20:30:22Z** (R6 read
900 samples, 629 in the last 24 h). A retried read banks everything except the last ~30
min. Retries do land (3 of 3 tonight).

**The detection gap.** `upstash_limiter_health` probes with three PINGs on the
**30-min** `platform-snapshot` Vercel cron. PINGs are reads, and reads keep landing over
quota. That is why the state read `healthy` until 22:30:46Z, two hours after the
limiter's sliding-window writes started failing. Its `since` is not the exhaustion time.
The ring is.

---

## §E Recommendations (options for Craig, recommendation first)

1. **(Recommended) Close the off-Cloudflare path to the Vercel origin, after confirming the
   host.** The prompt anticipated a WAF rule scoped to the crawl's signature (one UA or IP
   range carrying ≥ 80 %). **That does not apply**, because Cloudflare saw 0.4 % of
   the crawl and has nothing to scope a rule to. The 08-15 audit's D2 option 6
   ("Origin-hostname lockdown — real exposure, but H2 says it is not the leak") ranked
   this last. Tonight it is the leak. Steps:
   - First, read the host from Vercel's request log (§C). It is either the
     `*.vercel.app` production alias or direct-to-Vercel traffic with a `civitics.com`
     Host header.
   - Then pick one of two shapes:
     - **Vercel-side:** Deployment Protection, or retiring the public `*.vercel.app`
       alias, if that is the host.
     - **Origin-auth:** a Cloudflare Transform Rule stamps a secret request header, and
       middleware refuses requests without it. This is the FIX-1057 probe-header pattern
       turned around. Exempt `/api/cron/*`, which already authenticates with
       `CRON_SECRET`; the request-path probe already rides Cloudflare.
   - CC does not make either change. This is the change that makes "Cloudflare owns the
     class" (the `ratelimit.ts` header) true again.
2. **Move the control plane off the rate limiter's command budget.** The box-health ring
   and the front-door restart state should live on an Upstash database the limiter never
   touches: a second free database or a paid tier, your call. The code change is one
   creds-selection seam in `box-health-store.ts` (`upstashRequest`, `UpstashCreds`) and in
   `front-door-restart.ts`. **Filed as FIX-1304.** Tonight shows the coupling at its
   worst: the crawl that wedges the box is also the thing that disarms the restart.
3. **Cloudflare mitigation loop: nothing to change.** `cf_mitigation_loop.tripped` is
   null, `breaches: []`, `transitions: []`, last written 15:00:49Z (R1). Its trigger
   (≥ 3,000 origin req/hr) peaked at **384** (R2), so it was right not to act. It
   is **blind by construction** to traffic that skips Cloudflare. Option 1 is what brings
   this class back into its view. No loop FIX.
4. **The tail: no code bug.** It was a transient 8 s cancel on an indexed read (§B4). No FIX. If
   it recurs, EXPLAIN on prod first.
5. **Make the limiter-health probe see what the limiter sees.** Swap one of its three PINGs
   for a write-class command (an INCR on a short-TTL key) so `quota_exhausted` is recorded
   when writes start failing, not 2 h later. This is folded into option 2's FIX body
   rather than filed on its own.

**The standing risk until the quota resets:**
- The auto-restart arm is disarmed.
- The limiter is per-instance memory.
- The off-box memory ring is dark.
- Receipts memory windows do not bank.

**When the reset comes (R8):** the tree and the observations disagree.
- **The tree says the 13th.** `upstash-usage.ts:296-304` (FIX-1089) anchors the period on the
  database's creation anniversary, 2026-06-13T07:51:33Z, which makes the next reset
  **≈ 2026-10-13 07:51Z**.
- **The only reset ever observed was at a calendar-month boundary.** `upstash_limiter_health.transitions`
  logs `quota_exhausted → healthy` at **2026-09-01T00:01:16Z**, after the 08-30/31 flapping,
  and then nothing until 10-12. Under the 13th anchor the September period would have stayed
  exhausted until 09-13 07:51Z, and a probe that logged 19 transitions between 08-30
  09:01Z and 09-01 00:01Z would have caught it.
- So the reset is either **10-13 ~07:51Z** or **11-01 00:00Z**, a 19-day difference for every risk
  listed above. Watch `upstash_limiter_health` flip to `healthy`. If it has not flipped by
  ~10-13 08:30Z, the calendar basis holds and FIX-1089's anchor is wrong. The Upstash
  console was not called.

**FIX filed:** FIX-1304 (🟠 S, lane ops). The front-door auto-restart is disarmed whenever
Upstash is over quota; move the restart state and the box-health ring off the rate
limiter's command budget. No tail FIX: R0 shows no code bug. No loop FIX: its trigger never
held. Nothing filed for the crawl itself, per the prompt (but see §F item 4).

---

## §F Premise corrections

1. **"cc-221 measured the same quota at 8.6 % at Sun 00:12Z, so ~457k were spent in ≤ 45 h."**
   cc-221's 8.6 % is the ring's *projected* monthly share (1,440 commands/day ≈ 43k/month,
   `cc-221.md:158`), not a reading. The snapshot read **123,462 (24.7 %)** at 10-11
   00:08Z, so the real spend was **~376.5k in ~44 h**, 357k of it inside the three bursts.
2. **"Prod restarted ~03:53Z."** The postmaster started at **04:11:32Z**. 03:53Z is when
   `platform-counts-daily` started, and its run was the one the restart killed.
3. **"Candidates: the cc-206/208 front-door auto-restart."** Ruled out: `action: none` on every
   tick, with only one RED bucket.
4. **"Nothing for the crawl itself (Cloudflare owns the class)", and the R4 premise that
   the crawl is in the Cloudflare dataset.** The crawl bypassed Cloudflare. Cloudflare owns
   the class only for traffic routed through it. The prompt's §6 rule was followed (no crawl
   FIX), but the premise behind it did not hold tonight. Option 1 in §E is the decision that
   rule was standing in for.
5. **"FIX-1038's 10-min probe records upstash→memory."** The probe rides the **`*/30`**
   `platform-snapshot` Vercel cron: transitions land at :00:35/:30:46 and R2 rows are
   30 min apart. `ratelimit.ts:268` ("every 10 minutes") and `upstash-usage.ts:57` ("144
   ticks") are stale. The states are `healthy` / `quota_exhausted`, not upstash/memory.
6. **"The `since` of the current degraded state is the exhaustion time, to ±10 min."**
   `since` = 22:30:46Z is **~2 h late** because PINGs land over quota. The ring's last
   landed write (20:30:22Z) dates it to ±2 min.
7. **"~50/30-min baseline."** The measured baseline is **~140 per 30 min**: +1,724 over 10-11
   01:08→07:08Z, and +2,538 over 10-12 07:01→16:01Z.
8. **R8: "the Sept cycle reset ≈ 09-13; today is the last day."** The only observed reset is
   09-01T00:01:16Z (R1). "The last day of the cycle" holds for Vercel's billing cycle
   but is not established for Upstash's (§E, R8).
9. **R7: "Upstash unreadable ⇒ decision `none`."** True but incomplete. The hold also needs a
   **write** (INCR), and writes are what fail over quota, so a readable store still cannot
   arm the restart.
10. **R4: "the host split (`civitics.com` vs `*.vercel.app`)".** A `*.vercel.app` host
    cannot appear in the zone's analytics. The 08-15 H2 check used `vercel logs`, which this
    prompt's posture excludes.
