/**
 * Elections pipeline — FIX-022.
 *
 * Populates the election-status columns on `officials`:
 *   current_term_start, current_term_end, next_election_date,
 *   next_election_type, is_up_for_election
 *
 * Sources (no external API fetches — all derived from data we already have):
 *   - Existing term_start / term_end columns (set by Congress + OpenStates pipelines).
 *   - Curated US federal + state election calendar in ./calendar.ts. The state
 *     calendar covers NJ/VA/KY/LA/MS odd-year cycles; other states fall back
 *     to the federal calendar.
 *
 * Ballotpedia was considered as a secondary source but its free API coverage is
 * narrower than the curated state calendar + OpenStates term_end data. Phase 2
 * may add a Ballotpedia pipeline for contested-primary metadata.
 *
 * Safe to re-run: UPDATEs are idempotent.
 *
 * Run standalone:
 *   pnpm --filter @civitics/data data:elections
 */

import { createAdminClient } from "@civitics/db";
import { completeSync, failSync, startSync, type PipelineResult } from "../sync-log";
import { withDirectClient } from "../../lib/direct-pg-upsert";
import {
  FEDERAL_GENERAL_ELECTIONS,
  STATE_ELECTION_CALENDAR,
  nextLegislativeElection,
  nextGubernatorialElection,
} from "./calendar";

function nextFederalGeneral(asOf: Date): string | null {
  const now = asOf.toISOString().slice(0, 10);
  for (const d of FEDERAL_GENERAL_ELECTIONS) {
    if (d > now) return d;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface OfficialRow {
  id: string;
  role_title: string | null;
  term_start: string | null;
  term_end: string | null;
  jurisdiction_id: string;
  governing_body_id: string | null;
  metadata: Record<string, unknown> | null;
  // Current stored values of the five output columns, fetched so change-detection
  // can skip rows whose computed values are unchanged (FIX-819). On a steady-state
  // run these match the freshly-computed values for ~every row → nothing written.
  current_term_start: string | null;
  current_term_end: string | null;
  next_election_date: string | null;
  next_election_type: string | null;
  is_up_for_election: boolean;
}

interface JurisdictionRow {
  id: string;
  type: string;
}

// One changed official, aligned to the VALUES tuple below:
//   [id, current_term_start, current_term_end, next_election_date,
//    next_election_type, is_up_for_election]
type ChangedRow = [string, string | null, string | null, string | null, string | null, boolean];

// Compare date columns as YYYY-MM-DD strings (null==null unchanged). Both the
// stored value and the computed value are `date` columns, but slice defensively
// in case a timestamp string ever sneaks in.
function normDate(v: string | null | undefined): string | null {
  return v == null ? null : String(v).slice(0, 10);
}

// FIX-819 — build a chunked set-based UPDATE for the changed officials, replacing
// ~27k single-row PostgREST round-trips. Placeholders run $1..$(rowCount*6)
// row-major, aligned to ChangedRow. The VALUES list lives in a FROM subquery, so
// its column types come from the literals alone — node-postgres sends every param
// untyped, so the FIRST row's placeholders carry explicit casts to pin each
// column's type (id→uuid, dates→date, type→text, flag→boolean); every later row's
// bare params coerce to it. Without that pin, an all-NULL/all-unknown column would
// error "could not determine data type of parameter".
export function buildElectionUpdateStatement(rowCount: number): string {
  if (rowCount <= 0) throw new Error("buildElectionUpdateStatement: rowCount must be > 0");
  const casts = ["::uuid", "::date", "::date", "::date", "::text", "::boolean"];
  const tuples: string[] = [];
  let p = 1;
  for (let r = 0; r < rowCount; r++) {
    const cells = casts.map((cast) => `$${p++}${r === 0 ? cast : ""}`);
    tuples.push(`(${cells.join(", ")})`);
  }
  return (
    "UPDATE public.officials AS o SET " +
    "current_term_start = v.cts, " +
    "current_term_end = v.cte, " +
    "next_election_date = v.ned, " +
    "next_election_type = v.net, " +
    "is_up_for_election = v.iufe " +
    `FROM (VALUES ${tuples.join(", ")}) AS v(id, cts, cte, ned, net, iufe) ` +
    "WHERE o.id = v.id"
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function runElectionsPipeline(): Promise<PipelineResult> {
  console.log("\n=== Elections pipeline ===");
  const logId = await startSync("elections");
  const db = createAdminClient();
  const result: PipelineResult = { inserted: 0, updated: 0, failed: 0, estimatedMb: 0 };

  try {
    const { data: jRows, error: jErr } = await db
      .from("jurisdictions")
      .select("id, type");
    if (jErr) throw new Error(jErr.message);
    const jurisdictionType = new Map<string, string>();
    for (const j of (jRows ?? []) as JurisdictionRow[]) jurisdictionType.set(j.id, j.type);

    // Build a "this governing_body is federal" lookup. Federal House/Senate
    // members can have jurisdiction_id set to their state (not 'country'),
    // so we need governing_body to disambiguate.
    const { data: gbRows, error: gbErr } = await db
      .from("governing_bodies")
      .select("id, name");
    if (gbErr) throw new Error(gbErr.message);
    const federalGoverningBody = new Set<string>();
    for (const gb of (gbRows ?? []) as Array<{ id: string; name: string | null }>) {
      const n = (gb.name ?? "").toLowerCase();
      if (n.includes("united states") || n.startsWith("u.s. ") || n.startsWith("us ")) {
        federalGoverningBody.add(gb.id);
      }
    }

    // Paginate officials in 1000-row chunks to avoid memory spikes on full table.
    const now = new Date();
    const nowIso = now.toISOString().slice(0, 10);
    const pageSize = 1000;
    let offset = 0;
    let scanned = 0;
    // FIX-819 — accumulate only the officials whose computed values differ from
    // what's already stored. On a steady-state run this stays ~empty (election
    // dates are near-static); the occasional bulk flip (a fixed date rolling
    // past → many is_up_for_election flip on one run) is handled by the chunked
    // set-based write below.
    const changed: ChangedRow[] = [];

    for (;;) {
      const { data, error } = await db
        .from("officials")
        .select(
          "id, role_title, term_start, term_end, jurisdiction_id, governing_body_id, metadata, current_term_start, current_term_end, next_election_date, next_election_type, is_up_for_election",
        )
        .eq("is_active", true)
        .order("id", { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw new Error(error.message);

      const rows = (data ?? []) as OfficialRow[];
      if (rows.length === 0) break;

      for (const r of rows) {
        const jType = jurisdictionType.get(r.jurisdiction_id);
        // Federal officials either live under the 'country' jurisdiction
        // OR are attached to a state jurisdiction (e.g. NJ Reps) but belong
        // to a federal governing body (US House / US Senate).
        const isFederal = jType === "country"
          || (r.governing_body_id !== null && federalGoverningBody.has(r.governing_body_id));

        // Current term copy-over (idempotent; same value if already set).
        const currentTermStart = r.term_start;
        const currentTermEnd   = r.term_end;

        const stateAbbr = (r.metadata && typeof r.metadata["state"] === "string")
          ? (r.metadata["state"] as string)
          : null;

        // Governor detection: role title contains "governor" but not
        // "lieutenant" (lt govs are typically on the same cycle anyway, but
        // if data ever reflects a distinct cycle we'd want to handle that).
        const role = (r.role_title ?? "").toLowerCase();
        const isGovernor = role.includes("governor") && !role.includes("lieutenant");

        let nextElectionDate: string | null = null;
        let nextElectionType: string | null = null;

        if (isFederal) {
          // Federal officials: next federal general election.
          nextElectionDate = nextFederalGeneral(now);
          nextElectionType = "general";
        } else if (isGovernor) {
          // State governor: separate cycle in KY/LA/MS/NJ/VA, federal cycle elsewhere.
          nextElectionDate = nextGubernatorialElection(stateAbbr, nowIso);
          nextElectionType = "general";
        } else {
          // State/local officials. Use the state-specific legislative calendar
          // when available. If we have a term_end, prefer the latest cycle
          // date that falls on or before term_end (i.e. the actual election
          // that ends THIS term); otherwise fall back to the next upcoming.
          const candidates =
            (stateAbbr && STATE_ELECTION_CALENDAR[stateAbbr]?.legislative)
            ?? FEDERAL_GENERAL_ELECTIONS;

          if (currentTermEnd) {
            for (let i = candidates.length - 1; i >= 0; i--) {
              const d = candidates[i]!;
              if (d <= currentTermEnd && d >= nowIso) {
                nextElectionDate = d;
                nextElectionType = "general";
                break;
              }
            }
          }
          if (!nextElectionDate) {
            nextElectionDate = nextLegislativeElection(stateAbbr, nowIso);
            if (nextElectionDate) nextElectionType = "general";
          }
        }

        const isUp = nextElectionDate !== null
          && nextElectionDate >= nowIso
          && // "up for election" if within the next 13 months
             (Date.parse(nextElectionDate) - now.getTime()) / 86400000 <= 400;

        const patch = {
          current_term_start: currentTermStart,
          current_term_end:   currentTermEnd,
          next_election_date: nextElectionDate,
          next_election_type: nextElectionType,
          is_up_for_election: isUp,
        };

        // Change-detection: only queue a write if at least one of the five
        // output values actually differs from what's stored.
        const isChanged =
          normDate(patch.current_term_start) !== normDate(r.current_term_start) ||
          normDate(patch.current_term_end)   !== normDate(r.current_term_end) ||
          normDate(patch.next_election_date) !== normDate(r.next_election_date) ||
          (patch.next_election_type ?? null) !== (r.next_election_type ?? null) ||
          patch.is_up_for_election           !== r.is_up_for_election;

        if (isChanged) {
          changed.push([
            r.id,
            patch.current_term_start,
            patch.current_term_end,
            patch.next_election_date,
            patch.next_election_type,
            patch.is_up_for_election,
          ]);
        }
        scanned++;
      }

      offset += rows.length;
      if (rows.length < pageSize) break;
    }

    // FIX-819 — write the changed set with a single chunked direct-pg
    // UPDATE...FROM (VALUES ...) per chunk (autocommit, so a bad chunk doesn't
    // poison the rest). Skip the connection entirely on the common changed=0 run.
    if (changed.length > 0) {
      const CHUNK = 1000; // 1000 rows × 6 params = 6000 bind params (< 65535 cap)
      await withDirectClient(async (client) => {
        for (let i = 0; i < changed.length; i += CHUNK) {
          const chunk = changed.slice(i, i + CHUNK);
          const sql = buildElectionUpdateStatement(chunk.length);
          const params: unknown[] = [];
          for (const row of chunk) params.push(...row);
          try {
            await client.query(sql, params);
            result.updated += chunk.length;
          } catch (err) {
            console.error(
              `  elections chunk ${i}-${i + chunk.length} failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
            result.failed += chunk.length;
          }
        }
      });
    }

    console.log(
      `  Elections: detected=${scanned} changed=${result.updated}` +
        (result.failed ? ` failed=${result.failed}` : ""),
    );

    await completeSync(logId, result);
    return result;
  } catch (err) {
    await failSync(logId, err instanceof Error ? err.message : String(err));
    throw err;
  }
}

if (require.main === module) {
  runElectionsPipeline()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
