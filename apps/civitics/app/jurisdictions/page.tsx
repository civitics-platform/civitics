// FIX-I: /jurisdictions index. Filterable list of all jurisdictions, driven
// entirely by URL search params (?type, ?q, ?page) so every distinct view is
// ISR-cacheable. No client state — filter pills are Links, the text search is a
// GET form. Read with the publishable client (no cookies → stays static).
//
// Row counts are large (≈10.5k total; ~3.3k under the default civic-set filter),
// so the list query is ALWAYS paginated via .range() — never an unbounded select
// (PostgREST caps at 1000 rows regardless).
import Link from "next/link";
import { createPublicClient } from "@civitics/db";
import { JurisdictionCard, type JurisdictionCardData } from "../components/cards/JurisdictionCard";
import { withDbTimeout } from "@/lib/supabase-check";

export const revalidate = 300;

const PAGE_SIZE = 50;

// Default view skips `district` (7k+ rows of precinct/ward noise for the
// civic-engagement audience) — they're only shown when explicitly filtered.
const DEFAULT_TYPE = "state,federal_district,unincorporated_territory,county,city";

type SearchParams = { [key: string]: string | string[] | undefined };

const TYPE_PILLS: Array<{ label: string; value: string }> = [
  { label: "Civic set", value: DEFAULT_TYPE },
  { label: "States", value: "state" },
  { label: "Counties", value: "county" },
  { label: "Cities", value: "city" },
  { label: "Districts", value: "district" },
  { label: "Territories", value: "unincorporated_territory,federal_district" },
  { label: "All", value: "all" },
];

const TYPE_LABEL_SINGULAR: Record<string, string> = {
  state: "states",
  county: "counties",
  city: "cities",
  district: "districts",
  federal_district: "federal districts",
  unincorporated_territory: "territories",
};

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function buildHref(params: { type?: string; q?: string; page?: number }): string {
  const sp = new URLSearchParams();
  if (params.type && params.type !== DEFAULT_TYPE) sp.set("type", params.type);
  if (params.q) sp.set("q", params.q);
  if (params.page && params.page > 1) sp.set("page", String(params.page));
  const qs = sp.toString();
  return qs ? `/jurisdictions?${qs}` : "/jurisdictions";
}

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const type = firstParam(sp.type) ?? DEFAULT_TYPE;
  const q = firstParam(sp.q)?.trim() ?? "";
  const single = type.includes(",") || type === "all" ? null : TYPE_LABEL_SINGULAR[type] ?? type;
  let title = "Jurisdictions";
  if (single && q) title = `${q} ${single}`;
  else if (single) title = single.charAt(0).toUpperCase() + single.slice(1);
  else if (q) title = `Jurisdictions matching "${q}"`;
  return { title: `${title} · Civitics` };
}

async function loadParentNames(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  parentIds: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (parentIds.length === 0) return map;
  // .in() bounded: both callers derive parentIds from a capped row set — the
  // featured strip at `.limit(20)` and the main list at PAGE_SIZE (50) — and
  // dedupe first, so max 50 — FIX-902
  const { data } = await withDbTimeout(
    supabase.from("jurisdictions").select("id, name").in("id", parentIds) as PromiseLike<{
      data: { id: string; name: string }[] | null;
    }>,
    3000,
    "jurisdictions:parent-names",
  );
  for (const r of (data ?? []) as Array<{ id: string; name: string }>) {
    map.set(r.id, r.name);
  }
  return map;
}

export default async function JurisdictionsIndexPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const sp = await searchParams;
  const type = firstParam(sp.type) ?? DEFAULT_TYPE;
  const q = firstParam(sp.q)?.trim() ?? "";
  const page = Math.max(1, parseInt(firstParam(sp.page) ?? "1", 10) || 1);

  // The generated jurisdiction_type enum is stale (missing federal_district /
  // unincorporated_territory — live DB ≠ types). Use an any-typed handle for the
  // type-column queries, matching the /jurisdictions/[id] page's approach.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createPublicClient();

  // ── Featured: high-traffic shortcuts. Resolved by query (not hardcoded UUIDs,
  //    which differ between local and prod). Country + federal district + the
  //    pilot-metro cities. Only rendered on the unfiltered landing.
  const showFeatured = type === DEFAULT_TYPE && q === "" && page === 1;
  let featured: JurisdictionCardData[] = [];
  if (showFeatured) {
    const { data } = await withDbTimeout(
      supabase
        .from("jurisdictions")
        .select("id, name, short_name, type, population, parent_id, is_synthetic")
        .in("type", ["country", "federal_district", "city"])
        .eq("is_active", true)
        .order("type", { ascending: true })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .limit(20) as PromiseLike<{ data: any[] | null }>,
      3000,
      "jurisdictions:featured",
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows = (data ?? []) as any[];
    const parentMap = await loadParentNames(
      supabase,
      Array.from(new Set(rows.map((r) => r.parent_id).filter(Boolean)))
    );
    featured = rows.map((r) => ({
      id: r.id,
      name: r.name,
      short_name: r.short_name,
      type: r.type,
      population: r.population,
      parentName: r.parent_id ? parentMap.get(r.parent_id) ?? null : null,
      is_synthetic: r.is_synthetic ?? false,
    }));
  }

  // ── Main list ────────────────────────────────────────────────────────────
  const types = type === "all" ? null : type.split(",");
  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    // db-timeout-exempt: builder assigned here, wrapped in withDbTimeout(query, …) at the .range() await below — split across a variable assignment the guard's lexical enclosure check can't see.
    .from("jurisdictions")
    .select("id, name, short_name, type, population, parent_id, is_synthetic", { count: "exact" })
    .eq("is_active", true);

  // .in() bounded: a comma-split of the `type` URL param over the jurisdiction
  // type vocabulary (~8 values), not an id list — FIX-902
  if (types) query = query.in("type", types);
  // Sanitize before interpolating into .or() — commas/parens are PostgREST
  // filter syntax and would let user input break out of the ilike clause.
  const safeQ = q.replace(/[,()\\*]/g, " ").trim();
  if (safeQ) query = query.or(`name.ilike.%${safeQ}%,short_name.ilike.%${safeQ}%`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, count } = await withDbTimeout<{ data: any[] | null; count: number | null }>(
    query
      .order("population", { ascending: false, nullsFirst: false })
      .order("name", { ascending: true })
      .range(from, to),
    3000,
    "jurisdictions:list",
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (data ?? []) as any[];
  const parentMap = await loadParentNames(
    supabase,
    Array.from(new Set(rows.map((r) => r.parent_id).filter(Boolean)))
  );
  const jurisdictions: JurisdictionCardData[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    short_name: r.short_name,
    type: r.type,
    population: r.population,
    parentName: r.parent_id ? parentMap.get(r.parent_id) ?? null : null,
  }));

  const total = count ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-screen bg-paper-2">
      <main id="main-content" className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-ink">Jurisdictions</h1>
          <p className="mt-1 text-sm text-ink-soft/70">
            States, counties, cities, and districts across the United States.
          </p>
        </header>

        {/* Featured shortcuts */}
        {featured.length > 0 && (
          <section className="mb-8">
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
              Featured
            </h2>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {featured.map((j) => (
                <JurisdictionCard key={j.id} jurisdiction={j} />
              ))}
            </div>
          </section>
        )}

        {/* Filters */}
        <div className="mb-6 space-y-3">
          <div className="flex flex-wrap gap-2">
            {TYPE_PILLS.map((pill) => {
              const active = type === pill.value || (pill.value === "all" && type === "all");
              return (
                <Link
                  key={pill.label}
                  href={buildHref({ type: pill.value, q })}
                  className={`rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                    active
                      ? "bg-accent text-white"
                      : "border border-rule bg-card text-ink-soft hover:border-rule hover:text-ink"
                  }`}
                >
                  {pill.label}
                </Link>
              );
            })}
          </div>

          <form method="GET" action="/jurisdictions" className="flex gap-2">
            {type !== DEFAULT_TYPE && <input type="hidden" name="type" value={type} />}
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="Search by name…"
              className="w-full max-w-sm rounded-md border border-rule px-3 py-1.5 text-sm focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="submit"
              className="rounded-md bg-ink px-4 py-1.5 text-sm font-medium text-white hover:bg-ink"
            >
              Search
            </button>
          </form>
        </div>

        {/* Result count */}
        <p className="mb-3 text-xs text-ink-soft/70">
          {total.toLocaleString("en-US")} {total === 1 ? "result" : "results"}
          {q && <> for &ldquo;{q}&rdquo;</>}
        </p>

        {/* Card list */}
        {jurisdictions.length === 0 ? (
          <div className="border border-dashed border-rule bg-card p-8 text-center text-sm text-ink-soft/70">
            No jurisdictions match this filter.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {jurisdictions.map((j) => (
              <JurisdictionCard key={j.id} jurisdiction={j} />
            ))}
          </div>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <nav className="mt-8 flex items-center justify-between" aria-label="Pagination">
            {page > 1 ? (
              <Link
                href={buildHref({ type, q, page: page - 1 })}
                className="rounded-md border border-rule bg-card px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper-2"
              >
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            <span className="text-xs text-ink-soft/70">
              Page {page} of {totalPages.toLocaleString("en-US")}
            </span>
            {page < totalPages ? (
              <Link
                href={buildHref({ type, q, page: page + 1 })}
                className="rounded-md border border-rule bg-card px-4 py-2 text-sm font-medium text-ink-soft hover:bg-paper-2"
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
