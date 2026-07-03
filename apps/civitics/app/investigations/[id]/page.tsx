import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { loadCaseFile } from "../_lib/load";
import {
  citationTier,
  relationshipKindLabel,
  targetHref,
  targetTypeLabel,
  TIER_BADGE,
  TIER2_DISCLAIMER,
  CARD_STATUS_BADGE,
  CLAIM_TYPE_LABEL,
  formatCount,
  type Citation,
  type EvidenceCard,
} from "../_lib/presentation";
import { EvidenceRating } from "../components/EvidenceRating";
import { EvidenceComposer } from "../components/EvidenceComposer";
import { EvidenceCardAdminActions } from "../components/EvidenceCardAdminActions";
import { PageViewTracker } from "../../components/PageViewTracker";
import { EntityComments } from "../../components/EntityComments";
import { SyntheticMark } from "../../components/integrity/Synthetic";
import { PrintLetterhead, PrintProvenance } from "../../components/print/PrintRecord";

// Reads go through the caller's cookie client (RLS does private-person filtering),
// so this page renders per request.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const data = await loadCaseFile(params.id);
  if (!data) return { title: "Investigation | Civitics" };
  const { investigation } = data;
  return {
    title: `${investigation.title} | Investigations | Civitics`,
    description: investigation.question ?? investigation.scope_note ?? undefined,
  };
}

const INV_STATUS_BADGE: Record<"open" | "closed" | "archived", { label: string; className: string }> = {
  open: { label: "Open", className: "bg-amber/25 text-ink border-amber/60" },
  closed: { label: "Closed", className: "bg-ink/5 text-ink-soft border-rule" },
  archived: { label: "Archived", className: "bg-ink/5 text-ink-soft border-rule" },
};

// A card's tier = the strongest (lowest-number) tier among its citations.
function cardTier(card: EvidenceCard): number {
  if (card.citations.length === 0) return 3;
  return Math.min(...card.citations.map((c) => citationTier(c.citation_type)));
}

function CitationRow({ citation }: { citation: Citation }) {
  const tier = citationTier(citation.citation_type);
  const badge = TIER_BADGE[tier];
  const href = targetHref(citation.target_type, citation.target_id);
  const label = targetTypeLabel(citation.target_type);

  return (
    <li className="flex flex-col gap-1 border-l-2 border-rule pl-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className={`rounded border px-1.5 py-0.5 font-medium ${badge.className}`}>{badge.label}</span>
        {href ? (
          <Link href={href} className="font-medium text-civic-blue hover:underline">
            {label} ↗
          </Link>
        ) : (
          <span className="font-medium text-ink-soft">{label}</span>
        )}
      </div>
      {citation.excerpt && (
        <blockquote className="text-xs italic text-ink-soft">“{citation.excerpt}”</blockquote>
      )}
      {tier === 2 && <p className="text-[11px] leading-snug text-ink-soft">{TIER2_DISCLAIMER}</p>}
    </li>
  );
}

function EvidenceCardView({ card, signInNext }: { card: EvidenceCard; signInNext: string }) {
  const status = CARD_STATUS_BADGE[card.status];
  return (
    <article className="rounded-lg border border-rule bg-white/60 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className={`rounded border px-1.5 py-0.5 font-medium ${status.className}`}>
            {status.label}
          </span>
          {card.subject_is_private_person && (
            <span className="rounded border border-amber/60 bg-amber/20 px-1.5 py-0.5 font-medium text-ink">
              Private individual
            </span>
          )}
          {/* Admin-only promote/unpromote/reject/clear (FIX-585). Non-admins see only the badge. */}
          <EvidenceCardAdminActions
            cardId={card.id}
            status={card.status}
            subjectIsPrivatePerson={card.subject_is_private_person}
          />
        </div>
        <span className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
          {card.author_name || "Contributor"}
          {card.author_is_synthetic && <SyntheticMark size="xs" />}
        </span>
      </div>

      {card.claim_type === "edge" && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs font-medium text-ink-soft">
          {(() => {
            const fromHref = targetHref(card.from_type, card.from_id);
            const toHref = targetHref(card.to_type, card.to_id);
            return (
              <>
                {fromHref ? (
                  <Link href={fromHref} className="text-civic-blue hover:underline">
                    {targetTypeLabel(card.from_type)} ↗
                  </Link>
                ) : (
                  <span>{targetTypeLabel(card.from_type)}</span>
                )}
                <span className="rounded bg-ink/5 px-1.5 py-0.5 text-[11px] text-ink">
                  {relationshipKindLabel(card.relationship_kind)}
                </span>
                {toHref ? (
                  <Link href={toHref} className="text-civic-blue hover:underline">
                    {targetTypeLabel(card.to_type)} ↗
                  </Link>
                ) : (
                  <span>{targetTypeLabel(card.to_type)}</span>
                )}
              </>
            );
          })()}
        </p>
      )}

      <p className="mt-2 text-sm leading-relaxed text-ink">{card.claim_text}</p>

      <div className="mt-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-soft">
          {formatCount(card.citations.length, "citation")}
        </p>
        <ul className="mt-1.5 flex flex-col gap-2">
          {card.citations.map((c) => (
            <CitationRow key={c.id} citation={c} />
          ))}
        </ul>
      </div>

      <div className="mt-3 border-t border-rule pt-3 print:hidden">
        <EvidenceRating evidenceId={card.id} summary={card.rating_summary} signInNext={signInNext} />
      </div>
    </article>
  );
}

export default async function CaseFilePage({ params }: { params: { id: string } }) {
  const data = await loadCaseFile(params.id);
  if (!data) notFound();
  const { investigation, evidence, contributors } = data;
  const signInNext = `/investigations/${investigation.id}`;
  const status = INV_STATUS_BADGE[investigation.status] ?? INV_STATUS_BADGE.open;
  const isArchived = investigation.status === "archived";

  // Group by claim_type (edge → context), then within each by tier asc, recency desc.
  const groups: { key: EvidenceCard["claim_type"]; cards: EvidenceCard[] }[] = (
    ["edge", "context"] as const
  )
    .map((key) => ({
      key,
      cards: evidence
        .filter((c) => c.claim_type === key)
        .sort(
          (a, b) =>
            cardTier(a) - cardTier(b) || b.created_at.localeCompare(a.created_at),
        ),
    }))
    .filter((g) => g.cards.length > 0);

  return (
    <div className="min-h-screen bg-paper">
      <PageViewTracker />
      <main id="main-content" className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <Link href="/investigations" className="text-xs text-ink-soft hover:text-ink print:hidden">
          ← All investigations
        </Link>

        {/* Print-only letterhead — case files print as filed public records (FIX-713). */}
        <PrintLetterhead />

        <header className="mt-3 border-b border-rule pb-6">
          <div className="flex flex-wrap items-center gap-2">
            {investigation.is_featured && (
              <span className="rounded border border-civic-blue/30 bg-civic-blue/10 px-1.5 py-0.5 text-[11px] font-medium text-civic-blue">
                Featured
              </span>
            )}
            {investigation.is_seeded && (
              <span className="rounded border border-rule bg-ink/5 px-1.5 py-0.5 text-[11px] font-medium text-ink-soft">
                Platform seed
              </span>
            )}
            <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${status.className}`}>
              {status.label}
            </span>
          </div>

          <h1 className="mt-2 font-serif text-2xl leading-tight text-ink">
            {investigation.title}
            {investigation.is_synthetic && <SyntheticMark withIcon className="ml-2 align-middle" />}
          </h1>
          {investigation.question && (
            <p className="mt-2 text-sm leading-relaxed text-ink-soft">{investigation.question}</p>
          )}
          {investigation.scope_note && (
            <p className="mt-2 text-xs text-ink-soft">
              <span className="font-medium text-ink">Scope:</span> {investigation.scope_note}
            </p>
          )}

          {/* Crew — distinct card authors + the creator. */}
          <div className="mt-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-ink-soft">
              Crew · {formatCount(contributors.length, "contributor")}
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-1.5">
              {contributors.map((c) => (
                <li
                  key={c.user_id}
                  className="rounded-full border border-rule bg-white px-2 py-0.5 text-xs text-ink"
                  title={c.is_creator ? "Creator" : undefined}
                >
                  {c.name || "Contributor"}
                  {c.is_synthetic && <SyntheticMark size="xs" className="ml-1" />}
                  {c.is_creator && <span className="ml-1 text-ink-soft">· creator</span>}
                  {c.card_count > 0 && <span className="ml-1 text-ink-soft">· {c.card_count}</span>}
                </li>
              ))}
            </ul>
          </div>

          {investigation.findings_md && (
            <section className="mt-5 rounded-lg border border-rule bg-white/60 p-4">
              <h2 className="text-sm font-semibold text-ink">Findings</h2>
              <div className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-ink">
                {investigation.findings_md}
              </div>
            </section>
          )}
        </header>

        {/* Evidence */}
        <section className="mt-8">
          <div className="flex items-center justify-between">
            <h2 className="font-serif text-lg text-ink">Evidence</h2>
            <span className="text-xs text-ink-soft">{formatCount(evidence.length, "card")}</span>
          </div>

          {evidence.length === 0 ? (
            <p className="mt-3 text-sm text-ink-soft">
              No evidence yet. Every card must cite a record — add the first one below.
            </p>
          ) : (
            <div className="mt-4 space-y-6">
              {groups.map((g) => (
                <div key={g.key}>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
                    {CLAIM_TYPE_LABEL[g.key]}
                  </h3>
                  <div className="mt-2 space-y-3">
                    {g.cards.map((card) => (
                      <EvidenceCardView key={card.id} card={card} signInNext={signInNext} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Composer */}
          {isArchived ? (
            <p className="mt-6 rounded border border-rule bg-ink/5 px-3 py-2 text-xs text-ink-soft">
              This investigation is archived — evidence is read-only.
            </p>
          ) : (
            <div className="mt-6 print:hidden">
              <EvidenceComposer investigationId={investigation.id} signInNext={signInNext} />
            </div>
          )}
        </section>

        {/* Discussion — C1 EntityComments, discussion-only (no stance / statement mode). */}
        <section className="mt-12 border-t border-rule pt-8 print:hidden">
          <EntityComments
            entityType="investigation"
            entityId={investigation.id}
            allowedKinds={["discussion", "question", "concern", "evidence"]}
            signInNext={signInNext}
            heading="Discussion"
            subheading="Talk through the case file. Evidence claims go in cards above; this is the conversation around them."
          />
        </section>

        {/* Print-only provenance footer — stamps the record's URL + print date. */}
        <PrintProvenance />
      </main>
    </div>
  );
}
