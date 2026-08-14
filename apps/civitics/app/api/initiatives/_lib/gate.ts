/**
 * Quality gate logic for Civic Initiatives.
 *
 * v2 gate — population-normalised upvote threshold (Sprint 9)
 *
 * Four signals for deliberate→mobilise transition:
 *
 * 1. TIME_MINIMUM     — initiative must have been in 'deliberate' stage for ≥72h
 * 2. UPVOTE_THRESHOLD — scales with district population (see POPULATION_TIERS)
 * 3. FOR_ARGUMENT     — ≥1 top-level 'for' argument with ≥3 votes
 * 4. AGAINST_ARGUMENT — ≥1 top-level 'against' argument with ≥3 votes
 *
 * Population lookup: if the initiative has a `jurisdiction_id`, we fetch the
 * actual population from the `jurisdictions` table. Otherwise we fall back to
 * scope-level defaults (local 75K, state 6.5M, federal 335M).
 *
 * draft→deliberate is intentionally un-gated: it's just the author opening
 * the initiative for community input.
 *
 * Scores are persisted to quality_gate_score JSONB on the initiative row
 * each time the gate is evaluated.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchChunkedByIds } from "@/lib/paginate";

// ─── Config ───────────────────────────────────────────────────────────────────

export const GATE_CONFIG = {
  TIME_MINIMUM_HOURS: 72,
  MIN_ARG_VOTES:       3,
  UPVOTE_MINIMUM:     10,   // floor — no district ever requires fewer than this
} as const;

/**
 * Population tiers for upvote threshold scaling.
 * Chosen so that a small local initiative (< 100K residents) matches the v1
 * flat threshold of 10, while a federal initiative requires 500.
 */
const POPULATION_TIERS: Array<{ maxPop: number; upvotes: number; label: string }> = [
  { maxPop:    100_000, upvotes:  10, label: "Small district (< 100K)"      },
  { maxPop:    500_000, upvotes:  25, label: "Mid district (< 500K)"        },
  { maxPop:  2_000_000, upvotes:  50, label: "Large district (< 2M)"        },
  { maxPop: 10_000_000, upvotes: 100, label: "Small–mid state (< 10M)"      },
  { maxPop: 50_000_000, upvotes: 200, label: "Large state (< 50M)"          },
  { maxPop: Infinity,   upvotes: 500, label: "Federal / very large (50M+)"  },
];

/** Scope-level population fallbacks when jurisdiction_id is not set. */
const SCOPE_DEFAULT_POPULATION: Record<string, number> = {
  local:   75_000,
  state:   6_500_000,
  federal: 335_000_000,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type SignalStatus = "pass" | "fail" | "pending";

export type GateSignal = {
  key:         string;
  label:       string;
  description: string;
  status:      SignalStatus;
  value:       number | null;  // current value (e.g. hours elapsed, upvote count)
  required:    number;          // threshold
};

export type PopulationContext = {
  source:     "jurisdiction" | "scope_default";
  population: number | null;
  tier_label: string;
};

export type GateResult = {
  can_advance:         boolean;
  signals:             GateSignal[];
  checked_at:          string;        // ISO timestamp
  population_context?: PopulationContext;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getUpvoteTier(population: number): { upvotes: number; label: string } {
  for (const tier of POPULATION_TIERS) {
    if (population <= tier.maxPop) return { upvotes: tier.upvotes, label: tier.label };
  }
  // Fallback (shouldn't reach here — last tier is Infinity)
  return { upvotes: 500, label: "Federal / very large (50M+)" };
}

// ─── computeGate ─────────────────────────────────────────────────────────────

/**
 * Compute gate status for a given initiative.
 *
 * @param supabase          Server or admin client — both work for reads.
 * @param initiativeId      UUID of the initiative to check.
 * @param mobiliseStartedAt From initiative.mobilise_started_at (may be null).
 * @param context           Optional population context for normalised thresholds.
 *   - jurisdictionId: from initiative.jurisdiction_id (nullable)
 *   - scope:          from initiative.scope ("local" | "state" | "federal")
 */
export async function computeGate(
  supabase: SupabaseClient,
  initiativeId: string,
  mobiliseStartedAt: string | null,
  context?: { jurisdictionId?: string | null; scope?: string | null }
): Promise<GateResult> {
  const now = new Date();

  // ── Signal 1: time minimum ─────────────────────────────────────────────────

  const { data: proposal } = await supabase
    .from("proposals")
    .select("id,created_at,updated_at")
    .eq("id", initiativeId)
    .eq("type", "initiative")
    .maybeSingle();

  const deliberateStarted = new Date(proposal?.updated_at ?? proposal?.created_at ?? now);
  const hoursElapsed = (now.getTime() - deliberateStarted.getTime()) / (1000 * 60 * 60);
  const timePass = hoursElapsed >= GATE_CONFIG.TIME_MINIMUM_HOURS;

  const timeSignal: GateSignal = {
    key:         "time_minimum",
    label:       "Time in deliberation",
    description: `Minimum ${GATE_CONFIG.TIME_MINIMUM_HOURS}h of community deliberation required`,
    status:      timePass ? "pass" : "fail",
    value:       Math.floor(hoursElapsed),
    required:    GATE_CONFIG.TIME_MINIMUM_HOURS,
  };

  // ── Population lookup (for Signal 2) ──────────────────────────────────────

  let population: number | null = null;
  let popSource: "jurisdiction" | "scope_default" = "scope_default";

  if (context?.jurisdictionId) {
    const { data: jur } = await supabase
      .from("jurisdictions")
      .select("population")
      .eq("id", context.jurisdictionId)
      .single();

    if (jur?.population != null) {
      population = jur.population;
      popSource  = "jurisdiction";
    }
  }

  if (population === null && context?.scope) {
    population = (SCOPE_DEFAULT_POPULATION[context.scope] ?? SCOPE_DEFAULT_POPULATION.local) as number;
  }

  // Final fallback — no scope provided (shouldn't happen in practice)
  if (population === null) {
    population = (SCOPE_DEFAULT_POPULATION.local as number);
  }

  const { upvotes: upvoteRequired, label: tierLabel } = getUpvoteTier(population);

  const populationContext: PopulationContext = {
    source:     popSource,
    population: popSource === "jurisdiction" ? population : null,
    tier_label: tierLabel,
  };

  // ── Signal 2: upvote threshold ─────────────────────────────────────────────

  const { count: upvoteCount } = await supabase
    .from("civic_initiative_upvotes")
    .select("*", { count: "exact", head: true })
    .eq("initiative_id", initiativeId);

  const upvotesActual = upvoteCount ?? 0;
  const upvotePass    = upvotesActual >= upvoteRequired;

  const upvoteSignal: GateSignal = {
    key:         "upvote_threshold",
    label:       "Community support",
    description: `${upvoteRequired} upvotes required (${tierLabel})`,
    status:      upvotePass ? "pass" : "fail",
    value:       upvotesActual,
    required:    upvoteRequired,
  };

  // ── Signals 3 & 4: argument quality ───────────────────────────────────────

  // Read both `comment_type` (new schema) and `side` (legacy) so the gate keeps
  // working across the migration boundary. New rows have side=null and use
  // comment_type='support'/'oppose'; legacy rows may lack comment_type.
  const { data: args } = await supabase
    .from("civic_initiative_arguments")
    .select("id,side,comment_type,is_deleted")
    .eq("initiative_id", initiativeId)
    .is("parent_id", null)
    .eq("is_deleted", false);

  const argIds = (args ?? []).map((a) => a.id);

  let forBestVotes     = 0;
  let againstBestVotes = 0;

  if (argIds.length > 0) {
    // FIX-902: chunked. `argIds` is every top-level argument on the initiative
    // with no cap — user-generated, so it grows with participation, and this
    // gate decides whether an initiative ADVANCES. A 414 reads as zero votes on
    // every argument, i.e. a silently failed gate rather than an errored one.
    const { rows: voteRows, complete } = await fetchChunkedByIds<{ argument_id: string }>(
      argIds,
      (ids) =>
        supabase
          .from("civic_initiative_argument_votes")
          .select("argument_id")
          .in("argument_id", ids),
      { label: "initiatives:argument-votes" },
    );
    if (!complete) {
      console.error("[initiatives/gate] argument vote read incomplete — gate evaluated on partial counts");
    }

    const voteCounts: Record<string, number> = {};
    for (const v of voteRows) {
      voteCounts[v.argument_id] = (voteCounts[v.argument_id] ?? 0) + 1;
    }

    for (const arg of args ?? []) {
      const votes = voteCounts[arg.id] ?? 0;
      // Effective sentiment: prefer comment_type, fall back to side for legacy rows.
      const effective =
        arg.comment_type ??
        (arg.side === "for" ? "support" : arg.side === "against" ? "oppose" : null);
      if (effective === "support") forBestVotes     = Math.max(forBestVotes,     votes);
      if (effective === "oppose")  againstBestVotes = Math.max(againstBestVotes, votes);
    }
  }

  const forArgPass     = forBestVotes     >= GATE_CONFIG.MIN_ARG_VOTES;
  const againstArgPass = againstBestVotes >= GATE_CONFIG.MIN_ARG_VOTES;

  const forArgSignal: GateSignal = {
    key:         "for_argument",
    label:       "Supporting argument",
    description: `At least 1 'For' argument with ${GATE_CONFIG.MIN_ARG_VOTES}+ votes`,
    status:      forArgPass ? "pass" : "fail",
    value:       forBestVotes,
    required:    GATE_CONFIG.MIN_ARG_VOTES,
  };

  const againstArgSignal: GateSignal = {
    key:         "against_argument",
    label:       "Counter-argument tested",
    description: `At least 1 'Against' argument with ${GATE_CONFIG.MIN_ARG_VOTES}+ votes`,
    status:      againstArgPass ? "pass" : "fail",
    value:       againstBestVotes,
    required:    GATE_CONFIG.MIN_ARG_VOTES,
  };

  const allPass = timePass && upvotePass && forArgPass && againstArgPass;

  return {
    can_advance:         allPass,
    signals:             [timeSignal, upvoteSignal, forArgSignal, againstArgSignal],
    checked_at:          now.toISOString(),
    population_context:  populationContext,
  };
}
