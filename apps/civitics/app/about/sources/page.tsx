/**
 * FIX-400 / FIX-252 — public disclosure page listing every data source with
 * license + citation terms.
 *
 * Static server component. Reads from SOURCE_REGISTRY in @civitics/db so the
 * popover ("About our sources →") and this page agree on names + license
 * strings. The verbatim CC-BY-SA 4.0 LittleSis attribution required by
 * FIX-252 is shipped here from the LITTLESIS_ATTRIBUTION_TEXT constant in
 * source-registry.ts — keep the canonical text in that single constant so
 * legal can revise it in one place.
 *
 * Licenses are asserted ONLY where confirmed (LittleSis CC-BY-SA 4.0, federal
 * works public domain under 17 U.S.C. § 105). openstates / govtrack /
 * opensecrets link to their own terms rather than asserting a license string
 * — a wrong claim on a disclosure page is its own liability.
 */

import type { Metadata } from "next";
import {
  SOURCE_REGISTRY,
  LITTLESIS_ATTRIBUTION_TEXT,
  type SourceCategory,
  type SourceRegistryEntry,
} from "@civitics/db";

export const metadata: Metadata = {
  title: "Data sources & licenses | Civitics",
  description:
    "Every data source Civitics ingests, with its license terms and citation requirements. " +
    "Includes the CC-BY-SA 4.0 attribution required for LittleSis-derived data.",
};

const CATEGORY_ORDER: SourceCategory[] = ["federal", "state", "local", "community", "other"];

const CATEGORY_LABELS: Record<SourceCategory, string> = {
  federal:   "Federal government",
  state:     "State government",
  local:     "Local government",
  community: "Community / nonprofit",
  other:     "Other",
};

const CATEGORY_COLORS: Record<SourceCategory, string> = {
  federal:   "bg-blue-100 text-blue-800",
  state:     "bg-purple-100 text-purple-800",
  local:     "bg-green-100 text-green-800",
  community: "bg-amber-100 text-amber-800",
  other:     "bg-gray-100 text-gray-700",
};

const CC_BY_SA_DEED = "https://creativecommons.org/licenses/by-sa/4.0/";

type GroupedEntry = SourceRegistryEntry & { key: string };

function groupRegistry(): Record<SourceCategory, GroupedEntry[]> {
  const acc: Record<SourceCategory, GroupedEntry[]> = {
    federal: [], state: [], local: [], community: [], other: [],
  };
  // Dedupe by label so fec / fec_bulk / fec_bulk_indiv don't render four times.
  // The first entry wins (keeps the most general homepage_url).
  const seenLabels = new Set<string>();
  for (const [key, entry] of Object.entries(SOURCE_REGISTRY)) {
    if (seenLabels.has(entry.label)) continue;
    seenLabels.add(entry.label);
    acc[entry.category].push({ ...entry, key });
  }
  for (const cat of CATEGORY_ORDER) {
    acc[cat].sort((a, b) => a.label.localeCompare(b.label));
  }
  return acc;
}

export default function DataSourcesPage() {
  const grouped = groupRegistry();

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6 lg:py-14">
      <header className="mb-10 border-b border-gray-200 pb-8">
        <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600">
          Transparency
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-gray-900 sm:text-4xl">
          Data sources &amp; licenses
        </h1>
        <p className="mt-3 text-base leading-relaxed text-gray-600">
          Civitics aggregates public information about government from federal,
          state, local, and community-run data sources. This page lists every
          source we ingest, with its license terms and any citation the source
          requests. Click any source pill on an entity page to see exactly
          which sources contributed to that record.
        </p>
      </header>

      {/* ─── CC-BY-SA 4.0 / LittleSis verbatim attribution block ────────────── */}
      <section
        aria-labelledby="littlesis-attribution"
        className="mb-12 rounded-lg border border-amber-200 bg-amber-50 p-5"
      >
        <h2
          id="littlesis-attribution"
          className="text-sm font-semibold uppercase tracking-wide text-amber-900"
        >
          LittleSis attribution
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-amber-950">
          {LITTLESIS_ATTRIBUTION_TEXT}
        </p>
        <p className="mt-3 text-xs text-amber-800">
          Full license text:{" "}
          <a
            href={CC_BY_SA_DEED}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium underline-offset-2 hover:underline"
          >
            Creative Commons Attribution-ShareAlike 4.0 International deed ↗
          </a>
        </p>
      </section>

      {/* ─── License-method note ────────────────────────────────────────────── */}
      <section className="mb-10 rounded-lg border border-gray-200 bg-gray-50 p-5 text-sm text-gray-700">
        <h2 className="text-sm font-semibold text-gray-900">About these licenses</h2>
        <p className="mt-2 leading-relaxed">
          We list a license string only when we have confirmed it. Federal
          government works are not subject to copyright under{" "}
          <a
            href="https://www.law.cornell.edu/uscode/text/17/105"
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-600 underline-offset-2 hover:underline"
          >
            17 U.S.C. § 105
          </a>{" "}
          and are listed as public domain. LittleSis is licensed under{" "}
          <a
            href={CC_BY_SA_DEED}
            target="_blank"
            rel="noopener noreferrer"
            className="text-indigo-600 underline-offset-2 hover:underline"
          >
            CC-BY-SA 4.0
          </a>
          . For other sources whose current terms we have not re-verified, we
          link to the source's own terms page rather than risk asserting a wrong
          license.
        </p>
      </section>

      {/* ─── Sources grouped by category ────────────────────────────────────── */}
      <div className="flex flex-col gap-10">
        {CATEGORY_ORDER.map((cat) => {
          const entries = grouped[cat];
          if (entries.length === 0) return null;
          return (
            <section key={cat} aria-labelledby={`cat-${cat}`}>
              <div className="mb-4 flex items-center gap-2">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${CATEGORY_COLORS[cat]}`}
                >
                  {CATEGORY_LABELS[cat]}
                </span>
                <h2
                  id={`cat-${cat}`}
                  className="text-xs font-semibold uppercase tracking-wide text-gray-500"
                >
                  {entries.length} {entries.length === 1 ? "source" : "sources"}
                </h2>
              </div>
              <ul className="flex flex-col divide-y divide-gray-100 rounded-lg border border-gray-200 bg-white">
                {entries.map((entry) => (
                  <li key={entry.key} className="p-4">
                    <SourceRow entry={entry} />
                  </li>
                ))}
              </ul>
            </section>
          );
        })}
      </div>

      {/* ─── Footer note ─────────────────────────────────────────────────────── */}
      <footer className="mt-12 border-t border-gray-100 pt-6 text-xs text-gray-500">
        <p>
          Notice an issue with how a source is described or attributed?{" "}
          <a
            href="mailto:civitics.platform@gmail.com"
            className="text-indigo-600 underline-offset-2 hover:underline"
          >
            Let us know
          </a>{" "}
          and we will correct it.
        </p>
      </footer>
    </main>
  );
}

function SourceRow({ entry }: { entry: GroupedEntry }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-base font-semibold text-gray-900">{entry.label}</h3>
        {entry.homepage_url && (
          <a
            href={entry.homepage_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-indigo-600 underline-offset-2 hover:underline"
          >
            {hostname(entry.homepage_url)} ↗
          </a>
        )}
      </div>
      <dl className="grid grid-cols-[7rem_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-gray-500">License</dt>
        <dd className="text-gray-800">
          {entry.license ? (
            entry.license_url ? (
              <a
                href={entry.license_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-indigo-600 underline-offset-2 hover:underline"
              >
                {entry.license}
              </a>
            ) : (
              <span>{entry.license}</span>
            )
          ) : entry.license_url ? (
            <a
              href={entry.license_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-indigo-600 underline-offset-2 hover:underline"
            >
              See {entry.label} terms ↗
            </a>
          ) : (
            <span className="text-gray-400">Not specified</span>
          )}
        </dd>
        {entry.citation && (
          <>
            <dt className="text-gray-500">Citation</dt>
            <dd className="text-gray-700 leading-relaxed">{entry.citation}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
