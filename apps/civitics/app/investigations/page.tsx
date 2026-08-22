import type { Metadata } from "next";
import Link from "next/link";
import { listInvestigations, viewerCapState } from "./_lib/load";
import { formatCount } from "./_lib/presentation";
import { StartInvestigationButton } from "./components/StartInvestigationButton";
import { PageViewTracker } from "../components/PageViewTracker";

// Reads go through the caller's cookie client (RLS), so this can't be statically
// cached — render per request. The list itself is public; a creator additionally
// sees their own archived/private rows.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  // No "| Civitics" suffix — the root layout title template appends it (FIX-1076).
  title: "Investigations",
  description:
    "Community case files built on cited records — no claim without a citation. Browse open investigations or start your own.",
};

const STATUS_BADGE: Record<"open" | "closed" | "archived", { label: string; className: string }> = {
  open: { label: "Open", className: "bg-amber/25 text-ink border-amber/60" },
  closed: { label: "Closed", className: "bg-ink/5 text-ink-soft border-rule" },
  archived: { label: "Archived", className: "bg-ink/5 text-ink-soft border-rule" },
};

export default async function InvestigationsIndexPage() {
  const [items, cap] = await Promise.all([listInvestigations(), viewerCapState()]);

  return (
    <div className="min-h-screen bg-paper">
      <PageViewTracker />
      <main id="main-content" className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <header className="border-b border-rule pb-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-ink-soft">Court of record</p>
          <h1 className="mt-1 font-serif text-3xl text-ink">Investigations</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-ink-soft">
            A case file is an investigative question plus evidence cards. The rule is structural:{" "}
            <span className="font-medium text-ink">no claim without a citation to a record.</span> Edge
            claims can later be reviewed and promoted into the connection graph.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <StartInvestigationButton
              signedIn={cap.signedIn}
              openCount={cap.openCount}
              cap={cap.cap}
              signInNext="/investigations"
            />
            {cap.signedIn && (
              <span className="text-xs text-ink-soft">
                {cap.openCount} of {cap.cap} open investigations
              </span>
            )}
          </div>
        </header>

        {items.length === 0 ? (
          <p className="mt-10 text-sm text-ink-soft">No investigations yet. Start the first one.</p>
        ) : (
          <ul className="mt-6 divide-y divide-rule">
            {items.map(({ investigation: inv, evidence_count, contributor_count }) => {
              const status = STATUS_BADGE[inv.status] ?? STATUS_BADGE.open;
              return (
                <li key={inv.id} className="group relative py-5">
                  <Link
                    href={`/investigations/${inv.id}`}
                    className="absolute inset-0 z-0"
                    aria-label={inv.title}
                  />
                  <div className="relative z-10 flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      {inv.is_featured && (
                        <span className="rounded border border-civic-blue/30 bg-civic-blue/10 px-1.5 py-0.5 text-[11px] font-medium text-civic-blue">
                          Featured
                        </span>
                      )}
                      {inv.is_seeded && (
                        <span className="rounded border border-rule bg-ink/5 px-1.5 py-0.5 text-[11px] font-medium text-ink-soft">
                          Platform seed
                        </span>
                      )}
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${status.className}`}
                      >
                        {status.label}
                      </span>
                    </div>

                    <h2 className="font-serif text-lg leading-snug text-ink group-hover:underline">
                      {inv.title}
                    </h2>
                    {inv.question && (
                      <p className="line-clamp-2 text-sm text-ink-soft">{inv.question}</p>
                    )}

                    <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-soft">
                      <span>{formatCount(evidence_count, "evidence card")}</span>
                      <span>{formatCount(contributor_count, "contributor")}</span>
                      {inv.scope_note && <span className="truncate">Scope: {inv.scope_note}</span>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}
