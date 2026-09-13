# FIX-1128 — the `statement_timeout` timing experiments, recorded verbatim

Run 2026-09-13 (UTC) against the **local clone** (PG 17, `127.0.0.1:54322`) at
`67077b2b`, in throwaway schema `fix1128_exp`, dropped at the end. SQL:
[`2026-09-13-fix1128-experiments.sql`](2026-09-13-fix1128-experiments.sql).

Every case was its own `node scripts/db-query.mjs --local --call` batch, so a
deliberate 57014 stopped only its own case. Output below is copied verbatim,
timings included.

**Case 6 ran on the clone, not on prod.** The prompt sanctioned a throwaway
prod `cron` job *only if* the clone's scheduler could not fire one. Phase 0
read 7 measured the clone's scheduler live — 38 jobs, 405 runs in the previous
24 h, most recent firing two minutes before the read — so the prod probe was
not needed and was not run.

---

## The one-line summary

`statement_timeout` is armed **once**, by the server, at the start of a
top-level client statement. Nothing inside a procedure re-arms it: not a
proconfig, not a session-level `set_config`, not a `COMMIT`. And once it has
**fired**, it is disarmed for the rest of that statement — so every unit after
a caught cancel runs with no bound at all.

| # | Question | Answer |
|---|---|---|
| 1 | Is a function-level proconfig timeout inert for the call it decorates? | **Yes** — 3 s sleep completed under `1s` |
| 2 | Does a procedure's post-COMMIT transaction arm from its own proconfig? | **Unanswerable — a procedure carrying a `SET` clause cannot `COMMIT` at all** |
| 3 | Does `set_config(…, is_local => false)` inside a procedure arm the next unit? | **No** — the value persists but arms nothing |
| 4 | Does the `LOCAL` form survive `COMMIT`? | **No** (reverts), and it arms nothing either |
| 5 | After a caught 57014, does the next unit get a fresh timer? | **No timer at all** — post-cancel units are unbounded |
| 6 | Does pg_cron run a multi-statement command, so `SET …; CALL …` is a real bound? | **Yes** — cancelled at 1.004 s |

---

## Case 1 — function, proconfig `1s`, body sleeps 3 s, session `60s`

```
SET statement_timeout = '60s';
SELECT fix1128_exp.c1_fn();
```

```
SET
Time: 0.583 ms
NOTICE:  c1 inside fn, current_setting = 1s
                    c1_fn
----------------------------------------------
 c1 COMPLETED a 3s sleep under a 1s proconfig
(1 row)

Time: 3004.778 ms (00:03.005)
```

**Conclusion.** The proconfig is inert: `current_setting()` reads `1s` inside
the function and the 3 s sleep completes. This is the mechanism the whole FIX
rests on, re-proved on the tree of record.

---

## Case 2 — procedure, proconfig `1s`, `COMMIT` then sleep 3 s

```
SET statement_timeout = '60s';
CALL fix1128_exp.c2_proc();
```

```
SET
Time: 0.582 ms
NOTICE:  c2 before COMMIT, current_setting = 1s
ERROR:  invalid transaction termination
CONTEXT:  PL/pgSQL function fix1128_exp.c2_proc() line 4 at COMMIT
Time: 1.293 ms
```

**Conclusion — the case does not exist.** A procedure that carries *any* `SET`
clause runs in an atomic context and **cannot execute transaction control at
all**. The question "does the post-COMMIT unit arm from the proconfig?" has no
answer, because the two cannot coexist.

This matters beyond case 2: it is why the census is 91 functions and **zero**
procedures, and it removes the only legitimate case the design imagined for the
`check:proconfig` escape hatch (see the guard's header).

---

## Case 3 — procedure, no proconfig, SESSION `set_config` then `COMMIT` then sleep 3 s

```
PERFORM set_config('statement_timeout', '1s', false);
COMMIT;
PERFORM pg_sleep(3);
```

```
SET
Time: 0.582 ms
NOTICE:  c3 before COMMIT, current_setting = 1s
NOTICE:  c3 after  COMMIT, current_setting = 1s
NOTICE:  c3 COMPLETED the post-COMMIT 3s sleep
CALL
Time: 3004.668 ms (00:03.005)
 statement_timeout
-------------------
 1s
(1 row)
```

**Conclusion — this refutes the design's C1 fix.** The session value *does*
survive the `COMMIT` (`current_setting` still reads `1s` after it, and still
`1s` back in the caller's session afterwards). It arms **nothing**. The 3 s
sleep completed under a nominal 1 s setting, because the only armed timer is
the one the server started when the top-level `CALL` began, from the session
value at *that* moment (60 s).

D2's `PERFORM set_config('statement_timeout', <unit budget>, false)` before each
unit would therefore change what `current_setting()` reports and bound nothing —
the same class of decoration Half 1 is removing, one level up.

---

## Case 4 — the `LOCAL` form

```
PERFORM set_config('statement_timeout', '1s', true);
```

```
NOTICE:  c4 before COMMIT, current_setting = 1s
NOTICE:  c4 after  COMMIT, current_setting = 1min
NOTICE:  c4 COMPLETED the post-COMMIT 3s sleep
CALL
Time: 3004.836 ms (00:03.005)
 statement_timeout
-------------------
 1min
(1 row)
```

**Conclusion.** The `LOCAL` value dies at the `COMMIT` exactly as expected
(`1s` → `1min`, the session value) — recorded so nobody later "simplifies"
case 3's form to `SET LOCAL`. But note the sleep completed here for the same
reason as case 3, not because the value reverted: neither form arms anything.

---

## Case 5 — the unit loop, as the design specified it

```
PERFORM set_config('statement_timeout', '1s', false);
COMMIT;
BEGIN PERFORM pg_sleep(3);   ... EXCEPTION WHEN query_canceled ... END;  COMMIT;
BEGIN PERFORM pg_sleep(0.5); ... EXCEPTION WHEN query_canceled ... END;  COMMIT;
BEGIN PERFORM pg_sleep(3);   ... EXCEPTION WHEN query_canceled ... END;
```

```
NOTICE:  c5 unit1 (3s)   COMPLETED
NOTICE:  c5 unit2 (0.5s) COMPLETED
NOTICE:  c5 unit3 (3s)   COMPLETED
CALL
Time: 6505.901 ms (00:06.506)
 statement_timeout
-------------------
 1s
(1 row)
```

**Conclusion — as written, this case cannot answer its own question.** Nothing
was cancelled (case 3's mechanism), so there is no caught 57014 to ask about.
6.5 s of sleeping ran to completion with the session reading `1s` throughout.

### Case 5b — forcing the cancel from where it can actually come

The bound has to come from the top-level statement, so: session `4s`, units of
3 s / 3 s / 0.5 s.

```
NOTICE:  c5b unit1 (3s)   COMPLETED
NOTICE:  c5b unit2 (3s)   CANCELLED 57014
NOTICE:  c5b unit3 (0.5s) COMPLETED
CALL
Time: 4501.632 ms (00:04.502)
 statement_timeout
-------------------
 4s
(1 row)
```

Unit 2 was cancelled at the 4 s deadline and caught. Unit 3 then ran **past**
that deadline — total 4.50 s against a 4 s bound.

### Case 5c — separating "freshly re-armed" from "unbounded"

4.5 s vs 4 s is too small a margin to distinguish the two. Session `4s`, units
of 6 s then 10 s:

```
NOTICE:  c5c unit1 (6s) CANCELLED 57014
NOTICE:  c5c unit2 (10s) COMPLETED — post-cancel units are UNBOUNDED
CALL
Time: 14008.147 ms (00:14.008)
```

**Conclusion — FIX-703's failure mode did NOT reproduce, and the actual
behaviour is the opposite one.** There is no "instant re-timeout after a caught
cancel" on PG 17. When `statement_timeout` fires, the server disarms it, and
nothing inside the procedure re-arms it — so a procedure that catches
`query_canceled` and continues runs **every remaining unit with no bound at
all**. 14.0 s of work completed under a 4 s statement timeout.

For the FIX-1112 handler shape this is the important one: catching the cancel
and carrying on is not "degraded but still bounded", it is *unbounded from that
point onward*. Half 2 has to plan for that.

---

## Case 6 — pg_cron multi-statement command (on the clone)

```
SELECT cron.schedule('fix1128-probe', '* * * * *',
         $$SET statement_timeout='1s'; SELECT pg_sleep(3)$$);   -- jobid 74
```

```
 jobid |    jobname    | schedule  | active |                    command
-------+---------------+-----------+--------+------------------------------------------------
    74 | fix1128-probe | * * * * * | t      | SET statement_timeout='1s'; SELECT pg_sleep(3)
```

One firing, then `cron.unschedule('fix1128-probe')` in the same session
(`unscheduled = t`, `remaining = 0`):

```
 jobid | runid | status |                    return_message                    |          start_time           |           end_time            |     elapsed
-------+-------+--------+------------------------------------------------------+-------------------------------+-------------------------------+-----------------
    74 | 12472 | failed | ERROR:  canceling statement due to statement timeout+| 2026-09-13 03:14:00.040133+00 | 2026-09-13 03:14:01.044697+00 | 00:00:01.004564
```

**Conclusion — pg_cron runs a multi-statement command, and the `SET` in front
of it is a real bound.** The 3 s sleep was cancelled at 1.0046 s. The `SET` is
its own statement, so the statement that follows it arms from the new value.

Given case 3, this is not merely "C2's cheapest option" as the design framed
it — **it is the only mechanism in the whole experiment set that bounds a
pg_cron procedure at all**, and it therefore applies to C1 as much as to C2.

---

## What this means for Half 2 (cc-125), in one paragraph

The design's D2 — arm each C1 unit from inside the procedure with a
session-level `set_config` — does not work and should not be built. Cases 3 and
5 say the value is decoration wherever it is written *inside* a procedure. The
bound for any pg_cron procedure has to be set by the job's command string
(case 6), which bounds the **whole CALL**, not a unit. A per-unit budget
therefore needs a different mechanism entirely — the procedure measuring its own
elapsed time against a budget and choosing to stop, which is what the existing
`cron_job_budget` watchdog (FIX-1063/1125) already does in principle, or the
unit being its own top-level statement. And whatever Half 2 does, it must
account for case 5c: one caught cancel removes the bound from every unit that
follows it.
