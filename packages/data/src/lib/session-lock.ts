/**
 * FIX-950 — the named session lock, lifted out of FIX-1067's FEC interlock.
 *
 * WHY THIS IS A LIFT AND NOT A NEW MODULE. `pipeline-lock.ts` already got every
 * decision right, and the reasoning is recorded there rather than repeated here:
 * SESSION-level `pg_try_advisory_lock` on a DEDICATED connection held for the
 * work's lifetime (so a dead holder strands nothing and there is no TTL to
 * tune), TRY and never wait (a blocked run should exit in seconds, not sit
 * burning budget to then start a heavy write phase against a saturated box),
 * and FAIL OPEN on an infrastructure error (a process that cannot reach the DB
 * cannot write to it either; refusing to run on a lock-connection blip converts
 * a nuisance into a missed ingest).
 *
 * FIX-950 needs the same lock under a second name — `prod_supervised_session` —
 * so the mechanism moves here and `pipeline-lock.ts` becomes one instance of
 * it. Its tests are unchanged and still pass, which is the only proof that the
 * lift preserved behaviour.
 *
 * ── WHAT THIS ADDS OVER THE FEC VERSION ─────────────────────────────────────
 * An optional LABEL: a `pipeline_state` row upserted on acquire and DELETEd on
 * release. The lock is the truth and the label is documentation — a supervised
 * session needs to say WHY it holds the box, and `pg_locks` has room for a pid
 * and nothing else. The label write is best-effort in both directions: a failed
 * upsert logs and the session proceeds (the interlock still works, it is just
 * unexplained), and a failed delete leaves a row that `prod_session_state()`
 * reports as `label_stale` and the next claim overwrites. Nothing about the
 * label can fail a claim, because a documentation write that can veto the
 * safety mechanism is worse than no documentation.
 */

import type { Client } from "pg";
import { buildDbUrl } from "./heavy-rebuild";

/** A held (or bypassed, or failed-open) named session lock. */
export interface NamedSessionLock {
  /** True when the caller may proceed — lock held, bypassed, or failed open. */
  readonly acquired: boolean;
  /** Why the lock was not acquired — set only when `acquired` is false. */
  readonly blockedBy?: string;
  /** Release the lock, drop the label, close the connection. Safe to call twice. */
  release(): Promise<void>;
}

/** The `pipeline_state` row a lock holder writes to explain itself. */
export interface SessionLockLabel {
  /** `pipeline_state.key` — one key per lock name. */
  key: string;
  /** The row's jsonb value. */
  value: Record<string, unknown>;
}

export interface AcquireNamedLockOptions {
  /** Log prefix, e.g. "fec-lock" / "prod-session". */
  logTag: string;
  /** FIX reference appended to every log line from this instance. */
  ref: string;
  /** Optional best-effort label row (see the module header). */
  label?: SessionLockLabel;
  /** Optional richer description of the holder for the refusal message. */
  describeHolder?: (client: Client) => Promise<string>;
  /** Override the DSN. Defaults to buildDbUrl(). */
  dbUrl?: string;
}

/** A lock object for the bypassed / failed-open case: nothing is held. */
export function noopLock(): NamedSessionLock {
  return { acquired: true, async release() { /* nothing held */ } };
}

export function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Try to take a named SESSION advisory lock on a dedicated connection.
 *
 * Returns `{ acquired: true }` when the caller may proceed (lock held or failed
 * open on an infra error) and `{ acquired: false, blockedBy }` when another
 * holder is live. The caller MUST `release()` in a `finally`.
 */
export async function acquireNamedSessionLock(
  name: string,
  opts: AcquireNamedLockOptions,
): Promise<NamedSessionLock> {
  const tag = `  [${opts.logTag}]`;

  let client: Client;
  try {
    const { Client: PgClient } = await import("pg");
    client = new PgClient({ connectionString: opts.dbUrl ?? buildDbUrl() });
    await client.connect();
  } catch (err) {
    console.warn(
      `${tag} could not open the interlock connection (${errText(err)}) — ` +
        `FAILING OPEN, the caller will run unserialized (${opts.ref})`,
    );
    return noopLock();
  }

  try {
    // Keep the lock probe itself from ever inheriting a long ceiling.
    await client.query("SET statement_timeout = '30s'");
    const res = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS locked`,
      [name],
    );
    if (res.rows[0]?.locked) {
      console.log(`${tag} interlock acquired (${name}) (${opts.ref})`);
      if (opts.label) await writeLabel(client, opts.label, tag, opts.ref);
      return makeHeldLock(client, name, opts);
    }

    const holder = opts.describeHolder
      ? await opts.describeHolder(client).catch(() => `another holder of ${name}`)
      : `another holder of ${name}`;
    await client.end().catch(() => { /* best effort */ });
    return {
      acquired: false,
      blockedBy: holder,
      async release() { /* nothing held */ },
    };
  } catch (err) {
    await client.end().catch(() => { /* best effort */ });
    console.warn(`${tag} interlock probe failed (${errText(err)}) — FAILING OPEN (${opts.ref})`);
    return noopLock();
  }
}

async function writeLabel(
  client: Client,
  label: SessionLockLabel,
  tag: string,
  ref: string,
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO public.pipeline_state (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
      [label.key, JSON.stringify(label.value)],
    );
  } catch (err) {
    // Documentation must never veto the interlock.
    console.warn(
      `${tag} label write failed (${errText(err)}) — the lock IS held; it is just ` +
        `unexplained in pipeline_state.${label.key} (${ref})`,
    );
  }
}

function makeHeldLock(
  client: Client,
  name: string,
  opts: AcquireNamedLockOptions,
): NamedSessionLock {
  const tag = `  [${opts.logTag}]`;
  let released = false;
  return {
    acquired: true,
    async release() {
      if (released) return;
      released = true;
      if (opts.label) {
        try {
          await client.query(`DELETE FROM public.pipeline_state WHERE key = $1`, [opts.label.key]);
        } catch {
          // A surviving row reads as `label_stale` — reported by the canary and
          // overwritten by the next claim. Never worth failing a release over.
        }
      }
      try {
        await client.query(`SELECT pg_advisory_unlock(hashtext($1)::bigint)`, [name]);
      } catch { /* the session ending releases it anyway */ }
      try { await client.end(); } catch { /* best effort */ }
      console.log(`${tag} interlock released (${name}) (${opts.ref})`);
    },
  };
}
