// FIX-I: /institutions index. Filterable list of all institutions (the
// public.institutions view = governing_bodies ∪ agencies). Driven by URL search
// params (?type, ?jurisdiction, ?q, ?page) so every view is ISR-cacheable. No
// client state — pills are Links, text search is a GET form. Publishable client.
//
// ~480 rows today, so a single filtered page is comfortable, but the list is
// still paginated defensively via .range() (PostgREST 1k cap).
import Link from "next/link";
import { createPublicClient } from "@civitics/db";
import { InstitutionCard, type InstitutionCardData } from "../components/cards/InstitutionCard";

export const revalidate = 300;

const PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SearchParams = { [key: string]: string | string[] | undefined };

// Type vocabulary harmonized across both source tables (governing_bodies +
// agencies). Values confirmed against the live institutions view.
const TYPE_PILLS: Array<{ label: string; value: string }> = [
  { label: "All", value: "all" },
  { label: "Upper chambers", value: "legislature_upper" },
  { label: "Lower chambers", value: "legislature_lower" },
  { label: "Executive", value: "executive" },
  { label: "Judicial", value: "judicial" },
  { label: "Federal agencies", value: "federal" },
  { label: "Municipal", value: "municipal_council" },
  { label: "Other", value: "other" },
];

const TYPE_LABEL: Record<string, string> = {
  legislature_upper: "upper chambers",
  legislature_lower: "lower chambers",
  legislature_unicameral: "legislatures",
  executive: "executive bodies",
  judicial: "courts",
  federal: "federal agencies",
  municipal_council: "municipal councils",
  other: "institutions",
};

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function buildHref(params: { type?: string; jurisdiction?: string; q?: string; status?: string; page?: number }): string {
  const sp = new URLSearchParams();
  if (params.type && params.type !== "all") sp.set("type", params.type);
  if (params.jurisdiction) sp.set("jurisdiction", params.jurisdiction);
  if (params.q) sp.set("q", params.q);
  if (params.status && params.status !== "active") sp.set("status", params.status);
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const qs = sp.toString();
  return qs ? `/institutions?${qs}` : "/institutions";
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const type = firstParam(sp.type) ?? "all";
  const q = firstParam(sp.q)?.trim() ?? "";
  const label = type !== "all" ? TYPE_LABEL[type] ?? type : "Institutions";
  let title = type !== "all" ? label.charAt(0).toUpperCase() + label.slice(1) : "Institutions";
  if (q) title = `${q} — ${title.toLowerCase()}`;
  return { title: `${title} · Civitics` };
}

export default async function InstitutionsIndexPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const type = firstParam(sp.type) ?? "all";
  const jurisdiction = firstParam(sp.jurisdiction)?.trim() ?? "";
  const q = firstParam(sp.q)?.trim() ?? "";
  const page = Math.max(1, parseInt(firstParam(sp.page) ?? "1", 10) || 1);
  // FIX-457: default to active only; ?status=all opts into former/inactive rows
  // (the institutions view now surfaces them after the FIX-456 gate relax).
  const status = firstParam(sp.status) ?? "active";
  const includeFormer = status === "all";

  const supabase = createPublicClient();

  // Resolve the active jurisdiction name for the filter chip (drill-downs link
  // here with ?jurisdiction=<uuid>).
  let jurisdictionName: string | null = null;
  if (jurisdiction && UUID_RE.test(jurisdiction)) {
    const { data } = await supabase
      .from("jurisdictions")
      .select("name")
      .eq("id", jurisdiction)
      .maybeSingle();
    jurisdictionName = (data as { name: string } | null)?.name ?? null;
  }

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("institutions")
    .select("id, name, short_name, type, acronym, source_table, is_active, is_synthetic", { count: "exact" });

  if (!includeFormer) query = query.eq("is_active", true);
  if (type !== "all") query = query.eq("type", type);
  if (jurisdiction && UUID_RE.test(jurisdiction)) query = query.eq("jurisdiction_id", jurisdiction);
  // Sanitize before interpolating into .or() — commas/parens are PostgREST
  // filter syntax and would let user input break out of the ilike clause.
  const safeQ = q.replace(/[,()\\*]/g, " ").trim();
  if (safeQ) query = query.or(`name.ilike.%${safeQ}%,short_name.ilike.%${safeQ}%`);

  const { data, count } = await query
    .order("type", { ascending: true })
    .order("name", { ascending: true })
    .range(from, to);

  const institutions = (data ?? []) as InstitutionCardData[];
  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-gray-50">
      <main id="main-content" className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-gray-900">Institutions</h1>
          <p className="mt-1 text-sm text-gray-500">
            Legislatures, executive bodies, courts, and agencies.
          </p>
        </header>

        {/* Active jurisdiction filter chip */}
        {jurisdiction && (
          <div className="mb-4 flex items-center gap-2 text-sm">
            <span className="text-gray-500">In</span>
            <span className="rounded-full bg-indigo-50 px-3 py-1 font-medium text-indigo-700">
              {jurisdictionName ?? "selected jurisdiction"}
            </span>
            <Link href={buildHref({ type, q, status })} className="text-xs text-gray-400 hover:text-gray-700">
              clear ✕
            </Link>
          </div>
        )}

        {/* Filters */}
        <div className="mb-6 space-y-3">
          <div className="flex flex-wrap gap-2">
            {TYPE_PILLS.map((pill) => {
              const active = type === pill.value;
              return (
                <Link
                  key={pill.value}
                  href={buildHref({ type: pill.value, jurisdiction, q, status })}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    active
                      ? "bg-indigo-600 text-white"
                      : "border border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900"
                  }`}
                >
                  {pill.label}
                </Link>
              );
            })}
          </div>

          {/* Active / former toggle (FIX-457) */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-gray-400">Status</span>
            {[
              { label: "Active", value: "active" },
              { label: "Include former", value: "all" },
            ].map((opt) => {
              const on = status === opt.value;
              return (
                <Link
                  key={opt.value}
                  href={buildHref({ type, jurisdiction, q, status: opt.value })}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    on
                      ? "bg-gray-900 text-white"
                      : "border border-gray-200 bg-white text-gray-600 hover:border-gray-300 hover:text-gray-900"
                  }`}
                >
                  {opt.label}
                </Link>
              );
            })}
          </div>

          <form method="GET" action="/institutions" className="flex gap-2">
            {type !== "all" && <input type="hidden" name="type" value={type} />}
            {jurisdiction && <input type="hidden" name="jurisdiction" value={jurisdiction} />}
            {includeFormer && <input type="hidden" name="status" value="all" />}
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="Search by name…"
              className="w-full max-w-sm rounded-md border border-gray-200 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              type="submit"
              className="rounded-md bg-gray-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-gray-700"
            >
              Search
            </button>
          </form>
        </div>

        <p className="mb-3 text-xs text-gray-400">
          {total.toLocaleString("en-US")} {total === 1 ? "result" : "results"}
          {q && <> for &ldquo;{q}&rdquo;</>}
        </p>

        {institutions.length === 0 ? (
          <div className="rounded-lg border border-dashed border-gray-200 bg-white p-8 text-center text-sm text-gray-500">
            No institutions match this filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {institutions.map((inst) => (
              <InstitutionCard key={inst.id} institution={inst} />
            ))}
          </div>
        )}

        {totalPages > 1 && (
          <nav className="mt-8 flex items-center justify-between" aria-label="Pagination">
            {page > 1 ? (
              <Link
                href={buildHref({ type, jurisdiction, q, status, page: page - 1 })}
                className="rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-gray-400">
              Page {page} of {totalPages.toLocaleString("en-US")}
            </span>
            {page < totalPages ? (
              <Link
                href={buildHref({ type, jurisdiction, q, status, page: page + 1 })}
                className="rounded-md border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Next →
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </main>
    </div>
  );
}
