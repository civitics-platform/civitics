// Shared helpers for the /api/investigations + /api/evidence surfaces
// (Investigations MVP PR1, FIX-578).
//
// All writes go through SECURITY DEFINER RPCs (create_investigation,
// add_evidence_card, add_citation, rate_evidence, set_investigation_findings)
// called with the CALLER's createServerClient so auth.uid() is the caller — never
// the admin client (which would make auth.uid() NULL). Reads use the same caller
// client so the RLS SELECT policies do the private-person filtering.

import { NextResponse } from "next/server";

// Postgres SQLSTATE → HTTP. The RPCs RAISE with explicit ERRCODEs; PostgREST
// surfaces the SQLSTATE in error.code, which we re-map to a stable HTTP shape.
// Same vocabulary as /api/statements/_lib (53400 → 429 over-limit, etc.).
type RpcError = { code?: string; message?: string } | null;

export function mapRpcError(error: RpcError): NextResponse {
  const code = error?.code;
  const msg = error?.message;
  switch (code) {
    case "28000":
      return NextResponse.json({ error: "Sign in to continue", code: "not_authenticated" }, { status: 401 });
    case "22023":
      return NextResponse.json({ error: msg ?? "Invalid input", code: "invalid_input" }, { status: 400 });
    case "53400":
      return NextResponse.json({ error: msg ?? "Limit reached", code: "rate_limited" }, { status: 429 });
    case "42501":
      return NextResponse.json({ error: msg ?? "Not allowed", code: "forbidden" }, { status: 403 });
    case "42704":
      return NextResponse.json({ error: msg ?? "Not found", code: "not_found" }, { status: 404 });
    case "23505":
      return NextResponse.json({ error: msg ?? "Already exists", code: "conflict" }, { status: 409 });
    default:
      return NextResponse.json({ error: "Something went wrong", code: "server_error" }, { status: 500 });
  }
}

// A presentation-neutral fallback display name (mirrors get_entity_statements'
// 'citizen-' || left(id,8) convention) for contributors whose users row is not
// readable to the caller.
export function fallbackName(userId: string): string {
  return `citizen-${userId.slice(0, 8)}`;
}
