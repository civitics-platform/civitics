import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";
import { requireGrantsAdmin } from "../_lib";
import { computeExpiry } from "../../../officials/claim/_lib";
import { createNotification } from "@/lib/notifications";
import {
  buildClaimOutcomeNotification,
  type ClaimGrant,
  type ClaimOutcome,
} from "@/lib/claim-notification";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// FIX-560 — tell the claimant. BEST-EFFORT: the review write has already
// committed by the time this runs, so a notification failure must never turn a
// successful approve/reject into a 500 the operator would retry (a retry hits
// the pending-only 409 and looks like the action failed). Logged, swallowed.
async function notifyClaimant(
  grant: ClaimGrant,
  outcome: ClaimOutcome,
  targetName: string | null,
): Promise<void> {
  try {
    await createNotification(buildClaimOutcomeNotification(grant, outcome, targetName));
  } catch (err) {
    console.error("[/api/admin/grants/[id]] claim-outcome notification failed", err);
  }
}

// POST /api/admin/grants/[id]  body: { action: 'approve' | 'reject' }
//
// FIX-559 decision 9 (memo-locked semantics):
//   approve → grant status='active', granted_at=now(), expires_at =
//             COALESCE(term_end, current_term_end) when future else now()+2y;
//             evidence outcome='approved' + reviewed_at/reviewer_id;
//             grant_events event='approved' with actor_id=<admin>.
//   reject  → grant status='revoked'; evidence outcome='rejected' (+ same
//             review stamps); grant_events event='rejected'.
// approve/reject act on PENDING grants only — anything else 409s.
//
// FIX-928 adds a third action:
//   revoke  → withdraw an ACTIVE grant. Before this there was no way to do that
//             at all: both existing actions run behind the `status !== 'pending'`
//             409 below, and 'reject' is the pending-rejection branch rather than
//             a revocation, so revoking live access through this surface flipped
//             ZERO rows and returned an error. A system that can grant access and
//             cannot withdraw it is a security problem, not a gap in an admin UI.
//
// Revoke is deliberately NOT `.eq("id")`. It goes through the revoke_grant() RPC,
// which is set-based on the (user_id, role, target_type, target_id) KEY and
// NULL-safe on target_id. Two reasons: PostgREST cannot express IS NOT DISTINCT
// FROM, so a .eq("target_id", null) would match nothing and global-scoped grants
// would stay unrevocable — the exact bug FIX-928 is about; and revocation's
// failure mode is silent over-retention of access, so it revokes every active row
// on the key and reports the count rather than assuming the index left one.
// GET /api/admin/grants/[id]  →  { ok, key, activeOnKey }
//
// FIX-1167 — the confirmation step's pre-read. revoke_grant() is SET-BASED on
// the (user_id, role, target_type, target_id) key, so ONE click can retire
// several rows; the operator has to see that number before confirming rather
// than discover it in the response. Same predicate the RPC uses, evaluated a
// moment before the write, so a difference against the returned count is a real
// signal (the index was dropped or bypassed) rather than page staleness.
//
// PostgREST cannot express IS NOT DISTINCT FROM, so the NULL branch uses
// `.is()` and the non-NULL branch `.eq()`. Under entity_grants_target_shape
// exactly one applies per row — target_id IS NULL iff target_type='global' —
// so the pair is equivalent to the RPC's predicate, not an approximation of it.
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  const adminId = await requireGrantsAdmin();
  if (!adminId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }

  const grantId = params.id;
  if (!grantId || !UUID_RE.test(grantId)) {
    return NextResponse.json({ error: "valid_grant_id_required" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  const { data: grant } = await admin
    .from("entity_grants")
    .select("user_id, role, target_type, target_id")
    .eq("id", grantId)
    .maybeSingle();
  if (!grant) {
    return NextResponse.json({ error: "grant_not_found" }, { status: 404 });
  }

  let q = admin
    .from("entity_grants")
    .select("id", { count: "exact", head: true })
    .eq("status", "active")
    .eq("user_id", grant.user_id)
    .eq("role", grant.role)
    .eq("target_type", grant.target_type);
  q = grant.target_id === null ? q.is("target_id", null) : q.eq("target_id", grant.target_id);

  const { count, error } = await q;
  if (error) {
    return NextResponse.json({ error: "grant_count_failed" }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    key: {
      user_id: grant.user_id,
      role: grant.role,
      target_type: grant.target_type,
      target_id: grant.target_id,
    },
    activeOnKey: count ?? 0,
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const adminId = await requireGrantsAdmin();
  if (!adminId) {
    return NextResponse.json({ error: "unauthorized" }, { status: 403 });
  }

  const grantId = params.id;
  if (!grantId || !UUID_RE.test(grantId)) {
    return NextResponse.json({ error: "valid_grant_id_required" }, { status: 400 });
  }

  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const action = body.action;
  if (action !== "approve" && action !== "reject" && action !== "revoke") {
    return NextResponse.json(
      { error: "action_must_be_approve_reject_or_revoke" },
      { status: 400 },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  const { data: grant } = await admin
    .from("entity_grants")
    .select("id, user_id, role, target_type, target_id, status, evidence_id")
    .eq("id", grantId)
    .maybeSingle();
  if (!grant) {
    return NextResponse.json({ error: "grant_not_found" }, { status: 404 });
  }
  // FIX-928 — revoke is the ACTIVE-grant action and runs before the
  // pending-only gate, which governs approve/reject alone.
  if (action === "revoke") {
    if (grant.status !== "active") {
      return NextResponse.json(
        { error: "grant_not_active", status: grant.status },
        { status: 409 },
      );
    }
    const { data: revoked, error: revokeErr } = await admin.rpc("revoke_grant", {
      p_user_id: grant.user_id,
      p_role: grant.role,
      p_target_type: grant.target_type,
      p_target_id: grant.target_id,
      p_actor_id: adminId,
      p_reason: "revoked via /api/admin/grants",
    });
    if (revokeErr) {
      return NextResponse.json({ error: "grant_revoke_failed" }, { status: 500 });
    }
    // The count is part of the response on purpose. Under the FIX-928 index it
    // is 1; anything higher means the index was dropped or bypassed and this
    // account had duplicate live access, which the caller should see rather
    // than have smoothed over.
    return NextResponse.json({ ok: true, status: "revoked", revoked: revoked ?? 0 });
  }

  if (grant.status !== "pending") {
    return NextResponse.json(
      { error: "grant_not_pending", status: grant.status },
      { status: 409 },
    );
  }

  const reviewedAt = new Date();

  // The target official, read ONCE for both branches. Approve needs the term
  // dates for expiry (decision 8); FIX-560 needs full_name for the notification
  // body, and reject needs it too — so the read moved out of the approve branch
  // rather than being duplicated into reject.
  let official: { term_end: string | null; current_term_end: string | null; full_name: string | null } | null = null;
  if (grant.target_type === "official" && grant.target_id) {
    const { data } = await admin
      .from("officials")
      .select("term_end, current_term_end, full_name")
      .eq("id", grant.target_id)
      .maybeSingle();
    official = data ?? null;
  }
  const targetName = official?.full_name ?? null;

  if (action === "approve") {
    // Expiry follows the target official's term when known (decision 8).
    const expiresAt = computeExpiry(
      official?.term_end ?? null,
      official?.current_term_end ?? null,
      reviewedAt,
    );

    const { error: grantErr } = await admin
      .from("entity_grants")
      .update({
        status: "active",
        granted_at: reviewedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        granted_by: adminId,
      })
      .eq("id", grantId);
    if (grantErr) {
      return NextResponse.json({ error: "grant_update_failed" }, { status: 500 });
    }

    if (grant.evidence_id) {
      await admin
        .from("grant_evidence")
        .update({
          outcome: "approved",
          reviewed_at: reviewedAt.toISOString(),
          reviewer_id: adminId,
        })
        .eq("id", grant.evidence_id);
    }

    await admin.from("grant_events").insert({
      grant_id: grantId,
      event: "approved",
      actor_id: adminId,
    });

    await notifyClaimant(grant, "approved", targetName);

    return NextResponse.json({ ok: true, status: "active", expires_at: expiresAt.toISOString() });
  }

  // reject
  const { error: grantErr } = await admin
    .from("entity_grants")
    .update({ status: "revoked" })
    .eq("id", grantId);
  if (grantErr) {
    return NextResponse.json({ error: "grant_update_failed" }, { status: 500 });
  }

  if (grant.evidence_id) {
    await admin
      .from("grant_evidence")
      .update({
        outcome: "rejected",
        reviewed_at: reviewedAt.toISOString(),
        reviewer_id: adminId,
      })
      .eq("id", grant.evidence_id);
  }

  await admin.from("grant_events").insert({
    grant_id: grantId,
    event: "rejected",
    actor_id: adminId,
  });

  await notifyClaimant(grant, "rejected", targetName);

  return NextResponse.json({ ok: true, status: "revoked" });
}
