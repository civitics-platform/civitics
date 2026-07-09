/**
 * FIX-767 — the zero-query /search browse landing (Screen 1). Server-rendered,
 * terminal-scoped, fed by the cached getLandingData rollup + strips. Any q /
 * scope / facet / root routes to the W1 ExplorerPage instead (see page.tsx).
 *
 * The search box is a plain GET form → /search, so it navigates without JS
 * (the ⌘K palette is the JS-enhanced path). Tiles + START FROM pills are
 * <Link>s into explorer scope states / discovery roots.
 */

import Link from "next/link";
import { DISCOVERY_ROOTS, discoveryHref } from "@/lib/browse/discovery";
import type { LandingData, LandingStripRow } from "./landing-data";

interface TileSubLink {
  label: string;
  href: string;
  /** "kind:facet_key:facet_value" into LandingData.subCounts for the badge. */
  countKey?: string;
}
interface Tile {
  kind: string;
  label: string;
  href: string;
  viz: number;
  sub: TileSubLink[];
}

// Tile scope links reuse By-Branch tree paths + kind-direct scopes; sub-link
// count badges key into the rollup sub-counts fetched by landing-data.
const TILES: Tile[] = [
  { kind: "official", label: "OFFICIALS", href: "/search?scope=people", viz: 1, sub: [
    { label: "Senate", href: "/search?scope=people/officials/federal/congress/senate", countKey: "official:chamber:senate" },
    { label: "House", href: "/search?scope=people/officials/federal/congress/house", countKey: "official:chamber:house" },
    { label: "By state ›", href: "/search?scope=people/officials/state" },
  ] },
  { kind: "proposal", label: "PROPOSALS", href: "/search?scope=legislation", viz: 2, sub: [
    { label: "Open comment", href: "/search?scope=legislation/proposals/open-comment", countKey: "proposal:status:open_comment" },
    { label: "Bills", href: "/search?scope=legislation/proposals/bills", countKey: "proposal:proposal_type:bill" },
    { label: "Regulations", href: "/search?scope=legislation/proposals/regulations", countKey: "proposal:proposal_type:regulation" },
  ] },
  { kind: "financial", label: "MONEY", href: "/search?scope=money", viz: 3, sub: [
    { label: "Super PACs", href: "/search?scope=money/super-pacs", countKey: "financial:financial_type:super_pac" },
    { label: "PACs", href: "/search?scope=money/pacs", countKey: "financial:financial_type:pac" },
    { label: "Corporations", href: "/search?scope=money/corporations", countKey: "financial:financial_type:corporation" },
  ] },
  { kind: "agency", label: "AGENCIES", href: "/search?scope=government", viz: 4, sub: [
    { label: "Federal", href: "/search?scope=government/agencies/federal", countKey: "agency:agency_type:federal" },
    { label: "Independent", href: "/search?scope=government/agencies/independent", countKey: "agency:agency_type:independent" },
  ] },
  { kind: "jurisdiction", label: "JURISDICTIONS", href: "/search?scope=jurisdictions", viz: 5, sub: [
    { label: "By place ›", href: "/search?root=place" },
  ] },
  { kind: "institution", label: "INSTITUTIONS", href: "/search?scope=institutions", viz: 6, sub: [
    { label: "Browse ›", href: "/search?scope=institutions" },
  ] },
  { kind: "initiative", label: "INITIATIVES", href: "/search?scope=initiatives", viz: 7, sub: [
    { label: "Active", href: "/search?scope=initiatives/active" },
    { label: "Resolved", href: "/search?scope=initiatives/resolved", countKey: "initiative:initiative_stage:resolved" },
  ] },
  { kind: "meeting", label: "MEETINGS", href: "/search?scope=meetings", viz: 8, sub: [
    { label: "Recent ›", href: "/search?scope=meetings&sort=recent" },
  ] },
];

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return n.toLocaleString("en-US");
}

function refreshedLabel(iso: string | null): string {
  if (!iso) return "index warming";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "index warming";
  return `refreshed ${new Date(t).toISOString().slice(11, 16)} UTC`;
}

function Strip({ title, rows, empty }: { title: string; rows: LandingStripRow[]; empty: string }) {
  return (
    <div className="rounded-[6px] border border-rule bg-card">
      <h3 className="flex items-center gap-1.5 border-b border-rule px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.12em] text-ink-soft/70">
        <span className="text-amber">•</span> {title}
      </h3>
      {rows.length === 0 ? (
        <p className="px-3 py-3 font-mono text-[11px] text-ink-soft/50">{empty}</p>
      ) : (
        rows.map((r) => (
          <Link
            key={r.key}
            href={r.href}
            className="flex items-center gap-2.5 border-b border-rule/60 px-3 py-[7px] font-mono text-[12px] transition-colors last:border-b-0 hover:bg-ink/5"
          >
            <span className="min-w-0 flex-1 truncate text-ink">{r.label}</span>
            <span className={`shrink-0 whitespace-nowrap text-[11px] tabular-nums ${r.urgent ? "text-amber" : "text-ink-soft/70"}`}>
              {r.meta}
            </span>
          </Link>
        ))
      )}
    </div>
  );
}

export function BrowseLanding({ data }: { data: LandingData }) {
  return (
    <div data-theme="terminal" className="min-h-screen bg-paper text-ink">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-5">
        {/* LIVE INDEX kicker (honesty stamp) */}
        <p className="pb-3 font-mono text-[11px] tracking-[0.02em] text-ink-soft/70">
          <span className="text-amber">●</span>{" "}
          <span className="uppercase tracking-[0.12em] text-ink-soft">Search &amp; Browse — Live index</span>
          {" · "}entity_search_index{" · "}
          {refreshedLabel(data.refreshedAt)}
          {" · "}
          {compact(data.totalCount)} records
        </p>

        {/* Big search input — plain GET form, no JS required */}
        <form action="/search" method="get" role="search" className="pb-3">
          <div className="flex items-center gap-2 rounded-[6px] border border-term-line bg-card px-3 py-2.5 focus-within:border-accent">
            <span className="font-mono text-[13px] text-ink-soft/70">&gt;</span>
            <input
              type="text"
              name="q"
              autoComplete="off"
              placeholder="search the public record…"
              aria-label="Search the public record"
              className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-ink placeholder:text-ink-soft/50 focus:outline-none"
            />
            <span className="shrink-0 rounded-[2px] border border-term-line px-1.5 py-0.5 font-mono text-[10px] text-ink-soft/60">⌘K</span>
          </div>
        </form>

        {/* START FROM discovery paths */}
        <div className="flex flex-wrap items-center gap-2 pb-4">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink-soft/50">Start from</span>
          {DISCOVERY_ROOTS.map((root, i) => (
            <Link
              key={root.key}
              href={discoveryHref(root)}
              title={root.hint}
              className={`rounded-[2px] border px-2 py-1 font-mono text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent
                ${i === 0
                  ? "border-amber/55 bg-amber/10 text-amber"
                  : "border-term-line text-ink-soft hover:border-ink-soft/60 hover:text-ink"}`}
            >
              {root.short}
            </Link>
          ))}
          <Link
            href="/search?root=branch"
            title="Your saved views (sign in to persist)"
            className="rounded-[2px] border border-term-line px-2 py-1 font-mono text-[11px] text-viz-3 transition-colors hover:border-viz-3/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            ★ SAVED VIEWS
          </Link>
        </div>

        {/* Category tiles */}
        <div className="grid grid-cols-2 gap-3 pb-5 sm:grid-cols-3 lg:grid-cols-4">
          {TILES.map((tile) => {
            const count = data.kindCounts[tile.kind] ?? 0;
            return (
              <div key={tile.kind} className="rounded-[6px] border border-rule bg-card p-3">
                <Link href={tile.href} className="group block focus-visible:outline-none">
                  <h2 className="font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-soft/70">{tile.label}</h2>
                  <p className="pt-0.5 font-mono text-[26px] font-semibold leading-none tabular-nums text-ink group-hover:text-amber">
                    {compact(count)}
                  </p>
                </Link>
                <div
                  className="my-2.5 h-[3px] w-full rounded-[1px]"
                  style={{ backgroundColor: `rgb(var(--c-viz-${tile.viz}))` }}
                  aria-hidden
                />
                <div className="flex flex-wrap gap-1.5">
                  {tile.sub.map((s) => {
                    const c = s.countKey ? data.subCounts[s.countKey] : undefined;
                    return (
                      <Link
                        key={s.label}
                        href={s.href}
                        className="rounded-[2px] border border-term-line px-1.5 py-[2px] font-mono text-[10.5px] text-ink-soft transition-colors hover:border-ink-soft/60 hover:text-ink focus-visible:outline-none focus-visible:text-accent"
                      >
                        {s.label}
                        {c != null && <span className="ml-1 tabular-nums text-ink-soft/60">{compact(c)}</span>}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Three strips */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <Strip title="Comment periods closing" rows={data.closing} empty="No open comment windows right now." />
          <Strip title="Recently active" rows={data.recent} empty="Index warming — check back shortly." />
          <Strip title="Most connected" rows={data.connected} empty="Index warming — check back shortly." />
        </div>
      </div>
    </div>
  );
}
