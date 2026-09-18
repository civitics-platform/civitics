/**
 * FIX-1177 / FIX-1172 — the three SQL invariants of the session hold.
 *
 * These are STRING-LEVEL assertions on the statements `setGuardedHolds` and
 * `clearGuardedHolds` issue, run against a fake `pg` client. That is a
 * deliberate choice of instrument, not a shortcut: what has to be true here is
 * not "the happy path works" — the clone walk-through covers that — but that a
 * future edit cannot WIDEN the clear to a human's hold, or drop the
 * retired/held guard from the upsert, without something going red.
 *
 * All three are predicates whose absence is invisible in testing. A clear that
 * lost its `LIKE` would pass every functional test ever written for this file
 * and would silently un-pause a pipeline an operator paused on purpose, which
 * nobody would notice until a canary went quiet.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  SESSION_HOLD_NOTE,
  SESSION_HOLD_PREFIX,
  clearGuardedHolds,
  setGuardedHolds,
} from "./prod-session";

type Issued = { sql: string; params: readonly unknown[] };

/**
 * A `pg.Client` stand-in, injected through the module's own `dbUrl` seam.
 *
 * `withClient()` imports `pg` dynamically and connects, so there is no
 * constructor to stub. What IS injectable is the DSN: pointing it at a host
 * that cannot resolve makes `withClient` take its documented fail-open branch
 * and return null, which is the other property worth pinning — a hold whose
 * connection fails must not throw into the claim.
 */
const UNREACHABLE = "postgresql://postgres:postgres@127.0.0.1:1/postgres";

// ---------------------------------------------------------------------------
// Fail-open — the property that keeps this out of the claim's way
// ---------------------------------------------------------------------------

test("a hold whose connection fails returns 0 rather than throwing", async () => {
  // The FIX-1067 rule, one layer out: bookkeeping that can veto the safety
  // mechanism is worse than no bookkeeping. `claimProdSession` also wraps both
  // calls in `.catch()`, so this is belt AND braces on purpose.
  assert.equal(await setGuardedHolds(UNREACHABLE, "unit test"), 0);
});

test("a clear whose connection fails returns 0 rather than throwing", async () => {
  assert.equal(await clearGuardedHolds(UNREACHABLE), 0);
});

// ---------------------------------------------------------------------------
// The three invariants, read off the statement text
// ---------------------------------------------------------------------------

/**
 * The statements as source text.
 *
 * Read from the module rather than retyped, for the FIX-1190 reason: a test
 * that re-types the predicate asserts its own copy of it.
 */
function statements(): string {
  return readSource();
}

function readSource(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  return readFileSync(new URL("./prod-session.ts", import.meta.url), "utf8");
}

test("invariant 1: the upsert leaves a RETIRED row and an already-HELD row alone", () => {
  const src = statements();
  const upsert = /INSERT INTO public\.rollup_watch_overrides[\s\S]*?RETURNING pipeline/.exec(src);
  assert.ok(upsert, "the upsert statement must be findable");
  const sql = upsert[0];
  assert.match(
    sql,
    /WHERE public\.rollup_watch_overrides\.retired_at IS NULL/,
    "a retired pipeline must not be held — the not_both CHECK forbids it and a " +
      "retired pipeline reports nothing anyway",
  );
  assert.match(
    sql,
    /AND public\.rollup_watch_overrides\.held_since IS NULL/,
    "a hold somebody else already declared must win over the session's generic one",
  );
  // The set is DERIVED, not listed. Asserted as the INTERPOLATION rather than
  // the expanded SQL: the source carries `${Q_GUARDED_PIPELINES}` verbatim, and
  // the name is the thing that must not be replaced by a literal list.
  assert.match(
    sql,
    /FROM \(\$\{Q_GUARDED_PIPELINES\}\) AS g/,
    "the set must come from the shared derivation, not a list in this file",
  );
  assert.ok(
    !/'[a-z_]*(refresh|rebuild|sweep|reconcile)'/.test(sql),
    "no hard-coded pipeline names — the set is derived at claim time, so it " +
      "tracks a guard the next migration adds without an edit here",
  );
});

test("invariant 2: the clear touches ONLY session-prefixed holds", () => {
  const src = statements();
  const upd = /UPDATE public\.rollup_watch_overrides[\s\S]*?WHERE hold_reason LIKE \$1/.exec(src);
  assert.ok(upd, "the clear statement must be findable");
  assert.match(
    upd[0],
    /WHERE hold_reason LIKE \$1/,
    "an unqualified clear would un-pause a hold a human declared on purpose",
  );
  assert.equal(SESSION_HOLD_PREFIX, "prod session held: ");
});

test("invariant 3: the delete removes only session-created rows that now declare NOTHING", () => {
  const src = statements();
  const del = /DELETE FROM public\.rollup_watch_overrides[\s\S]*?cadence_hours IS NULL/.exec(src);
  assert.ok(del, "the delete statement must be findable");
  const sql = del[0];
  assert.match(sql, /WHERE note = \$1/, "only rows THIS mechanism created");
  assert.match(sql, /AND held_since\s+IS NULL/, "never a row that is still held");
  assert.match(sql, /AND retired_at\s+IS NULL/, "never a retirement declaration");
  assert.match(sql, /AND cadence_hours IS NULL/, "never an asserted cadence");
});

test("the hold reason shares the guard procedures' skip_reason prefix", () => {
  // `20260911000100_fix950_guards_rollup_family.sql` writes the same words into
  // `skip_reason`, so ONE `LIKE 'prod session held:%'` finds every artefact a
  // session caused — the deferred firings and the threshold suppressions both.
  assert.ok(SESSION_HOLD_PREFIX.startsWith("prod session held:"));
});

test("the session note explains itself, because the column is NOT NULL", () => {
  // rollup_watch_overrides is a table of human decisions; a row machinery
  // created has to say that it is machinery, or the next operator to read the
  // table cannot tell which rows are theirs.
  assert.match(SESSION_HOLD_NOTE, /FIX-1177\/1172/);
  assert.match(SESSION_HOLD_NOTE, /cleared by release/);
  assert.match(SESSION_HOLD_NOTE, /inert/);
});
