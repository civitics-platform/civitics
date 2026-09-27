/**
 * FIX-1167 — the /admin/grants active-grants shaping.
 *
 * Runs via:  tsx --test src/lib/active-grants.test.ts
 *
 * The case that matters most is the global grant: entity_grants_target_shape
 * forces target_id IS NULL for target_type='global', so any resolution that
 * treats "no target row" as "drop the grant" loses exactly the platform_admin
 * and staff grants an operator most needs to revoke. Every other assertion here
 * exists so that one cannot regress quietly.
 *
 * FIX-1237 — the liveness predicate every UI grant reader shares. The shape
 * that matters is the wrong-but-green one: an 'active' row whose expires_at has
 * passed must read inactive everywhere, exactly as the has_active_* SQL does.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ActiveGrantRow,
  type TargetMaps,
  ELEVATED_DESK_ROLES,
  GRANT_ROLES,
  buildActiveGrants,
  effectiveGrantStatus,
  grantKey,
  holdsElevatedDesk,
  identityLabel,
  isGrantActive,
  resolveTargetHref,
  resolveTargetLabel,
  revokeConfirmMessage,
  revokeResultMessage,
} from "./active-grants";

const OFFICIAL_ID = "11111111-1111-4111-8111-111111111111";
const JURIS_ID = "22222222-2222-4222-8222-222222222222";
const INST_ID = "33333333-3333-4333-8333-333333333333";
const USER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const maps: TargetMaps = {
  officialById: new Map([[OFFICIAL_ID, "Jane Doe"]]),
  jurisdictionById: new Map([[JURIS_ID, "Franklin County"]]),
  institutionById: new Map([[INST_ID, "Acme Foundation"]]),
};

const users = new Map([
  [USER_A, { email: "a@example.com", display_name: "Ada" }],
  [USER_B, { email: null, display_name: null }],
]);

const row = (over: Partial<ActiveGrantRow> = {}): ActiveGrantRow => ({
  id: "g1",
  user_id: USER_A,
  role: "official",
  target_type: "official",
  target_id: OFFICIAL_ID,
  granted_at: "2026-08-01T00:00:00.000Z",
  expires_at: "2027-08-01T00:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  ...over,
});

const globalRow = (over: Partial<ActiveGrantRow> = {}): ActiveGrantRow =>
  row({ role: "platform_admin", target_type: "global", target_id: null, ...over });

// ---------------------------------------------------------------------------
// The NULL-target case
// ---------------------------------------------------------------------------

test("FIX-1167 a global grant survives resolution and is labelled, not dropped", () => {
  const out = buildActiveGrants([globalRow({ id: "g-global" })], users, maps);
  assert.equal(out.length, 1, "a NULL-target grant must never be filtered out");
  assert.equal(out[0]!.targetLabel, "global");
  assert.equal(out[0]!.targetId, null);
  assert.equal(out[0]!.targetHref, null, "global has no public page to link to");
});

test("FIX-1167 a mixed list keeps BOTH the global and the scoped grant", () => {
  // The regression this pins: an inner join on officials would return only g-scoped.
  const out = buildActiveGrants(
    [globalRow({ id: "g-global" }), row({ id: "g-scoped" })],
    users,
    maps,
  );
  assert.deepEqual(
    out.map((g) => g.id).sort(),
    ["g-global", "g-scoped"],
    "both must survive; losing the global one is the FIX-928 NULL-blindness again",
  );
  const byId = new Map(out.map((g) => [g.id, g]));
  assert.equal(byId.get("g-global")!.targetLabel, "global");
  assert.equal(byId.get("g-scoped")!.targetLabel, "Jane Doe");
});

test("FIX-1167 global sorts first — the broadest access is listed at the top", () => {
  const out = buildActiveGrants(
    [row({ id: "g-scoped" }), globalRow({ id: "g-global" })],
    users,
    maps,
  );
  assert.equal(out[0]!.id, "g-global");
});

test("FIX-1167 grantKey never lets a NULL target collide with a uuid", () => {
  const g = grantKey({ user_id: USER_A, role: "staff", target_type: "global", target_id: null });
  const s = grantKey({
    user_id: USER_A,
    role: "staff",
    target_type: "global",
    target_id: OFFICIAL_ID,
  });
  assert.notEqual(g, s);
  assert.ok(!g.endsWith("|"), "an empty segment would be ambiguous with a missing value");
});

// ---------------------------------------------------------------------------
// Target resolution across all four types
// ---------------------------------------------------------------------------

test("FIX-1167 each target type resolves to its own name, and its own href", () => {
  assert.equal(resolveTargetLabel("official", OFFICIAL_ID, maps), "Jane Doe");
  assert.equal(resolveTargetLabel("jurisdiction", JURIS_ID, maps), "Franklin County");
  assert.equal(resolveTargetLabel("institution", INST_ID, maps), "Acme Foundation");
  assert.equal(resolveTargetLabel("global", null, maps), "global");

  assert.equal(resolveTargetHref("official", OFFICIAL_ID), `/officials/${OFFICIAL_ID}`);
  assert.equal(resolveTargetHref("jurisdiction", JURIS_ID), `/jurisdictions/${JURIS_ID}`);
  assert.equal(resolveTargetHref("institution", INST_ID), `/institutions/${INST_ID}`);
  assert.equal(resolveTargetHref("global", null), null);
});

test("FIX-1167 an unresolvable target id degrades to a visible id, never to blank", () => {
  const label = resolveTargetLabel("official", "99999999-9999-4999-8999-999999999999", maps);
  assert.ok(label.startsWith("official 99999999"), label);
  // And a shape violation (non-global with a NULL target) is surfaced, not hidden.
  assert.equal(resolveTargetLabel("official", null, maps), "official (no target id)");
});

// ---------------------------------------------------------------------------
// The count that has to be shown before the click
// ---------------------------------------------------------------------------

test("FIX-1167 duplicate active rows on one key report the count on every row", () => {
  // The FIX-928 shape: several active global staff grants for one account.
  const dupes = [
    globalRow({ id: "d1", role: "staff" }),
    globalRow({ id: "d2", role: "staff" }),
    globalRow({ id: "d3", role: "staff" }),
  ];
  const out = buildActiveGrants(dupes, users, maps);
  assert.equal(out.length, 3);
  for (const g of out) {
    assert.equal(g.activeOnKey, 3, "one click retires all three — the operator must see that");
  }
});

test("FIX-1167 distinct keys do not share a count", () => {
  const out = buildActiveGrants(
    [globalRow({ id: "x", role: "staff" }), globalRow({ id: "y", role: "staff", user_id: USER_B })],
    users,
    maps,
  );
  assert.deepEqual(
    out.map((g) => g.activeOnKey),
    [1, 1],
  );
});

test("FIX-1167 the confirmation names the count, the identity and the scope", () => {
  const [g] = buildActiveGrants([globalRow({ role: "staff" })], users, maps);
  assert.equal(
    revokeConfirmMessage(g!, g!.activeOnKey),
    "Revoke 1 active grant for a@example.com · staff · global?",
  );
  assert.equal(
    revokeConfirmMessage(g!, 13),
    "Revoke 13 active grants for a@example.com · staff · global?",
  );
});

test("FIX-1167 a user with no email or name still gets a stable identity label", () => {
  const [g] = buildActiveGrants([row({ user_id: USER_B })], users, maps);
  assert.equal(identityLabel(g!), `user ${USER_B.slice(0, 8)}…`);
  // And an id absent from the users map at all.
  assert.equal(
    identityLabel({ userEmail: null, userName: null, userId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }),
    "user cccccccc…",
  );
});

test("FIX-1167 a count mismatch is shown, not smoothed over", () => {
  assert.equal(revokeResultMessage(1, 1), "Revoked 1 grant.");
  assert.equal(revokeResultMessage(3, 3), "Revoked 3 grants.");
  const mismatch = revokeResultMessage(3, 1);
  assert.ok(mismatch.includes("Revoked 1 grant"), mismatch);
  assert.ok(mismatch.includes("3 were active"), mismatch);
  assert.ok(mismatch.includes("must match"), mismatch);
});

test("FIX-1167 an empty list shapes to an empty list rather than throwing", () => {
  assert.deepEqual(buildActiveGrants([], users, maps), []);
});

// ---------------------------------------------------------------------------
// FIX-1237 — liveness: status AND expires_at, the has_active_* shape
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-09-27T05:00:00.000Z");
const PAST = "2026-09-26T05:00:00.000Z"; // one day before NOW
const FUTURE = "2028-05-29T00:00:00.000Z";

test("FIX-1237 active with no expiry is live", () => {
  assert.equal(isGrantActive({ status: "active", expires_at: null }, NOW), true);
});

test("FIX-1237 active with a future expiry is live", () => {
  assert.equal(isGrantActive({ status: "active", expires_at: FUTURE }, NOW), true);
});

test("FIX-1237 active PAST its expiry is NOT live — the row the sweep has not flipped yet", () => {
  // The wrong-but-green shape: status still says 'active'. Every SQL
  // authorization path already refuses it; the UI must agree.
  assert.equal(isGrantActive({ status: "active", expires_at: PAST }, NOW), false);
  // The boundary is exclusive, as in SQL's `expires_at > now()`.
  assert.equal(isGrantActive({ status: "active", expires_at: new Date(NOW).toISOString() }, NOW), false);
});

test("FIX-1237 pending / revoked / expired are never live, whatever the expiry", () => {
  for (const status of ["pending", "revoked", "expired"]) {
    for (const expires_at of [null, FUTURE, PAST]) {
      assert.equal(isGrantActive({ status, expires_at }, NOW), false, `${status} / ${expires_at}`);
    }
  }
});

test("FIX-1237 an unparseable expires_at fails closed", () => {
  assert.equal(isGrantActive({ status: "active", expires_at: "not a date" }, NOW), false);
});

test("FIX-1237 effectiveGrantStatus shows 'expired' for an active row past its expiry, else the stored status", () => {
  assert.equal(effectiveGrantStatus({ status: "active", expires_at: PAST }, NOW), "expired");
  assert.equal(effectiveGrantStatus({ status: "active", expires_at: FUTURE }, NOW), "active");
  assert.equal(effectiveGrantStatus({ status: "active", expires_at: null }, NOW), "active");
  // A pending claim has no expiry yet and must stay pending, not become 'expired'.
  assert.equal(effectiveGrantStatus({ status: "pending", expires_at: null }, NOW), "pending");
  assert.equal(effectiveGrantStatus({ status: "revoked", expires_at: PAST }, NOW), "revoked");
  assert.equal(effectiveGrantStatus({ status: "expired", expires_at: PAST }, NOW), "expired");
});

// ---------------------------------------------------------------------------
// FIX-1237 — the elevated-desk role set, pinned to the enum the migrations define
// ---------------------------------------------------------------------------

/**
 * grant_role as the migrations define it: CREATE TYPE, then every ADD VALUE and
 * RENAME VALUE in timestamp order. Read as text from disk (the FIX-543 drift-test
 * pattern), so a new, dropped or renamed role fails here, not silently on /desk.
 */
function grantRolesFromMigrations(): Set<string> {
  const dir = join(__dirname, "..", "..", "..", "..", "supabase", "migrations");
  const roles = new Set<string>();
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) {
    // Strip `--` comments so a quoted example in a header is never parsed.
    const sql = readFileSync(join(dir, file), "utf8").replace(/--[^\n]*/g, "");
    const created = sql.match(/CREATE\s+TYPE\s+(?:public\.)?grant_role\s+AS\s+ENUM\s*\(([^)]*)\)/i);
    if (created) for (const m of created[1]!.matchAll(/'([^']+)'/g)) roles.add(m[1]!);
    for (const m of sql.matchAll(/ALTER\s+TYPE\s+(?:public\.)?grant_role\s+ADD\s+VALUE\s+(?:IF\s+NOT\s+EXISTS\s+)?'([^']+)'/gi)) {
      roles.add(m[1]!);
    }
    for (const m of sql.matchAll(/ALTER\s+TYPE\s+(?:public\.)?grant_role\s+RENAME\s+VALUE\s+'([^']+)'\s+TO\s+'([^']+)'/gi)) {
      roles.delete(m[1]!);
      roles.add(m[2]!);
    }
  }
  return roles;
}

test("FIX-1237 GRANT_ROLES matches the grant_role enum the migrations define", () => {
  const fromSql = grantRolesFromMigrations();
  assert.ok(fromSql.has("constituent"), "the parser found the CREATE TYPE");
  assert.deepEqual([...GRANT_ROLES].sort(), [...fromSql].sort());
});

test("FIX-1237 every elevated-desk role is a real grant_role, and 'jurisdiction' is not one", () => {
  const fromSql = grantRolesFromMigrations();
  for (const r of ELEVATED_DESK_ROLES) assert.ok(fromSql.has(r), `${r} is not a grant_role value`);
  // The old desk literal. It is not in the enum, so a predicate that names it
  // tests a value no row can hold.
  assert.equal(fromSql.has("jurisdiction"), false);
  assert.deepEqual([...ELEVATED_DESK_ROLES].sort(), ["jurisdiction_admin", "official"]);
});

test("FIX-1237 holdsElevatedDesk accepts a live jurisdiction_admin or official grant and rejects the phantom 'jurisdiction'", () => {
  const live = (role: string) => ({ role, status: "active", expires_at: FUTURE });
  assert.equal(holdsElevatedDesk([live("jurisdiction_admin")], NOW), true);
  assert.equal(holdsElevatedDesk([live("official")], NOW), true);
  assert.equal(holdsElevatedDesk([live("jurisdiction")], NOW), false, "not a grant_role value");
  // Not an office desk: the placeholder copy names no organisation.
  assert.equal(holdsElevatedDesk([live("institution_admin")], NOW), false);
  assert.equal(holdsElevatedDesk([live("constituent"), live("platform_admin"), live("staff")], NOW), false);
});

test("FIX-1237 holdsElevatedDesk ignores a pending claim and a lapsed-but-active grant", () => {
  assert.equal(holdsElevatedDesk([{ role: "official", status: "pending", expires_at: null }], NOW), false);
  assert.equal(holdsElevatedDesk([{ role: "jurisdiction_admin", status: "active", expires_at: PAST }], NOW), false);
  assert.equal(holdsElevatedDesk([], NOW), false);
});
