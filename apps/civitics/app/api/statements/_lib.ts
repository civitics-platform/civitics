// Shared helpers for the /api/statements surface (C1 Wave C, FIX-534).
//
// Statements mirror the C0 ratings privacy model: private ballots
// (statement_votes, own-rows), public aggregates (entity_statements.vote_summary).
// All writes go through SECURITY DEFINER RPCs (submit_statement / set_statement_vote)
// called with the CALLER's createServerClient so auth.uid() is the caller — never
// the admin client (which would make auth.uid() NULL).

import { NextResponse } from "next/server";

// Postgres SQLSTATE → HTTP. The RPCs RAISE with explicit ERRCODEs; PostgREST
// surfaces the SQLSTATE in error.code, which we re-map to a stable HTTP shape.
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
      return NextResponse.json({ error: msg ?? "Daily limit reached", code: "rate_limited" }, { status: 429 });
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
