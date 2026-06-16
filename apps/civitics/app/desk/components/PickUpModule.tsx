export type ResumeInvestigation = { id: string; title: string };
export type ResumeEvidenceCard = {
  id: string;
  investigation_id: string;
  claim_text: string;
  investigation_title: string | null;
};

/**
 * Pick up where you left off — the only real "resume" surface (drafts are out of
 * scope). Open investigations the user owns + their not-yet-corroborated
 * ('proposed') evidence cards. Each links back to the case file.
 */
export function PickUpModule({
  investigations,
  evidenceCards,
}: {
  investigations: ResumeInvestigation[];
  evidenceCards: ResumeEvidenceCard[];
}) {
  const empty = investigations.length === 0 && evidenceCards.length === 0;

  return (
    <section className="border border-rule bg-paper">
      <div className="border-b border-rule px-5 py-3.5">
        <h2 className="font-serif text-lg font-semibold text-ink">Pick up where you left off</h2>
      </div>

      {empty ? (
        <p className="px-5 py-8 text-center text-sm text-ink-soft">
          No open case files. Start an investigation to build the public record.
        </p>
      ) : (
        <ul className="divide-y divide-rule">
          {investigations.map((inv) => (
            <li key={`inv:${inv.id}`} className="px-5 py-3">
              <a href={`/investigations/${inv.id}`} className="group block">
                <span className="inline-flex items-center border border-rule px-1.5 py-[3px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-soft">
                  Open investigation
                </span>
                <p className="mt-1.5 text-sm font-semibold text-ink transition-colors group-hover:text-accent">
                  {inv.title}
                </p>
              </a>
            </li>
          ))}
          {evidenceCards.map((card) => (
            <li key={`card:${card.id}`} className="px-5 py-3">
              <a href={`/investigations/${card.investigation_id}`} className="group block">
                <span className="inline-flex items-center border border-rule px-1.5 py-[3px] font-mono text-[9.5px] font-semibold uppercase tracking-[0.12em] text-ink-soft">
                  Evidence · proposed
                </span>
                <p className="mt-1.5 line-clamp-2 text-sm text-ink transition-colors group-hover:text-accent">
                  {card.claim_text}
                </p>
                {card.investigation_title && (
                  <p className="mt-0.5 font-mono text-[11px] text-ink-soft/70">
                    in {card.investigation_title}
                  </p>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
