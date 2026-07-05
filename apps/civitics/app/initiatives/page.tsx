export const dynamic = "force-dynamic";

import Link from "next/link";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";
import { PageViewTracker } from "../components/PageViewTracker";
import { InitiativeCard, type InitiativeCardData } from "./components/InitiativeCard";

// ─── Types ────────────────────────────────────────────────────────────────────

type InitiativeRow = InitiativeCardData;

// ─── Constants ────────────────────────────────────────────────────────────────

const STAGE_TABS = [
  { value: "",           label: "All" },
  { value: "problem",    label: "Problems" },
  { value: "deliberate", label: "Deliberating" },
  { value: "mobilise",   label: "Mobilising" },
  { value: "resolved",   label: "Resolved" },
];

const ISSUE_TAG_OPTIONS = [
  "climate", "healthcare", "education", "housing", "immigration", "finance",
  "energy", "agriculture", "transportation", "labor", "civil_rights",
  "foreign_policy", "criminal_justice", "technology", "consumer_protection",
];

const SORT_OPTIONS = [
  { value: "",         label: "Newest" },
  { value: "active",   label: "Most active" },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function InitiativesPage({
  searchParams,
}: {
  searchParams: { stage?: string; scope?: string; tag?: string; sort?: string; page?: string; mine?: string };
}) {
  const params = searchParams;
  const stage = params.stage ?? "";
  const scope = params.scope ?? "";
  const tag   = params.tag   ?? "";
  const sort  = params.sort  ?? "";
  const mine  = params.mine  === "1";
  const page  = Math.max(1, parseInt(params.page ?? "1") || 1);
  const PAGE_SIZE = 20;

  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  // Auth — needed for "Mine" tab
  const { data: { user } } = await supabase.auth.getUser();
  const isMine = mine && !!user;

  // Build query — join initiative_details with parent proposals for title/summary/created_at
  // db-timeout-exempt: builder assigned to `query`; the awaited terminal (.range) IS wrapped
  // in withDbTimeout below — the guard's lexical enclosure check can't span the assignment.
  let query = supabase
    // db-timeout-exempt: see above — terminal .range() is wrapped in withDbTimeout.
    .from("initiative_details")
    .select(
      // initiative_details has TWO FKs to proposals; name the FK or PostgREST
      // PGRST201s and supabase-js swallows it to null (FIX-616 twin).
      "proposal_id,stage,scope,authorship_type,issue_area_tags,target_district,mobilise_started_at,primary_author_id,proposals!initiative_details_proposal_id_fkey!inner(id,title,summary_plain,created_at,updated_at,resolved_at,type)",
      { count: "exact" }
    )
    .eq("proposals.type", "initiative");

  if (isMine) {
    // "My initiatives" view: author's own rows (includes drafts — RLS allows it)
    query = query.eq("primary_author_id", user!.id);
    // Still allow stage filtering within own initiatives
    if (stage) query = query.eq("stage", stage as "problem" | "draft" | "deliberate" | "mobilise" | "resolved");
  } else {
    // Public view: never show drafts
    query = query.neq("stage", "draft");
    if (stage) query = query.eq("stage", stage as "problem" | "draft" | "deliberate" | "mobilise" | "resolved");
  }

  if (scope) query = query.eq("scope", scope as "local" | "federal" | "state");
  if (tag)   query = query.contains("issue_area_tags", [tag]);

  // Sort
  if (sort === "active") {
    query = query
      .order("mobilise_started_at", { ascending: false, nullsFirst: false });
  }

  const { data, count } = await withDbTimeout(
    query.range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1),
    3000,
    "initiatives:list"
  );

  // Flatten to legacy civic_initiatives shape
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initiatives: InitiativeRow[] = ((data ?? []) as any[]).map((row) => {
    const p = Array.isArray(row.proposals) ? row.proposals[0] : row.proposals;
    return {
      id:                  row.proposal_id,
      title:               p?.title,
      summary:             p?.summary_plain,
      stage:               row.stage,
      scope:               row.scope,
      authorship_type:     row.authorship_type,
      issue_area_tags:     row.issue_area_tags ?? [],
      target_district:     row.target_district,
      mobilise_started_at: row.mobilise_started_at,
      created_at:          p?.created_at,
      resolved_at:         p?.resolved_at,
    };
  });
  const total = count ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  function buildUrl(updates: Record<string, string>) {
    const p = new URLSearchParams();
    const merged = { stage, scope, tag, sort, page: String(page), mine: isMine ? "1" : "", ...updates };
    if (merged.stage) p.set("stage", merged.stage);
    if (merged.scope) p.set("scope", merged.scope);
    if (merged.tag)   p.set("tag", merged.tag);
    if (merged.sort)  p.set("sort", merged.sort);
    if (merged.mine === "1") p.set("mine", "1");
    if (merged.page && merged.page !== "1") p.set("page", merged.page);
    const qs = p.toString();
    return `/initiatives${qs ? `?${qs}` : ""}`;
  }

  return (
    <div className="min-h-screen bg-paper-2">
      <PageViewTracker />

      <main id="main-content" className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
        {/* ── Page header ──────────────────────────────────────────────── */}
        <div className="mb-8 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-ink">Civic Initiatives</h1>
            <p className="mt-1 text-sm text-ink-soft/70">
              Citizen-led proposals — from deliberation to official accountability.
            </p>
          </div>
          <div className="flex flex-shrink-0 items-center gap-2">
            <Link
              href="/initiatives/problem"
              className="rounded-lg border border-amber/60 bg-amber/20 px-4 py-2 text-sm font-semibold text-ink shadow-sm hover:bg-amber/25 focus:outline-none focus:ring-2 focus:ring-amber/60"
            >
              Post a problem
            </Link>
            <Link
              href="/initiatives/new"
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-accent focus:outline-none focus:ring-2 focus:ring-accent"
            >
              + New initiative
            </Link>
          </div>
        </div>

        {/* ── Stage / view tabs ────────────────────────────────────────── */}
        <div className="mb-6 flex gap-1 overflow-x-auto rounded-lg border border-rule bg-card p-1">
          {STAGE_TABS.map((tab) => (
            <Link
              key={tab.value}
              href={buildUrl({ stage: tab.value, mine: "", page: "1" })}
              className={`flex-shrink-0 rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                !isMine && stage === tab.value
                  ? "bg-accent text-white shadow-sm"
                  : "text-ink-soft hover:bg-paper-2 hover:text-ink"
              }`}
            >
              {tab.label}
            </Link>
          ))}
          {/* "Mine" tab — only shown when signed in */}
          {user && (
            <Link
              href={`/initiatives?mine=1`}
              className={`ml-auto flex-shrink-0 rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                isMine
                  ? "bg-accent text-white shadow-sm"
                  : "text-ink-soft hover:bg-paper-2 hover:text-ink"
              }`}
            >
              My initiatives
            </Link>
          )}
        </div>

        {/* ── Scope filter ─────────────────────────────────────────────── */}
        <div className="mb-6 flex flex-wrap gap-2">
          {[
            { value: "", label: "All scopes" },
            { value: "federal", label: "Federal" },
            { value: "state",   label: "State" },
            { value: "local",   label: "Local" },
          ].map((opt) => (
            <Link
              key={opt.value}
              href={buildUrl({ scope: opt.value, page: "1" })}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                scope === opt.value
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-rule bg-card text-ink-soft hover:border-rule hover:text-ink"
              }`}
            >
              {opt.label}
            </Link>
          ))}
        </div>

        {/* ── Sort row ─────────────────────────────────────────────────── */}
        <div className="mb-4 flex items-center gap-3">
          <span className="text-xs font-medium text-ink-soft/70">Sort by</span>
          <div className="flex gap-1">
            {SORT_OPTIONS.map((opt) => (
              <Link
                key={opt.value}
                href={buildUrl({ sort: opt.value, page: "1" })}
                className={`rounded-lg border px-3 py-1 text-xs font-medium transition-colors ${
                  sort === opt.value
                    ? "border-accent bg-accent/10 text-accent"
                    : "border-rule bg-card text-ink-soft hover:border-rule hover:text-ink"
                }`}
              >
                {opt.label}
              </Link>
            ))}
          </div>
        </div>

        {/* ── Topic filter pills ───────────────────────────────────────── */}
        <div className="mb-6 flex flex-wrap gap-1.5">
          <Link
            href={buildUrl({ tag: "", page: "1" })}
            className={`rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors ${
              !tag
                ? "border-accent bg-accent/10 text-accent"
                : "border-rule bg-card text-ink-soft/70 hover:border-rule hover:text-ink"
            }`}
          >
            All topics
          </Link>
          {ISSUE_TAG_OPTIONS.map((t) => (
            <Link
              key={t}
              href={buildUrl({ tag: t, page: "1" })}
              className={`rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize transition-colors ${
                tag === t
                  ? "border-accent bg-accent/10 text-accent"
                  : "border-rule bg-card text-ink-soft/70 hover:border-accent hover:bg-accent/10 hover:text-accent"
              }`}
            >
              {t.replace(/_/g, " ")}
            </Link>
          ))}
        </div>

        {/* ── Results header ───────────────────────────────────────────── */}
        <div className="mb-4 flex items-center justify-between text-sm text-ink-soft/70">
          <span>
            {total === 0
              ? "No initiatives found"
              : `${total.toLocaleString()} initiative${total === 1 ? "" : "s"}`}
          </span>
        </div>

        {/* ── Initiative cards ─────────────────────────────────────────── */}
        {initiatives.length === 0 ? (
          <div className="rounded-xl border border-dashed border-rule bg-card px-8 py-16 text-center">
            <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-accent/10">
              <svg className="h-6 w-6 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                  d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <p className="text-sm font-medium text-ink">
              {isMine ? "You haven't started any initiatives yet" : "No initiatives yet"}
            </p>
            <p className="mt-1 text-sm text-ink-soft/70">
              {isMine ? "Draft your first initiative and open it for community deliberation." : "Be the first — start a civic initiative."}
            </p>
            <Link
              href="/initiatives/new"
              className="mt-4 inline-block rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent"
            >
              Start an initiative
            </Link>
          </div>
        ) : (
          <div className="space-y-4">
            {initiatives.map((initiative) => (
              <InitiativeCard key={initiative.id} initiative={initiative} />
            ))}
          </div>
        )}

        {/* ── Pagination ───────────────────────────────────────────────── */}
        {totalPages > 1 && (
          <div className="mt-8 flex items-center justify-center gap-2">
            {page > 1 && (
              <Link
                href={buildUrl({ page: String(page - 1) })}
                className="rounded-lg border border-rule bg-card px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper-2"
              >
                ← Previous
              </Link>
            )}
            <span className="text-sm text-ink-soft/70">Page {page} of {totalPages}</span>
            {page < totalPages && (
              <Link
                href={buildUrl({ page: String(page + 1) })}
                className="rounded-lg border border-rule bg-card px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper-2"
              >
                Next →
              </Link>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
