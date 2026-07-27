import Link from "next/link";
import type { ResponsivenessData } from "../../api/officials/[id]/responsiveness/_lib";

// FIX-905 — this card is a LEDGER, not a score. The A-F grade badge and the
// response-rate percentage headline were removed: both were public scores with
// no minimum-sample floor (one unanswered window rendered a public "F"), and the
// platform is committed against public scores. Everything below the headline —
// the counts, the breakdown bar, the per-window response labels, the initiative
// links, and the "Silence is data" note — is the receipts content and stays.
// The responsiveness JUDGMENT now lives in the tiered EngagementBadges
// (app/lib/engagement.ts), which carries explicit small-n discipline.

// Independents/pledge use ink-outline & civic-blue — no purple token by design.
const RESPONSE_LABELS: Record<string, { label: string; color: string }> = {
  support:     { label: "Supports",           color: "bg-green-ink/10 text-green-ink border-green-ink/30" },
  oppose:      { label: "Opposes",            color: "bg-accent/10 text-accent border-accent/30" },
  pledge:      { label: "Pledged to Sponsor", color: "bg-civic-blue/10 text-civic-blue border-civic-blue/30" },
  refer:       { label: "Referred",           color: "bg-amber/25 text-ink border-amber/60" },
  no_response: { label: "No Response",        color: "bg-ink/5 text-ink-soft border-rule" },
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short", day: "numeric", year: "numeric",
  });
}

// ─── ResponsivenessCard ────────────────────────────────────────────────────────

interface ResponsivenessCardProps {
  data: ResponsivenessData;
}

export function ResponsivenessCard({ data }: ResponsivenessCardProps) {
  const { responded, no_response, open, total_closed, recent } = data;
  const now = new Date();

  // If no windows at all, don't render — no civic initiatives have reached this official yet
  if (total_closed === 0 && open === 0) return null;

  return (
    <div className="border border-rule overflow-hidden">
      {/* Header */}
      <div className="px-4 py-3 border-b border-rule flex items-center justify-between">
        <h3 className="text-sm font-semibold text-ink">Civic responsiveness</h3>
        <span className="text-xs text-ink-soft/70">Initiative response windows</span>
      </div>

      <div className="p-4">
        {/* Count row — the record, not a score (FIX-905) */}
        <div className="mb-4">
          {total_closed > 0 ? (
            <>
              <p className="font-mono text-2xl font-bold tabular-nums text-ink">
                {responded} of {total_closed}
              </p>
              <p className="text-xs text-ink-soft mt-0.5">
                closed window{total_closed !== 1 ? "s" : ""} answered
                {open > 0 ? ` · ${open} still open` : ""}
              </p>
            </>
          ) : (
            <>
              <p className="text-base font-semibold text-ink-soft">No closed windows</p>
              <p className="text-xs text-ink-soft/70 mt-0.5">
                {open > 0
                  ? `${open} open window${open !== 1 ? "s" : ""} in progress`
                  : "The record will appear once windows close"}
              </p>
            </>
          )}
        </div>

        {/* Breakdown bar */}
        {total_closed > 0 && (
          <div className="mb-4">
            <div className="flex h-2 w-full overflow-hidden bg-ink/5">
              <div
                className="h-full bg-green-ink transition-all"
                style={{ width: `${Math.round((responded / total_closed) * 100)}%` }}
              />
            </div>
            <div className="mt-1.5 flex justify-between font-mono text-[10px] tabular-nums text-ink-soft/70">
              <span className="text-green-ink font-medium">{responded} responded</span>
              <span className="text-accent font-medium">{no_response} no response</span>
            </div>
          </div>
        )}

        {/* Stat pills */}
        <div className="mb-4 flex flex-wrap gap-2">
          {responded > 0 && (
            <span className="rounded border border-green-ink/30 bg-green-ink/10 px-2.5 py-0.5 text-xs font-medium text-green-ink">
              {responded} responded
            </span>
          )}
          {no_response > 0 && (
            <span className="rounded border border-accent/30 bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent">
              {no_response} no response
            </span>
          )}
          {open > 0 && (
            <span className="rounded border border-amber/60 bg-amber/25 px-2.5 py-0.5 text-xs font-medium text-ink">
              {open} open
            </span>
          )}
        </div>

        {/* Recent windows */}
        {recent.length > 0 && (
          <div>
            <p className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-ink-soft/70">
              Recent windows
            </p>
            <div className="space-y-2">
              {recent.map((r) => {
                const rl     = (RESPONSE_LABELS[r.response_type] ?? RESPONSE_LABELS.no_response)!;
                const isOpen = !r.responded_at && new Date(r.window_closes_at) >= now;
                const daysLeft = isOpen
                  ? Math.max(0, Math.ceil((new Date(r.window_closes_at).getTime() - now.getTime()) / 86_400_000))
                  : null;

                return (
                  <div key={r.initiative_id} className="flex items-start justify-between gap-2 border border-rule/60 bg-paper-2 px-3 py-2">
                    <div className="flex-1 min-w-0">
                      <Link
                        href={`/initiatives/${r.initiative_id}`}
                        className="text-xs font-medium text-accent hover:underline line-clamp-1"
                      >
                        {r.initiative_title}
                      </Link>
                      <p className="font-mono text-[10px] tabular-nums text-ink-soft/70 mt-0.5 capitalize">
                        {r.scope} ·{" "}
                        {r.responded_at
                          ? `Responded ${formatDate(r.responded_at)}`
                          : isOpen
                          ? `${daysLeft}d remaining`
                          : `Closed ${formatDate(r.window_closes_at)}`
                        }
                      </p>
                    </div>
                    <span className={`flex-shrink-0 rounded border px-2 py-0.5 text-[10px] font-semibold ${rl.color}`}>
                      {rl.label}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Permanence note */}
        {no_response > 0 && (
          <p className="mt-3 text-[10px] text-ink-soft/70 italic">
            No Response records are permanent public record. Silence is data.
          </p>
        )}
      </div>
    </div>
  );
}
