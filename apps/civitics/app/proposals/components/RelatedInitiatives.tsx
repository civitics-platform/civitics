import Link from "next/link";

// ─── Types ─────────────────────────────────────────────────────────────────────

export type InitiativeLink = {
  id:    string;
  title: string;
  stage: "draft" | "deliberate" | "mobilise" | "resolved";
  scope: "federal" | "state" | "local";
  issue_area_tags: string[];
};

// ─── Stage config ──────────────────────────────────────────────────────────────

const STAGE_STYLES: Record<string, { label: string; color: string }> = {
  draft:      { label: "Draft",        color: "bg-ink/5 text-ink-soft border-rule" },
  deliberate: { label: "Deliberating", color: "bg-amber/25 text-ink border-amber/60" },
  mobilise:   { label: "Mobilising",   color: "bg-civic-blue/10 text-civic-blue border-civic-blue/25" },
  resolved:   { label: "Resolved",     color: "bg-green-ink/10 text-green-ink border-green-ink/25" },
};

// ─── RelatedInitiatives ────────────────────────────────────────────────────────

interface RelatedInitiativesProps {
  initiatives: InitiativeLink[];
}

export function RelatedInitiatives({ initiatives }: RelatedInitiativesProps) {
  if (initiatives.length === 0) return null;

  return (
    <div className="mt-6">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Citizen initiatives</h3>
        <Link
          href="/initiatives"
          className="text-xs text-accent hover:underline"
        >
          Browse all →
        </Link>
      </div>
      <p className="mb-3 text-xs text-ink-soft">
        Citizens have linked {initiatives.length} initiative{initiatives.length !== 1 ? "s" : ""} to this proposal.
      </p>
      <div className="space-y-2">
        {initiatives.map((init) => {
          const ss = (STAGE_STYLES[init.stage] ?? STAGE_STYLES.draft)!;
          return (
            <Link
              key={init.id}
              href={`/initiatives/${init.id}`}
              className="block border border-rule bg-card p-3 transition-colors hover:border-accent hover:bg-accent/5"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="flex-1 text-sm font-medium text-ink leading-snug line-clamp-2">
                  {init.title}
                </p>
                <span className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${ss.color}`}>
                  {ss.label}
                </span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                <span className="rounded-full bg-ink/5 px-2 py-0.5 text-[10px] text-ink-soft capitalize">
                  {init.scope}
                </span>
                {init.issue_area_tags.slice(0, 3).map((t) => (
                  <span key={t} className="rounded-full bg-civic-blue/10 px-2 py-0.5 text-[10px] text-civic-blue capitalize">
                    {t.replace(/_/g, " ")}
                  </span>
                ))}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
