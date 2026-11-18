/**
 * FIX-401 — POST /api/data-flags' decision core, the resolve action's parser,
 * and the cap's literals against the migration that enforces them.
 *
 * The route is a thin binding of submitDataFlag() to the admin client, so the
 * handler's branches are tested here with fake deps. The 20 / 21 boundary on
 * the rolling window is the table's trigger, so it is asserted twice: the
 * literals are pinned to the migration below, and the behaviour is CASE 7 / 8
 * of supabase/tests/verify_fix401.sql against a live database.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ATTRIBUTION_ENTITY_TYPES } from "@civitics/db";
import {
  DATA_FLAG_CAP_MESSAGE,
  DATA_FLAG_COMMENT_MAX,
  DATA_FLAG_DAILY_CAP,
  DATA_FLAG_REASONS,
  DATA_FLAG_REASON_LABELS,
  DATA_FLAG_RESOLUTIONS,
  DATA_FLAG_WINDOW_HOURS,
  dataFlagEntityPath,
  isPendingDataFlag,
  parseDataFlagBody,
  parseResolveDataFlag,
  submitDataFlag,
  type DataFlagDeps,
  type DataFlagInput,
} from "./data-flags";

const OFFICIAL = "3f1c2a4e-1b2c-4d5e-8f90-a1b2c3d4e5f6";
const USER = "0a0b0c0d-1111-4222-8333-444455556666";
const GOOD = { entity_type: "official", entity_id: OFFICIAL, reason: "misspelled" };

/** Fake deps over an in-memory table, with the trigger's cap arithmetic. */
function fakeDeps(opts: {
  exists?: boolean;
  rows?: Array<{ key: string; created_at: number }>;
  now?: number;
  insertError?: string;
  throwOn?: keyof DataFlagDeps;
} = {}) {
  const now = opts.now ?? Date.UTC(2026, 10, 18, 12);
  const rows = opts.rows ?? [];
  const calls = { entityExists: 0, alreadyFlagged: 0, insert: 0 };
  const key = (f: DataFlagInput, u: string) => `${f.entity_type}|${f.entity_id}|${u}|${f.reason}`;
  const deps: DataFlagDeps = {
    async entityExists() {
      calls.entityExists++;
      if (opts.throwOn === "entityExists") throw new Error("db down");
      return opts.exists ?? true;
    },
    async alreadyFlagged(f, u) {
      calls.alreadyFlagged++;
      if (opts.throwOn === "alreadyFlagged") throw new Error("db down");
      return rows.some((r) => r.key === key(f, u));
    },
    async insert(f, u) {
      calls.insert++;
      if (opts.insertError) return { errorCode: opts.insertError };
      const windowStart = now - DATA_FLAG_WINDOW_HOURS * 3600_000;
      const recent = rows.filter((r) => r.created_at > windowStart).length;
      if (recent >= DATA_FLAG_DAILY_CAP) return { errorCode: "53400" };
      rows.push({ key: key(f, u), created_at: now });
      return { id: `flag-${rows.length}` };
    },
  };
  return { deps, calls, rows };
}

// ── each 400 ───────────────────────────────────────────────────────────────────

test("FIX-401: each 400 — the body, entity_type, entity_id, reason, comment, source", async () => {
  const cases: Array<[unknown, RegExp]> = [
    [null, /JSON object/],
    [[GOOD], /JSON object/],
    ["official", /JSON object/],
    [{ ...GOOD, entity_type: "jurisdiction" }, /entity_type must be one of/],
    [{ ...GOOD, entity_type: undefined }, /entity_type must be one of/],
    [{ ...GOOD, entity_id: "not-a-uuid" }, /entity_id must be a UUID/],
    [{ ...GOOD, entity_id: 42 }, /entity_id must be a UUID/],
    [{ ...GOOD, reason: "spam" }, /reason must be one of/],
    [{ ...GOOD, reason: undefined }, /reason must be one of/],
    [{ ...GOOD, comment: "x".repeat(DATA_FLAG_COMMENT_MAX + 1) }, /Comment too long \(max 500/],
    [{ ...GOOD, comment: { text: "hi" } }, /comment must be text/],
    [{ ...GOOD, source: "congress gov" }, /source must be a source key/],
    [{ ...GOOD, source: "s".repeat(65) }, /source must be a source key/],
    [{ ...GOOD, source: 7 }, /source must be a source key/],
  ];
  for (const [body, re] of cases) {
    const { deps, calls } = fakeDeps();
    const out = await submitDataFlag(body, USER, deps);
    assert.equal(out.status, 400, JSON.stringify(body));
    assert.match((out.body as { error: string }).error, re);
    assert.equal(calls.entityExists + calls.insert, 0, "a 400 reads and writes nothing");
  }
});

test("FIX-401: the accepted shape — trimmed comment, blank → null, source kept, id lower-cased", () => {
  const ok = parseDataFlagBody({
    ...GOOD,
    entity_id: OFFICIAL.toUpperCase(),
    comment: "  the surname is Smyth  ",
    source: "legistar:seattle",
  });
  assert.ok(ok.ok);
  assert.deepEqual(ok.value, {
    entity_type: "official",
    entity_id: OFFICIAL,
    reason: "misspelled",
    comment: "the surname is Smyth",
    source: "legistar:seattle",
  });
  const blank = parseDataFlagBody({ ...GOOD, comment: "   ", source: "" });
  assert.ok(blank.ok);
  assert.equal(blank.value.comment, null);
  assert.equal(blank.value.source, null);
  // exactly 500 is allowed
  assert.ok(parseDataFlagBody({ ...GOOD, comment: "x".repeat(DATA_FLAG_COMMENT_MAX) }).ok);
  // every attribution type is flaggable
  for (const t of ATTRIBUTION_ENTITY_TYPES) assert.ok(parseDataFlagBody({ ...GOOD, entity_type: t }).ok, t);
});

// ── the 404 ────────────────────────────────────────────────────────────────────

test("FIX-401: the 404 — one existence lookup, no write", async () => {
  const { deps, calls } = fakeDeps({ exists: false });
  const out = await submitDataFlag(GOOD, USER, deps);
  assert.equal(out.status, 404);
  assert.equal(calls.entityExists, 1);
  assert.equal(calls.insert, 0);
});

// ── the idempotent repeat ──────────────────────────────────────────────────────

test("FIX-401: the idempotent repeat answers { flagged: true } and writes nothing", async () => {
  const { deps, calls, rows } = fakeDeps();
  const first = await submitDataFlag(GOOD, USER, deps);
  assert.equal(first.status, 200);
  assert.ok(first.status === 200 && first.created, "the first one is created");
  const again = await submitDataFlag(GOOD, USER, deps);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { flagged: true });
  assert.ok(again.status === 200 && again.created === null, "the repeat creates nothing");
  assert.equal(calls.insert, 1);
  assert.equal(rows.length, 1);

  // another reason on the same entity is a new flag
  const other = await submitDataFlag({ ...GOOD, reason: "outdated" }, USER, deps);
  assert.ok(other.status === 200 && other.created);
});

test("FIX-401: a unique-key race (23505) is the repeat, not a failure", async () => {
  const { deps } = fakeDeps({ insertError: "23505" });
  const out = await submitDataFlag(GOOD, USER, deps);
  assert.equal(out.status, 200);
  assert.ok(out.status === 200 && out.created === null);
});

// ── the 20 / 21 boundary on the rolling window ─────────────────────────────────

test("FIX-401: the 20th flag inside 24 h lands, the 21st answers 429 with a plain sentence", async () => {
  const now = Date.UTC(2026, 10, 18, 12);
  const hour = 3600_000;
  const rows = [
    // exactly 24 h old and older: outside the window
    ...Array.from({ length: 5 }, (_, i) => ({ key: `old-${i}`, created_at: now - 24 * hour - i * 60_000 })),
    // 19 inside it
    ...Array.from({ length: 19 }, (_, i) => ({ key: `new-${i}`, created_at: now - 23 * hour - i * 60_000 })),
  ];
  const { deps } = fakeDeps({ rows, now });

  const twentieth = await submitDataFlag({ ...GOOD, entity_id: "11111111-1111-4111-8111-111111111111" }, USER, deps);
  assert.equal(twentieth.status, 200);

  const twentyFirst = await submitDataFlag({ ...GOOD, entity_id: "22222222-2222-4222-8222-222222222222" }, USER, deps);
  assert.equal(twentyFirst.status, 429);
  assert.equal((twentyFirst.body as { error: string }).error, DATA_FLAG_CAP_MESSAGE);
  assert.ok(twentyFirst.status === 429 && twentyFirst.capHit.entity_id === "22222222-2222-4222-8222-222222222222");

  // a repeat at the cap is still the no-op, not a 429
  const repeat = await submitDataFlag({ ...GOOD, entity_id: "11111111-1111-4111-8111-111111111111" }, USER, deps);
  assert.equal(repeat.status, 200);
});

test("FIX-401: the cap message is one plain sentence pair naming the number", () => {
  assert.match(DATA_FLAG_CAP_MESSAGE, new RegExp(`\\b${DATA_FLAG_DAILY_CAP}\\b`));
  assert.match(DATA_FLAG_CAP_MESSAGE, new RegExp(`\\b${DATA_FLAG_WINDOW_HOURS} hours\\b`));
  assert.doesNotMatch(DATA_FLAG_CAP_MESSAGE, /53400|429|rate|limit exceeded/i);
});

test("FIX-401: a DB error on a read, or an unknown insert error, is a 500", async () => {
  for (const throwOn of ["entityExists", "alreadyFlagged"] as const) {
    const out = await submitDataFlag(GOOD, USER, fakeDeps({ throwOn }).deps);
    assert.equal(out.status, 500, throwOn);
  }
  assert.equal((await submitDataFlag(GOOD, USER, fakeDeps({ insertError: "42501" }).deps)).status, 500);
});

// ── resolve_data_flag ──────────────────────────────────────────────────────────

test("FIX-401: resolve_data_flag takes the four resolutions and refuses anything else", () => {
  for (const r of DATA_FLAG_RESOLUTIONS) {
    const ok = parseResolveDataFlag({ action: "resolve_data_flag", flag_id: OFFICIAL, resolution: r });
    assert.ok(ok.ok, r);
  }
  for (const bad of ["fixed", "dismiss", "VALID", "", undefined, null, 1]) {
    const out = parseResolveDataFlag({ action: "resolve_data_flag", flag_id: OFFICIAL, resolution: bad });
    assert.ok(!out.ok, String(bad));
    assert.match(out.error, /resolution must be one of valid\|invalid\|duplicate\|no_action/);
  }
  assert.ok(!parseResolveDataFlag({ flag_id: "nope", resolution: "valid" }).ok);
  assert.ok(!parseResolveDataFlag(null).ok);
});

// ── the queue rule and the link ────────────────────────────────────────────────

test("FIX-401: pending = admin-unresolved AND (unclassified OR confidence < 0.8)", () => {
  const base = { admin_resolved_at: null, classification: null, classification_confidence: null };
  assert.equal(isPendingDataFlag(base), true);
  assert.equal(isPendingDataFlag({ ...base, admin_resolved_at: "2026-11-18T00:00:00Z" }), false);
  assert.equal(isPendingDataFlag({ ...base, classification: "spam", classification_confidence: 0.79 }), true);
  assert.equal(isPendingDataFlag({ ...base, classification: "spam", classification_confidence: 0.8 }), false);
  assert.equal(isPendingDataFlag({ ...base, classification: "spam", classification_confidence: null }), false);
});

test("FIX-401: each entity type links to its page", () => {
  assert.equal(dataFlagEntityPath("official", OFFICIAL), `/officials/${OFFICIAL}`);
  assert.equal(dataFlagEntityPath("proposal", OFFICIAL), `/proposals/${OFFICIAL}`);
  assert.equal(dataFlagEntityPath("agency", OFFICIAL), `/institutions/${OFFICIAL}`);
  assert.equal(dataFlagEntityPath("governing_body", OFFICIAL), `/institutions/${OFFICIAL}`);
  assert.equal(dataFlagEntityPath("financial_entity", OFFICIAL), `/donors/${OFFICIAL}`);
});

// ── the literals, against the migration that enforces them ─────────────────────

const MIGRATION = readFileSync(
  join(__dirname, "..", "..", "..", "..", "supabase", "migrations", "20261120000000_fix401_data_flags.sql"),
  "utf8",
);

function checkList(constraint: string): string[] {
  const m = MIGRATION.match(new RegExp(`CONSTRAINT ${constraint}\\s+CHECK \\([^)]*IN \\(([^)]*)\\)`));
  assert.ok(m, `${constraint} found`);
  return [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!);
}

test("FIX-401: the trigger's cap and window are the lib's", () => {
  assert.match(MIGRATION, new RegExp(`IF v_recent >= ${DATA_FLAG_DAILY_CAP} THEN`));
  assert.match(MIGRATION, new RegExp(`created_at > now\\(\\) - interval '${DATA_FLAG_WINDOW_HOURS} hours'`));
  assert.match(MIGRATION, /USING ERRCODE = '53400'/);
  assert.match(MIGRATION, /BEFORE INSERT ON public\.data_flags/);
});

test("FIX-401: the CHECK lists are the lib's and the attribution vocabulary", () => {
  assert.deepEqual(checkList("data_flags_entity_type_check"), [...ATTRIBUTION_ENTITY_TYPES]);
  assert.deepEqual(checkList("data_flags_reason_check"), [...DATA_FLAG_REASONS]);
  assert.deepEqual(checkList("data_flags_resolution_check"), [...DATA_FLAG_RESOLUTIONS]);
  assert.match(MIGRATION, new RegExp(`char_length\\(comment\\) <= ${DATA_FLAG_COMMENT_MAX}`));
  assert.deepEqual(Object.keys(DATA_FLAG_REASON_LABELS), [...DATA_FLAG_REASONS], "a label per reason, in order");
});
