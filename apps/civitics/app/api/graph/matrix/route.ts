import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createAdminClient } from "@civitics/db";
import { supabaseUnavailable, unavailableResponse } from "@/lib/supabase-check";

export const dynamic = "force-dynamic";

// ── Types ─────────────────────────────────────────────────────────────────────

interface OfficialRow {
  id: string;
  full_name: string;
  party: string | null;
  district_name: string | null;
  // officials has no `state` / `chamber` column post-cutover — both live in
  // metadata. Selecting them directly 500s the whole route (oErr fires before
  // the votes fetch is even read), so derive from metadata instead.
  metadata: Record<string, unknown> | null;
}

interface VoteRow {
  official_id: string;
  bill_proposal_id: string;
  vote: string;
}

export interface MatrixOfficial {
  id: string;
  name: string;
  party: string | null;
  state: string | null;
  chamber: string | null;
}

export interface MatrixCell {
  /** Number of proposals where both officials voted yes/no (paired_yes/no count). */
  shared: number;
  /** Of those, how many they agreed on. */
  agreed: number;
  /** agreed / shared, or null if shared = 0. */
  agreement: number | null;
  /** Cohen's kappa, or null if undefined (e.g. one official always votes the same way). */
  kappa: number | null;
}

export interface MatrixResponse {
  officials: MatrixOfficial[];
  /** Symmetric N×N matrix indexed in `officials` order. cells[i][j] = cells[j][i]. */
  cells: MatrixCell[][];
  /** Number of distinct proposals across all selected officials (informational). */
  proposalCount: number;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_OFFICIALS = 25;

// Normalise vote values into the three buckets we score on. paired_yes/no count
// as votes; abstain / present / not_voting collapse to "no opinion" and are
// dropped from agreement math (they're not a yes/no signal).
function bucket(vote: string): "yes" | "no" | null {
  if (vote === "yes" || vote === "paired_yes") return "yes";
  if (vote === "no" || vote === "paired_no") return "no";
  return null;
}

// Cohen's kappa for two raters (yes/no on shared proposals). Returns null when
// one rater has zero variance — kappa is undefined in that case.
function cohensKappa(
  agreed: number,
  shared: number,
  aYes: number,
  aNo: number,
  bYes: number,
  bNo: number,
): number | null {
  if (shared === 0) return null;
  const po = agreed / shared;
  const pe =
    (aYes / shared) * (bYes / shared) + (aNo / shared) * (bNo / shared);
  if (pe === 1) return null;
  return (po - pe) / (1 - pe);
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (supabaseUnavailable()) return unavailableResponse();

  const { searchParams } = new URL(req.url);
  const idsParam = searchParams.get("ids") ?? "";
  const ids = idsParam
    .split(",")
    .map((s) => s.trim())
    .filter((s) => UUID_RE.test(s))
    .slice(0, MAX_OFFICIALS);

  if (ids.length < 2) {
    return NextResponse.json(
      { error: "Provide at least 2 official UUIDs in ?ids=..." },
      { status: 400 },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = createAdminClient() as any;

  const [{ data: officialRows, error: oErr }, { data: voteRows, error: vErr }] =
    await Promise.all([
      supabase
        .from("officials")
        .select("id, full_name, party, district_name, metadata")
        .in("id", ids),
      supabase
        .from("votes")
        .select("official_id, bill_proposal_id, vote")
        .in("official_id", ids),
    ]);

  if (oErr) {
    console.error("[graph/matrix] officials fetch:", oErr.message);
    return NextResponse.json({ error: oErr.message }, { status: 500 });
  }
  if (vErr) {
    console.error("[graph/matrix] votes fetch:", vErr.message);
    return NextResponse.json({ error: vErr.message }, { status: 500 });
  }

  // Order officials to match the request order, dropping any UUIDs that
  // didn't resolve to a real row.
  const officialMap = new Map<string, OfficialRow>(
    ((officialRows ?? []) as OfficialRow[]).map((r) => [r.id, r]),
  );
  const officials: MatrixOfficial[] = ids
    .map((id) => officialMap.get(id))
    .filter((r): r is OfficialRow => Boolean(r))
    .map((r) => ({
      id: r.id,
      name: r.full_name,
      party: r.party,
      state: (r.metadata?.state as string | undefined) ?? null,
      chamber: (r.metadata?.chamber as string | undefined) ?? null,
    }));

  if (officials.length < 2) {
    return NextResponse.json(
      { error: "Fewer than 2 of the supplied IDs matched real officials" },
      { status: 400 },
    );
  }

  // Build proposal_id → official_id → bucket lookup.
  // Skip rows whose vote bucket is null (abstain etc.).
  const byProposal = new Map<string, Map<string, "yes" | "no">>();
  for (const row of (voteRows ?? []) as VoteRow[]) {
    const b = bucket(row.vote);
    if (!b) continue;
    let inner = byProposal.get(row.bill_proposal_id);
    if (!inner) {
      inner = new Map();
      byProposal.set(row.bill_proposal_id, inner);
    }
    inner.set(row.official_id, b);
  }

  const N = officials.length;
  const cells: MatrixCell[][] = Array.from({ length: N }, () =>
    Array.from({ length: N }, () => ({
      shared: 0,
      agreed: 0,
      agreement: null as number | null,
      kappa: null as number | null,
    })),
  );

  // Per-official yes/no counts on the shared sub-corpus, used for kappa's
  // chance-agreement term. Recomputed per-pair so the corpus matches.
  for (let i = 0; i < N; i++) {
    const oi = officials[i];
    if (!oi) continue;
    for (let j = i; j < N; j++) {
      const oj = officials[j];
      if (!oj) continue;
      const a = oi.id;
      const b = oj.id;
      let shared = 0;
      let agreed = 0;
      let aYes = 0;
      let aNo = 0;
      let bYes = 0;
      let bNo = 0;
      for (const inner of byProposal.values()) {
        const va = inner.get(a);
        const vb = inner.get(b);
        if (!va || !vb) continue;
        shared++;
        if (va === vb) agreed++;
        if (va === "yes") aYes++;
        else aNo++;
        if (vb === "yes") bYes++;
        else bNo++;
      }
      const agreement = shared > 0 ? agreed / shared : null;
      const kappa =
        i === j
          ? 1
          : cohensKappa(agreed, shared, aYes, aNo, bYes, bNo);
      const cell: MatrixCell = { shared, agreed, agreement, kappa };
      const rowI = cells[i];
      const rowJ = cells[j];
      if (rowI) rowI[j] = cell;
      if (rowJ) rowJ[i] = cell;
    }
  }

  const response: MatrixResponse = {
    officials,
    cells,
    proposalCount: byProposal.size,
  };

  return NextResponse.json(response, {
    headers: {
      "Cache-Control":
        "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
