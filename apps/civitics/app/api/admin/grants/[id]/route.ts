import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@civitics/db";
import { requireGrantsAdmin } from "../_lib";
import { computeExpiry } from "../../../officials/claim/_lib";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST /api/admin/grants/[id]  body: { action: 'approve' | 'reject' }
//
// FIX-559 decision 9 (memo-locked semantics):
//   approve → grant status='active', granted_at=now(), expires_at =
//             COALESCE(term_end, current_term_end) when future else now()+2y;
//             evidence outcome='approved' + reviewed_at/reviewer_id;
//             grant_events event='approved' with actor_id=<admin>.
//   reject  → grant status='revoked'; evidence outcome='rejected' (+ same
//             review stamps); grant_events event='rejected'.
// Only pending grants are actionable — anything else 409s.
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
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json(
      { error: "action_must_be_approve_or_reject" },
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
  if (grant.status !== "pending") {
    return NextResponse.json(
      { error: "grant_not_pending", status: grant.status },
      { status: 409 },
    );
  }

  const reviewedAt = new Date();

  if (action === "approve") {
    // Expiry follows the target official's term when known (decision 8).
    let expiresAt = computeExpiry(null, null, reviewedAt);
    if (grant.target_type === "official" && grant.target_id) {
      const { data: official } = await admin
        .from("officials")
        .select("term_end, current_term_end")
        .eq("id", grant.target_id)
        .maybeSingle();
      expiresAt = computeExpiry(
        official?.term_end ?? null,
        official?.current_term_end ?? null,
        reviewedAt,
      );
    }

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

  return NextResponse.json({ ok: true, status: "revoked" });
}
