import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createServerClient, createAdminClient } from "@civitics/db";
import { computeExpiry } from "./_lib";

export const dynamic = "force-dynamic";

// FIX-558: official self-serve profile claim.
//
// The claimed email IS the signed-in user's auth email — magic-link OTP
// already proved ownership, so there is no secondary-email verification.
// Exact match (case-insensitive, trimmed) against the official's
// metadata->>'email' auto-approves; everything else lands in the pending
// queue reviewed at /admin/grants. A bare domain match never auto-approves —
// it is spoofable across same-domain colleagues.
//
// PII hard rule: nothing beyond the auth email + the user-authored
// justification is persisted. Evidence metadata records the auth-email
// DOMAIN and whether it domain-matched the official's listed email — never
// the full address, never documents.

const JUSTIFICATION_MAX = 1000;
const RATE_LIMIT_PER_HOUR = 5;
const CLAIM_METHODS = ["gov_email", "manual_review"] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at === -1 ? "" : email.slice(at + 1).toLowerCase();
}

export async function POST(request: NextRequest) {
  // 1. Auth
  const cookieStore = await cookies();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createServerClient(cookieStore) as any;
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !user.email) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const authEmail = user.email.trim().toLowerCase();

  // 2. Body validation
  let body: { official_id?: unknown; justification?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const officialId =
    typeof body.official_id === "string" ? body.official_id.trim() : "";
  const justification =
    typeof body.justification === "string" ? body.justification.trim() : "";
  if (!officialId || !UUID_RE.test(officialId)) {
    return NextResponse.json({ error: "valid_official_id_required" }, { status: 404 });
  }
  if (!justification) {
    return NextResponse.json({ error: "justification_required" }, { status: 400 });
  }
  if (justification.length > JUSTIFICATION_MAX) {
    return NextResponse.json({ error: "justification_too_long" }, { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin = createAdminClient() as any;

  // 3. Per-user rate limit (5 claim attempts / hour, any outcome)
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentCount } = await admin
    .from("grant_evidence")
    .select("id", { count: "exact", head: true })
    .eq("user_id", user.id)
    .in("method", CLAIM_METHODS)
    .gte("submitted_at", oneHourAgo);
  if ((recentCount ?? 0) >= RATE_LIMIT_PER_HOUR) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  // 4. Official lookup. Emails live in metadata->>'email' — the first-class
  // email column is unpopulated across the dataset.
  const { data: official } = await admin
    .from("officials")
    .select("id, full_name, term_end, current_term_end, metadata")
    .eq("id", officialId)
    .maybeSingle();
  if (!official) {
    return NextResponse.json({ error: "official_not_found" }, { status: 404 });
  }

  // 5. One claim per (user, official): reject while an active or pending
  // grant exists. Rejected (revoked) and expired claims may be resubmitted.
  const { data: existing } = await admin
    .from("entity_grants")
    .select("id, status")
    .eq("user_id", user.id)
    .eq("role", "official")
    .eq("target_type", "official")
    .eq("target_id", officialId)
    .in("status", ["active", "pending"])
    .limit(1)
    .maybeSingle();
  if (existing) {
    return NextResponse.json(
      { error: "claim_exists", status: existing.status },
      { status: 409 },
    );
  }

  // 6. Exact-email check — the only auto-approve path. Empty string never
  // matches.
  const officialEmail =
    typeof official.metadata?.email === "string"
      ? official.metadata.email.trim().toLowerCase()
      : "";
  const exactMatch = officialEmail !== "" && officialEmail === authEmail;

  const authDomain = emailDomain(authEmail);
  const domainMatch =
    officialEmail !== "" && authDomain !== "" && emailDomain(officialEmail) === authDomain;

  if (exactMatch) {
    // 7a. Fast path — auto-approve.
    const { data: evidenceRow, error: evidenceErr } = await admin
      .from("grant_evidence")
      .insert({
        user_id: user.id,
        method: "gov_email",
        outcome: "approved",
        notes: justification,
        metadata: {
          auth_email_domain: authDomain,
          domain_match: true,
          exact_match: true,
        },
      })
      .select("id")
      .single();
    if (evidenceErr || !evidenceRow) {
      return NextResponse.json({ error: "evidence_write_failed" }, { status: 500 });
    }

    const grantedAt = new Date();
    const expiresAt = computeExpiry(
      official.term_end,
      official.current_term_end,
      grantedAt,
    );

    const { data: grant, error: grantErr } = await admin
      .from("entity_grants")
      .insert({
        user_id: user.id,
        role: "official",
        target_type: "official",
        target_id: officialId,
        status: "active",
        granted_at: grantedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
        evidence_id: evidenceRow.id,
      })
      .select("id")
      .single();
    if (grantErr || !grant) {
      return NextResponse.json({ error: "grant_write_failed" }, { status: 500 });
    }

    await admin.from("grant_events").insert({
      grant_id: grant.id,
      event: "auto_approved",
      actor_id: null,
      metadata: { source: "official_claim_exact_email" },
    });

    return NextResponse.json({
      approved: true,
      expires_at: expiresAt.toISOString(),
    });
  }

  // 7b. Slow path — pending queue. gov_email when the auth domain ends in
  // .gov, else manual_review; both reviewed at /admin/grants either way.
  const method = authDomain.endsWith(".gov") ? "gov_email" : "manual_review";

  const { data: evidenceRow, error: evidenceErr } = await admin
    .from("grant_evidence")
    .insert({
      user_id: user.id,
      method,
      outcome: "pending",
      notes: justification,
      metadata: {
        auth_email_domain: authDomain,
        domain_match: domainMatch,
        exact_match: false,
      },
    })
    .select("id")
    .single();
  if (evidenceErr || !evidenceRow) {
    return NextResponse.json({ error: "evidence_write_failed" }, { status: 500 });
  }

  const { data: grant, error: grantErr } = await admin
    .from("entity_grants")
    .insert({
      user_id: user.id,
      role: "official",
      target_type: "official",
      target_id: officialId,
      status: "pending",
      evidence_id: evidenceRow.id,
    })
    .select("id")
    .single();
  if (grantErr || !grant) {
    return NextResponse.json({ error: "grant_write_failed" }, { status: 500 });
  }

  await admin.from("grant_events").insert({
    grant_id: grant.id,
    event: "submitted",
    actor_id: user.id,
    metadata: { method, domain_match: domainMatch },
  });

  return NextResponse.json({ submitted: true });
}
