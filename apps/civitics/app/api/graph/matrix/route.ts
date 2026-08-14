import { NextResponse } from "next/server";
import { withPublicCdnCache } from "@/lib/cdn-cache";
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

interface AgreementPairRow {
  official_a: string;
  official_b: string;
  shared: number;
  agreed: number;
  yes_a: number;
  yes_b: number;
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

// Vote bucketing (yes/paired_yes -> yes, no/paired_no -> no, everything else
// dropped) now lives inside the get_vote_agreement_matrix RPC so the pairwise
// counting happens server-side. See migration
// 20260607020000_fix510_vote_agreement_matrix_rpc.sql.

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
    .map((s) => s.trim().toLowerCase())
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

  const [{ data: officialRows, error: oErr }, { data: pairRows, error: vErr }] =
    await Promise.all([
      supabase
        .from("officials")
        .select("id, full_name, party, district_name, metadata")
        // .in() bounded: `ids` is UUID-validated and `.slice(0, MAX_OFFICIALS)`d
        // to 25 at parse time, max 25 — FIX-902
        .in("id", ids),
      // FIX-510 — pairwise agreement computed server-side. The old path fetched
      // every vote row for these officials (votes.official_id = ANY(ids)) and
      // built the matrix in JS; for 25 high-volume officials that is 59k+ rows,
      // silently capped at 1,000 by PostgREST → the matrix was built from ~2% of
      // the data. The RPC returns <=325 rows (one per unordered pair + self).
      supabase.rpc("get_vote_agreement_matrix", { p_official_ids: ids }),
    ]);

  if (oErr) {
    console.error("[graph/matrix] officials fetch:", oErr.message);
    return NextResponse.json({ error: oErr.message }, { status: 500 });
  }
  if (vErr) {
    console.error("[graph/matrix] agreement RPC:", vErr.message);
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

  // FIX-510 — fold the RPC's pair rows into lookup maps. One row per unordered
  // pair (official_a <= official_b on uuid); self-pairs (official_a =
  // official_b) carry each official's own bucketed-vote count for the diagonal.
  // Counts arrive as bigint strings/numbers → Number() them.
  const N = officials.length;
  const pairByKey = new Map<string, AgreementPairRow>();
  const selfShared = new Map<string, number>();
  for (const r of (pairRows ?? []) as AgreementPairRow[]) {
    if (r.official_a === r.official_b) {
      selfShared.set(r.official_a, Number(r.shared));
    } else {
      pairByKey.set(`${r.official_a}|${r.official_b}`, r);
    }
  }

  const cells: MatrixCell[][] = Array.from({ length: N }, () =>
    Array.from({ length: N }, () => ({
      shared: 0,
      agreed: 0,
      agreement: null as number | null,
      kappa: null as number | null,
    })),
  );

  for (let i = 0; i < N; i++) {
    const oi = officials[i];
    if (!oi) continue;
    for (let j = i; j < N; j++) {
      const oj = officials[j];
      if (!oj) continue;

      let cell: MatrixCell;
      if (i === j) {
        // Diagonal: an official agrees with themselves on every vote they cast.
        // shared = that official's own bucketed-vote count.
        const s = selfShared.get(oi.id) ?? 0;
        cell = { shared: s, agreed: s, agreement: s > 0 ? 1 : null, kappa: 1 };
      } else {
        // Off-diagonal: look the pair up under the uuid-ordered key the RPC
        // emitted (a <= b), then orient yes_a/yes_b back onto (i, j) so kappa's
        // per-rater chance term matches the right official.
        const [lo, hi] = oi.id < oj.id ? [oi.id, oj.id] : [oj.id, oi.id];
        const pr = pairByKey.get(`${lo}|${hi}`);
        if (pr) {
          const shared = Number(pr.shared);
          const agreed = Number(pr.agreed);
          const iYes = oi.id === lo ? Number(pr.yes_a) : Number(pr.yes_b);
          const jYes = oj.id === lo ? Number(pr.yes_a) : Number(pr.yes_b);
          const agreement = shared > 0 ? agreed / shared : null;
          const kappa = cohensKappa(
            agreed,
            shared,
            iYes,
            shared - iYes,
            jYes,
            shared - jYes,
          );
          cell = { shared, agreed, agreement, kappa };
        } else {
          // No row emitted → the pair shares no bucketed roll calls.
          cell = { shared: 0, agreed: 0, agreement: null, kappa: null };
        }
      }

      const rowI = cells[i];
      const rowJ = cells[j];
      if (rowI) rowI[j] = cell;
      if (rowJ) rowJ[i] = cell;
    }
  }

  // proposalCount was byProposal.size (distinct proposals with >=1 bucketed
  // vote among the selected officials). The union of distinct roll calls isn't
  // derivable from pairwise counts; use the busiest official's own bucketed
  // count as the informational header value — exact when the officials share a
  // corpus, a lower bound otherwise. Display-only; no cell math depends on it.
  const proposalCount =
    selfShared.size > 0 ? Math.max(...selfShared.values()) : 0;

  const response: MatrixResponse = {
    officials,
    cells,
    proposalCount,
  };

  return withPublicCdnCache(NextResponse.json(response, {
    headers: {
      "Cache-Control":
        "public, max-age=0, s-maxage=300, stale-while-revalidate=3600",
    },
  }));
}
