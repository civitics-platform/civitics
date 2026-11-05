# FIX-1379 revert — `shared_buffers` 128 MB → 256 MB (cc-255)

The rollback for lever 7. **Nothing here runs by itself.** It is the same
mechanism cc-255 used forward (OPERATIONS §pg_cron background-worker capacity,
FIX-1022: delete the key, then set it WITHOUT `--no-restart`; the update
restarts the database). Run it from the primary checkout's root in PowerShell,
one command per line, in order. A restart is 1–3 min of front-door downtime: do
it at a quiet hour (not a Tuesday, not a drop night, not inside the nightly's
~21:10Z fec phase), with the (d′) 3 h STOP row clear (PROMPT_TEMPLATE, FIX-1377).

**Before 11-05 the pool was 256 MB from Supabase's GENERATED config**
(`/etc/postgresql-custom/generated-optimizations.conf`, `source = configuration
file`) — not an override. Two reverts are therefore possible:

- **A (as written below, the prompt's form):** set `shared_buffers=256MB` as an
  explicit override. It persists across compute resizes and does not re-derive.
- **B (back to the tier's default):** `postgres-config delete --config
  shared_buffers` WITHOUT `--no-restart`, and skip the update. That deletes the
  override and restarts, and Supabase renders the generated value again (256 MB
  on this tier; it re-derives on a resize). B is one restart; so is A.

**`delete` restarts the database too unless it is given `--no-restart`** (CLI
2.78.1 `postgres-config delete --help`). In form A the delete carries
`--no-restart` so the update is the only restart.

## 0. Pre-checks (reads)

```powershell
grep "^NEXT_PUBLIC_SUPABASE_URL" .env.local
pnpm session:held
node scripts/db-query.mjs --prod "SELECT pg_postmaster_start_time(), current_setting('shared_buffers');"
node scripts/db-query.mjs --prod "SELECT name, setting, unit, source, sourcefile FROM pg_settings WHERE name IN ('shared_buffers','effective_cache_size','max_worker_processes');"
supabase --experimental postgres-config get --project-ref xsazcoxinpgttgquwvuf
```

Expect `shared_buffers` 16384 × 8 kB, `sourcefile` `custom-overrides.conf`, and
the override list `max_worker_processes = 12` + `shared_buffers = 128MB`.

## 1. Pause the dispatcher (write 1)

```powershell
node scripts/db-query.mjs --prod --call --yes-i-mean-prod "UPDATE public.platform_dials SET pause = true, updated_at = now() WHERE id;"
node scripts/db-query.mjs --prod "SELECT pause FROM public.platform_dials;"
node scripts/db-query.mjs --prod "SELECT public.get_dispatcher_status()->'live';"
node scripts/db-query.mjs --prod "SELECT pipeline, started_at FROM public.data_sync_log WHERE status = 'running';"
```

Repeat the last two until `live` is `[]` and no row is running. Never cancel a
unit; an ec-crawl inside `entity_connection_stats_windows` re-fires its window
if cancelled (cc-262).

## 2. Claim the box (a second PowerShell window; Ctrl-C releases)

```powershell
pnpm --filter @civitics/data session:claim-prod --reason "FIX-1379 revert: shared_buffers 128 -> 256 + planned restart" --minutes 45
```

The claim is a session-scoped lock held by this process's backend, so the
restart drops it with that backend. `pause` is what holds the dispatcher across the
restart; re-run the claim once the database is back if any after-read needs it.

## 3. The config change (write 2; the update restarts the database)

```powershell
supabase --experimental postgres-config delete --config shared_buffers --no-restart --project-ref xsazcoxinpgttgquwvuf
supabase --experimental postgres-config update --config shared_buffers=256MB --project-ref xsazcoxinpgttgquwvuf
```

## 4. Verify (poll until the database answers with a NEW start time)

```powershell
node scripts/db-query.mjs --prod "SELECT pg_postmaster_start_time(), current_setting('shared_buffers');"
node scripts/db-query.mjs --prod "SELECT name, setting, unit, source, sourcefile FROM pg_settings WHERE name IN ('shared_buffers','effective_cache_size','max_worker_processes');"
supabase --experimental postgres-config get --project-ref xsazcoxinpgttgquwvuf
```

Expect a new `pg_postmaster_start_time()`, `shared_buffers` 32768 × 8 kB,
`effective_cache_size` 98304 × 8 kB, `max_worker_processes` 12. A new start
time with `128MB` = the FIX-1022 trap (stored, not rendered): one more delete →
update, then stop. No answer within 10 min = the dashboard (project → Settings
→ Infrastructure → Restart).

## 5. Release and unpause (write 3)

Ctrl-C the claim window, then:

```powershell
node scripts/db-query.mjs --prod --call --yes-i-mean-prod "UPDATE public.platform_dials SET pause = false, updated_at = now() WHERE id;"
node scripts/db-query.mjs --prod "SELECT pause FROM public.platform_dials;"
node scripts/db-query.mjs --prod "SELECT ticked_at, decision, left(reason, 120) FROM public.dispatch_log ORDER BY ticked_at DESC LIMIT 5;"
```

`pause` must read false before you walk away; the tick must not stay paused
overnight.
