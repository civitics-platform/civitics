/**
 * FIX-560 — the claim-outcome notification's shape.
 *
 * Runs via:  tsx --test src/lib/claim-notification.test.ts
 *
 * What carries the weight here is the TARGET-TYPE mapping, not the copy.
 * grant_target_type (global | jurisdiction | official | institution) and
 * follow_entity_type (official | agency | jurisdiction) are different
 * vocabularies, and notifications.entity_type is the SECOND one. A naive
 * `entityType: grant.target_type` typechecks against the `any` admin client and
 * then fails the enum at insert time — for 'global' and 'institution', which
 * are exactly the grants carrying the most access. So every target type is
 * asserted, including the two that must produce a notification with NO entity
 * rather than no notification at all.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildClaimOutcomeNotification,
  followEntityTypeFor,
  type ClaimGrant,
} from "./claim-notification";

const USER = "11111111-1111-1111-1111-111111111111";
const OFFICIAL = "22222222-2222-2222-2222-222222222222";

function grant(over: Partial<ClaimGrant> = {}): ClaimGrant {
  return {
    user_id: USER,
    role: "official",
    target_type: "official",
    target_id: OFFICIAL,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// Outcome — the two titles are distinguishable, and the event type is fixed
// ---------------------------------------------------------------------------

test("an approval and a rejection are distinguishable in the title", () => {
  const ok = buildClaimOutcomeNotification(grant(), "approved", "Jane Doe");
  const no = buildClaimOutcomeNotification(grant(), "rejected", "Jane Doe");

  assert.equal(ok.title, "Your claim was approved");
  assert.equal(no.title, "Your claim was not approved");
  assert.notEqual(ok.title, no.title);
  assert.notEqual(ok.body, no.body);
});

test("the event type is always claim_outcome — the enum value the migration adds", () => {
  assert.equal(buildClaimOutcomeNotification(grant(), "approved").eventType, "claim_outcome");
  assert.equal(buildClaimOutcomeNotification(grant(), "rejected").eventType, "claim_outcome");
});

test("the notification is addressed to the CLAIMANT, not the reviewing admin", () => {
  assert.equal(buildClaimOutcomeNotification(grant(), "approved").userId, USER);
});

// ---------------------------------------------------------------------------
// The target name is optional — a failed lookup must not cost the notification
// ---------------------------------------------------------------------------

test("the target name appears in the body when it is known", () => {
  const n = buildClaimOutcomeNotification(grant(), "approved", "Jane Doe");
  assert.ok(n.body.includes("Jane Doe"), n.body);
  assert.ok(n.body.includes("official access"), n.body);
});

test("a missing target name degrades the body — it never drops the notification", () => {
  for (const name of [null, undefined, ""] as const) {
    const n = buildClaimOutcomeNotification(grant(), "approved", name);
    assert.equal(n.title, "Your claim was approved");
    assert.ok(n.body.includes("official access"), n.body);
    assert.ok(!n.body.includes("undefined") && !n.body.includes("null"), n.body);
  }
});

test("a non-official role is spelled out rather than leaking the enum", () => {
  const n = buildClaimOutcomeNotification(
    grant({ role: "jurisdiction_admin", target_type: "jurisdiction" }),
    "approved",
  );
  assert.ok(n.body.includes("jurisdiction admin"), n.body);
  assert.ok(!n.body.includes("jurisdiction_admin"), n.body);
});

// ---------------------------------------------------------------------------
// grant_target_type → follow_entity_type. The whole vocabulary, both ways.
// ---------------------------------------------------------------------------

test("every grant_target_type maps to a follow_entity_type member or to null", () => {
  // The live enums, 2026-09-20:
  //   grant_target_type  = global | jurisdiction | official | institution
  //   follow_entity_type = official | agency | jurisdiction
  const FOLLOW = ["official", "agency", "jurisdiction"];
  for (const t of ["global", "jurisdiction", "official", "institution"]) {
    const mapped = followEntityTypeFor(t);
    assert.ok(
      mapped === null || FOLLOW.includes(mapped),
      `${t} mapped to '${mapped}', which is not a follow_entity_type member`,
    );
  }
  assert.equal(followEntityTypeFor("official"), "official");
  assert.equal(followEntityTypeFor("jurisdiction"), "jurisdiction");
  assert.equal(followEntityTypeFor("global"), null);
  assert.equal(followEntityTypeFor("institution"), null);
});

test("an official target carries entity + link", () => {
  const n = buildClaimOutcomeNotification(grant(), "approved", "Jane Doe");
  assert.equal(n.entityType, "official");
  assert.equal(n.entityId, OFFICIAL);
  assert.equal(n.link, `/officials/${OFFICIAL}`);
});

test("a global target still notifies — with no entity and no link", () => {
  const n = buildClaimOutcomeNotification(
    grant({ role: "platform_admin", target_type: "global", target_id: null }),
    "approved",
  );
  assert.equal(n.title, "Your claim was approved");
  assert.equal(n.entityType, undefined, "'global' has no follow_entity_type counterpart");
  assert.equal(n.entityId, undefined);
  assert.equal(n.link, undefined, "no page to link to");
});

test("an institution target still notifies — with no entity and no link", () => {
  const n = buildClaimOutcomeNotification(
    grant({ role: "institution_admin", target_type: "institution" }),
    "rejected",
  );
  assert.equal(n.title, "Your claim was not approved");
  assert.equal(n.entityType, undefined, "'institution' has no follow_entity_type counterpart");
  assert.equal(n.entityId, undefined);
  assert.equal(n.link, undefined);
});

test("a jurisdiction target carries the entity but NOT an /officials link", () => {
  const n = buildClaimOutcomeNotification(
    grant({ role: "jurisdiction_admin", target_type: "jurisdiction" }),
    "approved",
  );
  assert.equal(n.entityType, "jurisdiction");
  assert.equal(n.entityId, OFFICIAL);
  assert.equal(n.link, undefined, "/officials/<jurisdiction id> would 404");
});

test("an official target with a NULL target_id links nowhere and carries no entity", () => {
  const n = buildClaimOutcomeNotification(grant({ target_id: null }), "approved");
  assert.equal(n.link, undefined);
  assert.equal(n.entityId, undefined);
  assert.equal(n.entityType, undefined);
});
