import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { PageViewTracker } from "../../components/PageViewTracker";
import { UpvoteButton } from "./components/UpvoteButton";
import { VersionHistory } from "./components/VersionHistory";
import { InlineEditor } from "./components/InlineEditor";
import { EntityComments } from "../../components/EntityComments";
import { INITIATIVE_STAGE_KINDS, type InitiativeStage } from "@civitics/db";
import { QualityGate } from "./components/QualityGate";
import { SignaturePanel } from "./components/SignaturePanel";
import { ResponseWindowStatus, type ResponseRow } from "./components/ResponseWindowStatus";
import { FollowButton } from "./components/FollowButton";
import { InitiativeCommentPanel, type CommentableProposal } from "./components/InitiativeCommentPanel";
import { TurnIntoInitiativeButton } from "./components/TurnIntoInitiativeButton";

export const dynamic = "force-dynamic";

export async function generateStaticParams() {
  return [];
}

// QWEN-ADDED: SEO/OG metadata for initiative detail pages
export async function generateMetadata(
  { params }: { params: { id: string } }
): Promise<Metadata> {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const { data: proposal } = await supabase
    .from("proposals")
    .select("title, summary_plain, initiative_details(stage, scope)")
    .eq("id", params.id)
    .eq("type", "initiative")
    .maybeSingle();

  if (!proposal || !proposal.initiative_details) return { title: "Initiative | Civitics" };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const details: any = Array.isArray(proposal.initiative_details)
    ? proposal.initiative_details[0]
    : proposal.initiative_details;

  const description = proposal.summary_plain
    ? proposal.summary_plain.slice(0, 160)
    : `${details.scope} · ${details.stage}`;

  return {
    title: proposal.title,
    description,
    openGraph: {
      title: `${proposal.title} | Civitics`,
      description,
    },
  };
}

// ─── Types ────────────────────────────────────────────────────────────────────

type InitiativeDetail = {
  id: string;
  title: string;
  summary: string | null;
  body_md: string;
  stage: "problem" | "draft" | "deliberate" | "mobilise" | "resolved";
  scope: "federal" | "state" | "local";
  authorship_type: "individual" | "community";
  primary_author_id: string | null;
  issue_area_tags: string[];
  target_district: string | null;
  quality_gate_score: Record<string, unknown>;
  mobilise_started_at: string | null;
  resolved_at: string | null;
  resolution_type: string | null;
  created_at: string;
  updated_at: string;
};


// ─── Constants ────────────────────────────────────────────────────────────────

const STAGE_STYLES: Record<string, { label: string; color: string; description: string }> = {
  problem:    { label: "Problem",      color: "bg-orange-100 text-orange-700 border-orange-200", description: "Open problem — seeking community input" },
  draft:      { label: "Draft",        color: "bg-gray-100 text-gray-700 border-gray-200",   description: "Private draft — only visible to you" },
  deliberate: { label: "Deliberating", color: "bg-amber-100 text-amber-700 border-amber-200", description: "Open for community deliberation" },
  mobilise:   { label: "Mobilising",   color: "bg-indigo-100 text-indigo-700 border-indigo-200", description: "Gathering signatures" },
  resolved:   { label: "Resolved",     color: "bg-green-100 text-green-700 border-green-200", description: "Resolved" },
};


// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function renderMarkdown(md: string): string {
  // Very lightweight Markdown → HTML (server-side, no deps)
  return md
    .split("\n")
    .map((line) => {
      if (/^### /.test(line)) return `<h3 class="text-base font-bold text-gray-900 mt-5 mb-1">${line.slice(4)}</h3>`;
      if (/^## /.test(line))  return `<h2 class="text-lg font-bold text-gray-900 mt-6 mb-2">${line.slice(3)}</h2>`;
      if (/^# /.test(line))   return `<h1 class="text-xl font-bold text-gray-900 mt-6 mb-2">${line.slice(2)}</h1>`;
      if (/^- /.test(line))   return `<li class="ml-4 text-gray-700">${line.slice(2)}</li>`;
      if (line.trim() === "") return "<br/>";
      // Bold + italic inline
      const processed = line
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/_(.+?)_/g, "<em>$1</em>");
      return `<p class="text-gray-700 leading-relaxed">${processed}</p>`;
    })
    .join("\n");
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function InitiativeDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const { id } = params;

  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  // Fetch initiative + counts in parallel
  const [proposalRes, { data: { user } }, totalSigsRes, verifiedSigsRes, upvoteRes, followRes, linkedProposalsRes] =
    await Promise.all([
      supabase
        .from("proposals")
        .select("*, initiative_details(*)")
        .eq("id", id)
        .eq("type", "initiative")
        .maybeSingle(),
      supabase.auth.getUser(),
      supabase
        .from("civic_initiative_signatures")
        .select("*", { count: "exact", head: true })
        .eq("initiative_id", id),
      supabase
        .from("civic_initiative_signatures")
        .select("*", { count: "exact", head: true })
        .eq("initiative_id", id)
        .eq("verification_tier", "district"),
      supabase
        .from("civic_initiative_upvotes")
        .select("*", { count: "exact", head: true })
        .eq("initiative_id", id),
      supabase
        .from("civic_initiative_follows")
        .select("*", { count: "exact", head: true })
        .eq("initiative_id", id),
      supabase
        .from("civic_initiative_proposal_links")
        .select("proposal_id, proposals!proposal_id(id, title, short_title, status, metadata, bill_details(bill_number))")
        .eq("initiative_id", id)
        .limit(10),
    ]);

  if (proposalRes.error || !proposalRes.data || !proposalRes.data.initiative_details) {
    notFound();
  }

  const proposal = proposalRes.data;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const details: any = Array.isArray(proposal.initiative_details)
    ? proposal.initiative_details[0]
    : proposal.initiative_details;

  const initiative: InitiativeDetail = {
    id:                   proposal.id,
    title:                proposal.title,
    summary:              proposal.summary_plain,
    body_md:              details.body_md,
    stage:                details.stage,
    scope:                details.scope,
    authorship_type:      details.authorship_type,
    primary_author_id:    details.primary_author_id,
    issue_area_tags:      details.issue_area_tags ?? [],
    target_district:      details.target_district,
    quality_gate_score:   details.quality_gate_score ?? {},
    mobilise_started_at:  details.mobilise_started_at,
    resolved_at:          proposal.resolved_at,
    resolution_type:      details.resolution_type,
    created_at:           proposal.created_at,
    updated_at:           proposal.updated_at,
  };
  const isAuthor = user?.id === initiative.primary_author_id;
  const canEdit = isAuthor && (initiative.stage === "draft" || initiative.stage === "deliberate" || initiative.stage === "problem");
  const stageStyle = (STAGE_STYLES[initiative.stage] ?? STAGE_STYLES.draft)!;
  const upvoteCount   = upvoteRes.count ?? 0;
  const followCount   = followRes.count ?? 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const linkedProposals = ((linkedProposalsRes.data ?? []) as any[])
    .map((row) => {
      const p = row.proposals;
      if (!p) return null;
      const bd = Array.isArray(p.bill_details) ? p.bill_details[0] : p.bill_details;
      const meta = (p.metadata ?? {}) as Record<string, unknown>;
      return {
        id:                 p.id,
        title:              p.title,
        short_title:        p.short_title,
        status:             p.status,
        bill_number:        bd?.bill_number ?? null,
        regulations_gov_id: meta.regulations_gov_id ?? null,
        congress_gov_url:   meta.congress_gov_url ?? null,
        comment_period_end: meta.comment_period_end ?? null,
      };
    })
    .filter(Boolean) as CommentableProposal[];

  // Fetch official responses
  const { data: responses } = await supabase
    .from("civic_initiative_responses")
    .select("id,official_id,response_type,body_text,committee_referred,window_opened_at,window_closes_at,responded_at,is_verified_staff")
    .eq("initiative_id", id);

  const officialResponses = (responses ?? []) as ResponseRow[];

  return (
    <div className="min-h-screen bg-gray-50">
      <PageViewTracker entityType="initiative" entityId={id} />

      <main className="mx-auto max-w-4xl px-4 py-8 sm:px-6">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 text-sm text-gray-500">
          <Link href="/initiatives" className="hover:text-gray-900">Initiatives</Link>
          <span>/</span>
          <span className="line-clamp-1 text-gray-900">{initiative.title}</span>
        </nav>

        <div className="lg:grid lg:grid-cols-[1fr_280px] lg:gap-8">
          {/* ── Main column ──────────────────────────────────────────── */}
          <div>
            {/* Header */}
            <div className="mb-6">
              {/* Stage + badges */}
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${stageStyle.color}`}>
                  {stageStyle.label}
                </span>
                <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600 capitalize">
                  {initiative.scope}
                </span>
                {initiative.authorship_type === "community" && (
                  <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                    Community
                  </span>
                )}
                {initiative.issue_area_tags.map((t) => (
                  <Link
                    key={t}
                    href={`/initiatives?tag=${t}`}
                    className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs text-gray-600 capitalize hover:bg-gray-200"
                  >
                    {t.replace(/_/g, " ")}
                  </Link>
                ))}
              </div>

              {/* Title + edit button */}
              <div className="flex items-start justify-between gap-3">
                <h1 className="text-2xl font-bold text-gray-900 leading-tight">
                  {initiative.title}
                </h1>
                {canEdit && (
                  <div className="relative flex-shrink-0 pt-0.5">
                    <InlineEditor
                      initiativeId={initiative.id}
                      currentTitle={initiative.title}
                      currentSummary={initiative.summary}
                      currentBody={initiative.body_md}
                      currentScope={initiative.scope}
                      currentTags={initiative.issue_area_tags}
                    />
                  </div>
                )}
              </div>

              {/* Summary */}
              {initiative.summary && (
                <p className="mt-2 text-base text-gray-600 leading-relaxed">
                  {initiative.summary}
                </p>
              )}

              {/* Meta */}
              <p className="mt-3 text-xs text-gray-400">
                Started {formatDate(initiative.created_at)}
                {initiative.updated_at !== initiative.created_at && (
                  <> · Updated {formatDate(initiative.updated_at)}</>
                )}
                {initiative.target_district && (
                  <> · {initiative.target_district}</>
                )}
              </p>
            </div>

            {/* Stage description banner */}
            {initiative.stage === "draft" && isAuthor && (
              <div className="mb-6 flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-amber-800">
                  <span className="font-semibold">This is a private draft.</span> Only you can see it.
                  Edit the proposal until you&apos;re ready to open it for deliberation.
                </p>
              </div>
            )}

            {/* Problem stage — public but no solution yet */}
            {initiative.stage === "problem" && (
              <div className="mb-6 rounded-lg border border-orange-200 bg-orange-50 px-4 py-4">
                <div className="flex items-start gap-3">
                  <svg className="mt-0.5 h-4 w-4 flex-shrink-0 text-orange-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.347.347A3.977 3.977 0 0112 15.75a3.977 3.977 0 01-2.79-1.153l-.347-.347z" />
                  </svg>
                  <div className="flex-1">
                    <p className="text-sm font-semibold text-orange-800">Open problem — community input welcome</p>
                    <p className="mt-0.5 text-xs text-orange-700">
                      This is a problem statement, not a full proposal. The community can discuss
                      causes, share experiences, and help develop solutions.
                    </p>
                    {isAuthor && (
                      <TurnIntoInitiativeButton initiativeId={initiative.id} />
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Quality gate — shown to author on draft + deliberate stages */}
            {isAuthor && (initiative.stage === "draft" || initiative.stage === "deliberate") && (
              <QualityGate
                initiativeId={initiative.id}
                currentStage={initiative.stage}
              />
            )}

            {/* Proposal / problem body */}
            <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
              <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-gray-400">
                {initiative.stage === "problem" ? "Problem description" : "Proposal"}
              </h2>
              <div
                className="prose prose-sm max-w-none"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(initiative.body_md) }}
              />
            </div>

            {/* Official response windows */}
            <ResponseWindowStatus
              initiativeId={id}
              responses={officialResponses}
            />

            {/* Official comment submission — shown in mobilise stage when linked proposals have open dockets */}
            {initiative.stage === "mobilise" && (
              <InitiativeCommentPanel
                initiativeTitle={initiative.title}
                initiativeSummary={initiative.summary}
                proposals={linkedProposals}
              />
            )}

            {/* Argument board — unified comments substrate (C0), stage-aware vocab */}
            <EntityComments
              entityType="proposal"
              entityId={initiative.id}
              allowedKinds={[...(INITIATIVE_STAGE_KINDS[initiative.stage as InitiativeStage] ?? ["discussion"])]}
              stanceGrouped={["deliberate", "mobilise"].includes(initiative.stage)}
              composerEnabled={["problem", "deliberate", "mobilise"].includes(initiative.stage)}
              heading="Argument board"
              subheading="Best-supported comments rise. Rate the reasoning you find valuable."
            />

            <VersionHistory initiativeId={initiative.id} />
          </div>

          {/* ── Sidebar ──────────────────────────────────────────────── */}
          <aside className="mt-8 space-y-4 lg:mt-0">
            {/* Upvote + follow card */}
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <p className="mb-3 text-sm font-semibold text-gray-900">Support this initiative</p>
              <UpvoteButton initiativeId={initiative.id} initialCount={upvoteCount} />
              <p className="mt-2 text-xs text-gray-400">
                Upvotes help advance to deliberation.
              </p>
              <div className="mt-3 border-t border-gray-100 pt-3">
                <FollowButton initiativeId={initiative.id} initialCount={followCount} />
                <p className="mt-1.5 text-xs text-gray-400">
                  Follow to get updates on this initiative.
                </p>
              </div>
            </div>

            {/* Signature panel (shown in mobilise stage) */}
            {initiative.stage === "mobilise" && (
              <SignaturePanel
                initiativeId={initiative.id}
                mobiliseStartedAt={initiative.mobilise_started_at}
                initialTotal={totalSigsRes.count ?? 0}
                initialConstituent={verifiedSigsRes.count ?? 0}
              />
            )}

            {/* Meta card */}
            <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
              <p className="mb-3 text-sm font-semibold text-gray-900">Details</p>
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <dt className="text-gray-500">Stage</dt>
                  <dd className="font-medium text-gray-900 capitalize">{initiative.stage}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Scope</dt>
                  <dd className="font-medium text-gray-900 capitalize">{initiative.scope}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-gray-500">Authorship</dt>
                  <dd className="font-medium text-gray-900 capitalize">{initiative.authorship_type}</dd>
                </div>
                {initiative.target_district && (
                  <div className="flex justify-between">
                    <dt className="text-gray-500">District</dt>
                    <dd className="font-medium text-gray-900">{initiative.target_district}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-gray-500">Started</dt>
                  <dd className="font-medium text-gray-900">{formatDate(initiative.created_at)}</dd>
                </div>
              </dl>
            </div>
            {/* Linked proposals */}
            {linkedProposals.length > 0 && (
              <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
                <p className="mb-3 text-sm font-semibold text-gray-900">Linked legislation</p>
                <div className="space-y-2">
                  {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
                  {linkedProposals.map((p: any) => (
                    <a
                      key={p.id}
                      href={`/proposals/${p.id}`}
                      className="block rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs transition-colors hover:border-indigo-200 hover:bg-indigo-50"
                    >
                      <span className="font-medium text-gray-800 line-clamp-2">
                        {p.bill_number ? `${p.bill_number} · ` : ""}{p.short_title ?? p.title}
                      </span>
                      <span className="mt-0.5 block capitalize text-gray-400">{p.status?.replace(/_/g, " ")}</span>
                    </a>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      </main>
    </div>
  );
}
