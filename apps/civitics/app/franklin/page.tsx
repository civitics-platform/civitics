// FIX-616 (PR A): the State of Franklin hub / landing page.
//
// The State of Franklin is a fully-seeded *demonstration* jurisdiction (1 state +
// Watauga City, 2 governing bodies, 3 agencies, 21 officials, ~11 proposals, 3
// initiatives, 2 investigations, plus Q&A). Until now it had no home of its own —
// reachable only by UUID or search. This page is a curated index that gathers the
// seeded entities and links OUT to their real detail pages, so a visitor can
// experience the demonstration as a coherent whole (and so seeded Q&A is findable).
//
// It mirrors the data-fetch style of /jurisdictions/[id] (anon publishable client,
// parallel waves, ISR) but is scoped to Franklin and adds two sections the
// jurisdiction page lacks: Investigations and a Q&A highlight.
//
// CRITICAL: the Franklin jurisdiction id differs between local and prod, so it is
// resolved at request time (is_synthetic + type='state') — never hardcoded.
import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@supabase/supabase-js";
import { SyntheticBanner, SyntheticMark } from "../components/integrity/Synthetic";
import { PorticoMark } from "../components/brand/PorticoMark";
import { OfficialRosterCard, type OfficialRosterData } from "../components/cards/OfficialRosterCard";
import { InstitutionCard, type InstitutionCardData } from "../components/cards/InstitutionCard";
import { ProposalCard, type ProposalCardData } from "../proposals/components/ProposalCard";
import { InitiativeCard, type InitiativeCardData } from "../initiatives/components/InitiativeCard";
import type { MeetingCardData } from "../components/cards/MeetingCard";
import { StorySpine, type ResolvedStop } from "./components/StorySpine";
import { MoneyFlow, type MoneyDonor } from "./components/MoneyFlow";
import { CommonsStrip, type CommonsPosition } from "./components/CommonsStrip";
import {
  FRANKLIN_SPINE,
  FRANKLIN_BILL_NUMBER,
  OPPOSITION_PAC_NAME,
  RIDGELINE_INVESTIGATION_TITLES,
  PLATEAU_INITIATIVE_TITLE,
} from "./spine";

const PROPOSAL_STATUS_LABEL: Record<string, string> = {
  open_comment: "Open for comment",
  introduced: "Introduced",
  in_committee: "In committee",
  passed: "Passed",
  enacted: "Signed into law",
  failed: "Failed",
  closed: "Closed",
};

export const revalidate = 300;

const OFFICIALS_SHOWN = 6;
const PROPOSALS_SHOWN = 6;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function anonClient(): any {
  return createClient(
    process.env["NEXT_PUBLIC_SUPABASE_URL"]!,
    process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]!
  );
}

export const metadata = {
  title: "State of Franklin — a guided demonstration · Civitics",
  description:
    "A fictional 14th state where every Civitics feature is populated by AI — explore officials, bills, money trails, investigations and Q&A in one place. Clearly labeled; nothing here is real civic data.",
};

// ─── Hub chrome (paper-mode, mirrors the layout reference's section idiom) ─────

function HubSection({
  kicker,
  title,
  subtitle,
  meta,
  children,
}: {
  kicker: string;
  title: string;
  subtitle?: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="border-t border-rule py-8">
      <div className="mb-4 flex items-end gap-3">
        <div>
          <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
            {kicker}
          </p>
          <h2 className="mt-1.5 font-serif text-2xl font-semibold text-ink">{title}</h2>
          {subtitle && <p className="mt-1 text-sm text-ink-soft">{subtitle}</p>}
        </div>
        {meta && (
          <span className="ml-auto whitespace-nowrap font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft/70">
            {meta}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

// ─── Q&A highlight (the discoverability fix — surfaces one answered question) ───

type QAAnswer = { body: string; author_name: string; author_is_synthetic?: boolean };
type QAQuestion = {
  id: string;
  body: string;
  asker_name: string;
  want_count: number;
  answered: boolean;
  answers: QAAnswer[];
};

function QAHighlight({
  q,
  entityHref,
  entityLabel,
  total,
}: {
  q: QAQuestion;
  entityHref: string;
  entityLabel: string;
  total: number;
}) {
  const answer = q.answers[0];
  return (
    <div className="border border-rule bg-card p-5">
      <div className="flex items-start gap-3">
        <span className="font-serif text-2xl font-bold leading-none text-accent">Q</span>
        <div>
          <p className="font-serif text-base font-medium leading-snug text-ink">{q.body}</p>
          <p className="mt-1 font-mono text-[11px] text-ink-soft/70">
            asked by {q.asker_name} · on {entityLabel}
          </p>
        </div>
      </div>

      {answer && (
        <div className="ml-6 mt-3 border-l-4 border-green-ink bg-green-ink/5 p-3">
          <div className="mb-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-green-ink px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-paper">
              Official response
            </span>
            <span className="text-[11px] text-green-ink">{answer.author_name}</span>
            {answer.author_is_synthetic && <SyntheticMark size="xs" />}
          </div>
          <p className="text-sm leading-relaxed text-ink">{answer.body}</p>
        </div>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-[11px] text-ink-soft">
        <span className="text-accent">▲ {q.want_count} want this answered</span>
        {q.answered && <span className="text-green-ink">✓ Answered</span>}
        <Link href={entityHref} className="text-accent hover:underline">
          {total > 1 ? `${total} questions on this jurisdiction →` : "Open the full Q&A →"}
        </Link>
      </div>
    </div>
  );
}

// ─── Investigation card (this section does not exist on the jurisdiction page) ──

type InvestigationRow = {
  id: string;
  title: string;
  question: string | null;
  status: string;
  scope_note: string | null;
};

function InvestigationCard({ inv }: { inv: InvestigationRow }) {
  return (
    <Link
      href={`/investigations/${inv.id}`}
      className="group block border border-rule bg-card p-4 transition-colors hover:border-accent"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className="rounded border border-rule bg-ink/5 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-[0.06em] text-ink-soft">
          Case file
        </span>
        <SyntheticMark size="xs" />
      </div>
      <h3 className="font-serif text-base leading-snug text-ink group-hover:underline">
        {inv.title}
      </h3>
      {inv.question && (
        <p className="mt-1 line-clamp-3 text-sm text-ink-soft">{inv.question}</p>
      )}
    </Link>
  );
}

// ─── Page ──────────────────────────────────────────────────────────────────────

export default async function FranklinHubPage() {
  const supabase = anonClient();

  // Resolve the Franklin jurisdiction at request time (id differs local vs prod).
  let { data: franklin } = await supabase
    .from("jurisdictions")
    .select("id, name, short_name, type, parent_id, is_synthetic")
    .eq("is_synthetic", true)
    .eq("type", "state")
    .limit(1)
    .maybeSingle();
  if (!franklin) {
    const fallback = await supabase
      .from("jurisdictions")
      .select("id, name, short_name, type, parent_id, is_synthetic")
      .eq("name", "State of Franklin")
      .maybeSingle();
    franklin = fallback.data;
  }
  if (!franklin) notFound();

  const stateId = franklin.id as string;

  // Children first — their ids widen the institution/official/proposal scope so
  // the hub shows the city alongside the state.
  const { data: childrenData } = await supabase
    .from("jurisdictions")
    .select("id, name, short_name, type")
    .eq("parent_id", stateId)
    .eq("is_active", true)
    .order("type", { ascending: true })
    .order("name", { ascending: true });
  const children = (childrenData ?? []) as Array<{
    id: string;
    name: string;
    short_name: string | null;
    type: string;
  }>;
  const jurisdictionIds = [stateId, ...children.map((c) => c.id)];

  const [instRes, offRes, propRes, initRes, investRes, qaRes, finEntRes, gbRes, bdRes] = await Promise.all([
    supabase
      .from("institutions")
      .select("id, name, short_name, type, acronym, source_table, is_synthetic")
      .in("jurisdiction_id", jurisdictionIds)
      .eq("is_active", true)
      .order("source_table", { ascending: true })
      .order("name", { ascending: true })
      .limit(50),
    supabase
      .from("officials")
      .select("id, full_name, role_title, party, photo_url, district_name, is_synthetic")
      .in("jurisdiction_id", jurisdictionIds)
      .eq("is_active", true)
      .order("role_title", { ascending: true })
      .order("last_name", { ascending: true })
      .limit(50),
    supabase
      .from("proposals")
      .select("id, title, type, status, summary_plain, summary_model, introduced_at, external_url, metadata, is_synthetic")
      .in("jurisdiction_id", jurisdictionIds)
      .neq("type", "initiative")
      .order("introduced_at", { ascending: false, nullsFirst: false })
      .limit(50),
    // initiative_details has TWO FKs to proposals (proposal_id +
    // promoted_to_proposal_id), so the embed must name the FK explicitly or
    // PostgREST 300s with PGRST201 (the older jurisdictions/[id] page predates
    // the second FK and embeds the now-ambiguous `proposals!inner`).
    supabase
      .from("initiative_details")
      .select(
        "proposal_id, stage, scope, authorship_type, issue_area_tags, target_district, mobilise_started_at, proposals!initiative_details_proposal_id_fkey!inner(id, title, summary_plain, created_at, resolved_at, type, jurisdiction_id)"
      )
      .eq("proposals.type", "initiative")
      .in("proposals.jurisdiction_id", jurisdictionIds)
      .neq("stage", "draft")
      .limit(20),
    supabase
      .from("investigations")
      .select("id, title, question, status, scope_note")
      .eq("is_synthetic", true)
      .neq("status", "archived")
      .order("is_featured", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(6),
    // Q&A highlight: reuse the canonical read RPC so name resolution + want counts
    // match the live QASection exactly (decision 8).
    supabase.rpc("get_entity_questions", {
      p_entity_type: "jurisdiction",
      p_entity_id: stateId,
      p_lens: "all",
      p_sort: "wanted",
      p_limit: 5,
    }),
    // Spine "money" stop + Follow-the-money flow: the synthetic finance graph.
    // is_synthetic returns only Franklin's seeded entities (decision 2 — resolve
    // the PAC by display_name, never franklin_seed_map).
    supabase
      .from("financial_entities")
      .select("id, display_name, entity_type, is_synthetic")
      .eq("is_synthetic", true)
      .limit(50),
    // Governing bodies under Franklin — ids scope the upcoming-meetings query
    // (meetings link via governing_body_id, not jurisdiction_id).
    supabase
      .from("governing_bodies")
      .select("id")
      .in("jurisdiction_id", jurisdictionIds)
      .eq("is_active", true),
    // bill_number lives on bill_details, NOT proposals (the promotion moved it —
    // see CLAUDE.md). bill_details carries jurisdiction_id, so resolve HB-14's
    // proposal id here without a dependent round-trip.
    supabase
      .from("bill_details")
      .select("proposal_id, bill_number")
      .in("jurisdiction_id", jurisdictionIds),
  ]);

  // ── Institutions ────────────────────────────────────────────────────────────
  const institutions = (instRes.data ?? []) as InstitutionCardData[];

  // ── Officials (feature Q&A answerers first) ─────────────────────────────────
  const officialsAll = (offRes.data ?? []) as OfficialRosterData[];
  const officialIds = officialsAll.map((o) => o.id);
  // Featured-first ordering (decision 6.4): one cheap follow-up to find which
  // officials have answered Q&A. Needs the official ids, so it can't join the
  // parallel wave above.
  let answererIds = new Set<string>();
  if (officialIds.length > 0) {
    const { data: ans } = await supabase
      .from("entity_comments")
      .select("entity_id")
      .eq("entity_type", "official")
      .eq("kind", "answer")
      .in("entity_id", officialIds);
    answererIds = new Set((ans ?? []).map((r: { entity_id: string }) => r.entity_id));
  }
  const officials = [...officialsAll]
    .sort((a, b) => Number(answererIds.has(b.id)) - Number(answererIds.has(a.id)))
    .slice(0, OFFICIALS_SHOWN);

  // ── Proposals (open comment periods first, then most recent) ────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposalsAll: ProposalCardData[] = ((propRes.data ?? []) as any[]).map((p) => {
    const meta = (p.metadata ?? {}) as Record<string, string>;
    return {
      id: p.id,
      title: p.title,
      type: p.type,
      status: p.status,
      regulations_gov_id: meta["regulations_gov_id"] ?? null,
      congress_gov_url: p.external_url ?? null,
      comment_period_end: meta["comment_period_end"] ?? null,
      summary_plain: p.summary_plain,
      summary_model: p.summary_model,
      introduced_at: p.introduced_at,
      metadata: meta,
      is_synthetic: p.is_synthetic ?? false,
    };
  });
  const openFirst = [...proposalsAll].sort(
    (a, b) =>
      Number(b.status === "open_comment") - Number(a.status === "open_comment")
  );
  const proposals = openFirst.slice(0, PROPOSALS_SHOWN);
  const openCount = proposalsAll.filter((p) => p.status === "open_comment").length;

  // ── Initiatives ─────────────────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const initiatives: InitiativeCardData[] = ((initRes.data ?? []) as any[])
    .map((row) => {
      const p = Array.isArray(row.proposals) ? row.proposals[0] : row.proposals;
      return {
        id: row.proposal_id,
        title: p?.title ?? "Initiative",
        summary: p?.summary_plain ?? null,
        stage: row.stage,
        scope: row.scope,
        authorship_type: row.authorship_type,
        issue_area_tags: row.issue_area_tags ?? [],
        target_district: row.target_district,
        mobilise_started_at: row.mobilise_started_at,
        created_at: p?.created_at ?? "",
        resolved_at: p?.resolved_at ?? null,
      } as InitiativeCardData;
    })
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .slice(0, 6);

  // ── Investigations ──────────────────────────────────────────────────────────
  const investigations = (investRes.data ?? []) as InvestigationRow[];

  // ── Q&A highlight ───────────────────────────────────────────────────────────
  const qaData = (qaRes.data ?? {}) as { total?: number; questions?: QAQuestion[] };
  const qaTotal = typeof qaData.total === "number" ? qaData.total : 0;
  const qaQuestions = Array.isArray(qaData.questions) ? qaData.questions : [];
  const qaHighlight =
    qaQuestions.find((q) => q.answered && q.answers && q.answers.length > 0) ?? null;

  // ── "Follow HB-14" spine + money flow + Commons strip (FIX-621) ─────────────
  // Resolve each spine stop to a LIVE record (decision 1 & 2): natural keys only,
  // never franklin_seed_map (RLS-blocked for anon). Most stops resolve out of the
  // data already fetched above; a small dependent wave fills in the few live facts
  // that need ids (the vote split, evidence counts, the finance edges, the top
  // bridge comment, the position rollup, upcoming meetings).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proposalsRaw = (propRes.data ?? []) as any[];
  const billNumByProp = new Map<string, string>();
  for (const bd of (bdRes.data ?? []) as Array<{ proposal_id: string; bill_number: string | null }>) {
    if (bd.bill_number) billNumByProp.set(bd.proposal_id, bd.bill_number);
  }
  const hb14PropId =
    [...billNumByProp.entries()].find(([, bn]) => bn === FRANKLIN_BILL_NUMBER)?.[0] ?? null;
  const hb14 = hb14PropId ? proposalsRaw.find((p) => p.id === hb14PropId) ?? null : null;
  const ridgelineInvs = investigations.filter((inv) =>
    RIDGELINE_INVESTIGATION_TITLES.includes(inv.title)
  );
  const initiativeRow = initiatives.find((i) => i.title === PLATEAU_INITIATIVE_TITLE) ?? null;

  const finEntities = (finEntRes.data ?? []) as Array<{ id: string; display_name: string }>;
  const finById = new Map(finEntities.map((e) => [e.id, e]));
  const oppositionPac = finEntities.find((e) => e.display_name === OPPOSITION_PAC_NAME) ?? null;
  const gbIds = ((gbRes.data ?? []) as Array<{ id: string }>).map((g) => g.id);

  const nowIso = new Date().toISOString();
  const [votesRes, evidRes, donRes, commentRes, rollupRes, meetingRes] = await Promise.all([
    hb14
      ? supabase.from("votes").select("vote, official_id").eq("bill_proposal_id", hb14.id)
      : Promise.resolve({ data: [] }),
    ridgelineInvs.length
      ? supabase
          .from("evidence_cards")
          .select("investigation_id")
          .in("investigation_id", ridgelineInvs.map((i) => i.id))
      : Promise.resolve({ data: [] }),
    finEntities.length
      ? supabase
          .from("financial_relationships")
          .select("from_id, to_id, to_type, amount_cents")
          .eq("relationship_type", "donation")
          .eq("from_type", "financial_entity")
          .in("from_id", finEntities.map((e) => e.id))
      : Promise.resolve({ data: [] }),
    hb14
      ? supabase
          .from("entity_comments")
          .select("id, body, bridge_score", { count: "exact" })
          .eq("entity_type", "proposal")
          .eq("entity_id", hb14.id)
          .not("kind", "in", "(question,answer)")
          .order("bridge_score", { ascending: false, nullsFirst: false })
          .limit(1)
      : Promise.resolve({ data: [], count: 0 }),
    hb14
      ? supabase.rpc("get_position_rollup_display", {
          p_entity_type: "proposal",
          p_entity_id: hb14.id,
          p_lens: "all",
        })
      : Promise.resolve({ data: null }),
    gbIds.length
      ? supabase
          .from("meetings")
          .select("id, title, meeting_type, scheduled_at, agenda_url, governing_bodies(name)")
          .in("governing_body_id", gbIds)
          .gte("scheduled_at", nowIso)
          .order("scheduled_at", { ascending: true })
          .limit(3)
      : Promise.resolve({ data: [] }),
  ]);

  // Vote split (live).
  const voteRows = (votesRes.data ?? []) as Array<{ vote: string; official_id: string }>;
  const yesCount = voteRows.filter((v) => v.vote === "yes").length;
  const noCount = voteRows.filter((v) => v.vote === "no").length;
  const noVoterIds = new Set(
    voteRows.filter((v) => v.vote === "no").map((v) => v.official_id)
  );
  const votePassed = yesCount > noCount;

  // Evidence-card count across the cited investigations (live).
  const evidenceTotal = ((evidRes.data ?? []) as unknown[]).length;

  // Finance edges among the synthetic entities (live).
  const donations = (donRes.data ?? []) as Array<{
    from_id: string;
    to_id: string;
    to_type: string;
    amount_cents: number | null;
  }>;
  let moneyData:
    | {
        pacId: string;
        pacName: string;
        donors: MoneyDonor[];
        donorsTotalCents: number;
        noVotesFunded: number;
        noVotesTotal: number;
      }
    | null = null;
  if (oppositionPac) {
    const pacId = oppositionPac.id;
    const donorMap = new Map<string, number>();
    for (const d of donations) {
      if (d.to_type === "financial_entity" && d.to_id === pacId) {
        donorMap.set(d.from_id, (donorMap.get(d.from_id) ?? 0) + (d.amount_cents ?? 0));
      }
    }
    const donors: MoneyDonor[] = [...donorMap.entries()]
      .map(([id, cents]) => ({
        id,
        name: finById.get(id)?.display_name ?? "Donor",
        amountCents: cents,
      }))
      .sort((a, b) => (b.amountCents ?? 0) - (a.amountCents ?? 0));
    const donorsTotalCents = donors.reduce((s, d) => s + (d.amountCents ?? 0), 0);
    // The 3-of-4 figure, computed: NO-voters who took money from this PAC.
    const fundedNoVoters = new Set(
      donations
        .filter((d) => d.from_id === pacId && d.to_type === "official" && noVoterIds.has(d.to_id))
        .map((d) => d.to_id)
    );
    moneyData = {
      pacId,
      pacName: oppositionPac.display_name,
      donors,
      donorsTotalCents,
      noVotesFunded: fundedNoVoters.size,
      noVotesTotal: noCount,
    };
  }

  // Top bridge-scored comment + total discussion comments (live).
  const commentRows = (commentRes.data ?? []) as Array<{
    id: string;
    body: string;
    bridge_score: number | null;
  }>;
  const topComment = commentRows[0]
    ? { body: commentRows[0].body, bridgeScore: commentRows[0].bridge_score }
    : null;
  const commentTotal =
    typeof (commentRes as { count?: number }).count === "number"
      ? (commentRes as { count?: number }).count!
      : 0;

  // Where-people-stand bar from the display rollup (no recompute, decision 6).
  const rollupRow = (Array.isArray(rollupRes.data) ? rollupRes.data[0] : rollupRes.data) as
    | { buckets: Record<string, number> | null; n: number | null; synthetic?: boolean }
    | null
    | undefined;
  let commonsPosition: CommonsPosition | null = null;
  if (rollupRow && rollupRow.buckets) {
    const b = rollupRow.buckets;
    const sum = (keys: string[]) => keys.reduce((s, k) => s + (Number(b[k]) || 0), 0);
    const oppose = sum(["-3", "-2", "-1"]);
    const mixed = sum(["0"]);
    const support = sum(["1", "2", "3"]);
    const n = Number(rollupRow.n) || oppose + mixed + support;
    if (n > 0) {
      commonsPosition = { oppose, mixed, support, n, synthetic: !!rollupRow.synthetic };
    }
  }

  // Upcoming meetings (none seeded for Franklin today → panel omits gracefully).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meetings: MeetingCardData[] = ((meetingRes.data ?? []) as any[]).map((m) => {
    const gb = Array.isArray(m.governing_bodies) ? m.governing_bodies[0] : m.governing_bodies;
    return {
      id: m.id,
      title: m.title,
      meeting_type: m.meeting_type,
      scheduled_at: m.scheduled_at,
      bodyName: gb?.name ?? null,
      agenda_url: m.agenda_url ?? null,
      is_synthetic: true, // every Franklin record is synthetic
    };
  });

  // Resolve the declarative spine into rendered stops (skip any that can't resolve).
  const proposalHref = hb14 ? `/proposals/${hb14.id}` : null;
  const investigationHref = ridgelineInvs[0] ? `/investigations/${ridgelineInvs[0].id}` : null;
  const resolvedStops: ResolvedStop[] = [];
  for (const stop of FRANKLIN_SPINE) {
    const base = { id: stop.id, kicker: stop.kicker, connective: stop.connective, cta: stop.cta };
    if (stop.metric === "bill_status" && hb14 && proposalHref) {
      resolvedStops.push({
        ...base,
        value: PROPOSAL_STATUS_LABEL[hb14.status] ?? hb14.status,
        detail: hb14.title,
        href: proposalHref,
      });
    } else if (stop.metric === "vote_split" && hb14 && proposalHref && voteRows.length > 0) {
      resolvedStops.push({
        ...base,
        value: `${votePassed ? "Passed" : "Failed"} ${yesCount}–${noCount}`,
        detail: "Roll call on the Assembly floor",
        href: proposalHref,
      });
    } else if (stop.metric === "pac_no_votes" && moneyData) {
      resolvedStops.push({
        ...base,
        value: moneyData.pacName,
        detail: `funded ${moneyData.noVotesFunded} of ${moneyData.noVotesTotal} NO votes`,
        href: `/donors/${moneyData.pacId}`,
      });
    } else if (stop.metric === "evidence_count" && investigationHref) {
      resolvedStops.push({
        ...base,
        value: `${ridgelineInvs.length} investigation${ridgelineInvs.length === 1 ? "" : "s"}`,
        detail: `${evidenceTotal} evidence cards`,
        href: investigationHref,
      });
    } else if (stop.metric === "comment_count" && proposalHref) {
      resolvedStops.push({
        ...base,
        value: commentTotal > 0 ? `${commentTotal} comment${commentTotal === 1 ? "" : "s"}` : "Open thread",
        detail: "Bridge-ranked, both sides",
        href: proposalHref,
      });
    } else if (stop.metric === "initiative" && initiativeRow) {
      resolvedStops.push({
        ...base,
        value: initiativeRow.title,
        detail: "Citizen-sponsored",
        href: `/initiatives/${initiativeRow.id}`,
      });
    }
  }

  // ── Hero stat strip (real counts from what was fetched) ─────────────────────
  const stats: Array<{ n: string; l: string }> = [
    { n: String(jurisdictionIds.length), l: "Jurisdictions" },
    { n: String(institutions.length), l: "Bodies & agencies" },
    { n: String(officialsAll.length), l: "Officials" },
    { n: String(proposalsAll.length), l: "Proposals" },
    { n: String(initiatives.length), l: "Initiatives" },
    { n: String(investigations.length), l: "Investigations" },
  ];

  const stateLabel = franklin.short_name ?? franklin.name;

  return (
    <div className="min-h-screen bg-paper">
      <main id="main-content" className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <SyntheticBanner className="mb-6" />

        {/* ── Hero / Start here ── */}
        <section className="pb-6">
          <div className="flex items-center gap-2.5">
            <span className="text-ink">
              <PorticoMark size={30} />
            </span>
            <p className="font-mono text-[11px] font-semibold uppercase tracking-[0.22em] text-accent">
              A guided demonstration
            </p>
          </div>
          <h1 className="mt-3 font-serif text-4xl font-semibold leading-[1.05] text-ink sm:text-5xl">
            The State of Franklin
          </h1>
          <p className="mt-3 max-w-2xl font-serif text-lg leading-snug text-ink-soft">
            An almost-state from 1784, rebuilt as a working model of the whole platform —
            capital at Watauga City.
          </p>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
            Start anywhere. Follow a bill from introduction into the money behind it, into a
            cited investigation, and into the public&apos;s questions — every Civitics surface,
            populated, in one place. It is fictional and populated by AI; real people can
            reply in place, but nothing here counts toward real standing.
          </p>

          <div className="mt-6 grid grid-cols-2 overflow-hidden rounded-sm border border-rule bg-card sm:grid-cols-3 lg:grid-cols-6">
            {stats.map((s, i) => (
              <div
                key={s.l}
                className={`px-4 py-3 ${i < stats.length - 1 ? "border-b border-rule sm:border-b-0 sm:border-r" : ""}`}
              >
                <div className="font-serif text-2xl font-semibold text-ink">{s.n}</div>
                <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-soft/70">
                  {s.l}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* ── 1b. Start with the story — the HB-14 spine (FIX-621) ── */}
        {resolvedStops.length > 0 && hb14 && (
          <HubSection
            kicker="Start with the story"
            title="Follow HB-14 all the way through"
            subtitle="The Ridgeline Clean Energy Act threads every surface together — one click each."
            meta="Guided spine"
          >
            <StorySpine
              billLabel={billNumByProp.get(hb14.id) ?? FRANKLIN_BILL_NUMBER}
              billTitle={hb14.title}
              stops={resolvedStops}
            />
          </HubSection>
        )}

        {/* ── 2. The place ── */}
        <HubSection
          kicker="The place"
          title="Jurisdictions"
          meta={`${jurisdictionIds.length} levels · state → city`}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Link
              href={`/jurisdictions/${stateId}`}
              className="group block border border-rule bg-card p-4 transition-colors hover:border-accent"
            >
              <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-soft/70">
                State
              </p>
              <h3 className="mt-1 font-serif text-lg text-ink group-hover:underline">
                {franklin.name}
                <SyntheticMark size="xs" className="ml-1.5" />
              </h3>
              <p className="mt-2 font-mono text-[11px] text-accent">Open jurisdiction →</p>
            </Link>
            {children.map((c) => (
              <Link
                key={c.id}
                href={`/jurisdictions/${c.id}`}
                className="group block border border-rule bg-card p-4 transition-colors hover:border-accent"
              >
                <p className="font-mono text-[10px] uppercase tracking-[0.1em] text-ink-soft/70 capitalize">
                  {c.type}
                </p>
                <h3 className="mt-1 font-serif text-lg text-ink group-hover:underline">
                  {c.short_name ?? c.name}
                  <SyntheticMark size="xs" className="ml-1.5" />
                </h3>
                <p className="mt-2 font-mono text-[11px] text-accent">Open jurisdiction →</p>
              </Link>
            ))}
          </div>
        </HubSection>

        {/* ── 3. Bodies & agencies ── */}
        {institutions.length > 0 && (
          <HubSection
            kicker="Who governs"
            title="Bodies & agencies"
            meta={`${institutions.length} institutions`}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {institutions.map((i) => (
                <InstitutionCard key={i.id} institution={i} />
              ))}
            </div>
          </HubSection>
        )}

        {/* ── 4. Officials (Q&A answerers featured first) ── */}
        {officials.length > 0 && (
          <HubSection
            kicker="Who holds office"
            title="Officials"
            subtitle="Officials who answer public questions are featured first."
            meta={`${officialsAll.length} on record`}
          >
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {officials.map((o) => (
                <OfficialRosterCard key={o.id} official={o} />
              ))}
            </div>
            <Link
              href={`/jurisdictions/${stateId}`}
              className="mt-3 inline-block font-mono text-[11px] text-accent hover:underline"
            >
              See all {officialsAll.length} officials →
            </Link>
          </HubSection>
        )}

        {/* ── 5. Proposals ── */}
        {proposals.length > 0 && (
          <HubSection
            kicker="What's on the floor"
            title="Proposals & comment periods"
            meta={`${proposalsAll.length} measures · ${openCount} open`}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {proposals.map((p) => (
                <ProposalCard key={p.id} proposal={p} />
              ))}
            </div>
            <Link
              href="/proposals"
              className="mt-3 inline-block font-mono text-[11px] text-accent hover:underline"
            >
              View all proposals →
            </Link>
          </HubSection>
        )}

        {/* ── 6. Initiatives ── */}
        {initiatives.length > 0 && (
          <HubSection
            kicker="Citizen-led"
            title={initiatives.length === 1 ? "Initiative" : "Initiatives"}
            meta={`${initiatives.length} active`}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {initiatives.map((i) => (
                <InitiativeCard key={i.id} initiative={i} />
              ))}
            </div>
          </HubSection>
        )}

        {/* ── 7. Investigations (new section — not on the jurisdiction page) ── */}
        {investigations.length > 0 && (
          <HubSection
            kicker="Cited case files"
            title="Investigations"
            subtitle="Each claim cites a record. Edge claims can be promoted into the connection graph."
            meta={`${investigations.length} open`}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {investigations.map((inv) => (
                <InvestigationCard key={inv.id} inv={inv} />
              ))}
            </div>
          </HubSection>
        )}

        {/* ── 7b. Follow the money (FIX-621) ── */}
        {moneyData && (
          <HubSection
            kicker="Campaign finance"
            title="Follow the money"
            subtitle="Donors → the opposition PAC → the HB-14 NO votes. Every edge is a record; the cited claim lives in the investigation."
            meta={`${moneyData.donors.length} donors · graph-linked`}
          >
            <MoneyFlow
              pacId={moneyData.pacId}
              pacName={moneyData.pacName}
              donors={moneyData.donors}
              donorsTotalCents={moneyData.donorsTotalCents}
              noVotesFunded={moneyData.noVotesFunded}
              noVotesTotal={moneyData.noVotesTotal}
              graphHref="/graph"
              investigationHref={investigationHref}
            />
          </HubSection>
        )}

        {/* ── 8. Q&A highlight (the discoverability fix) ── */}
        {qaHighlight && (
          <HubSection
            kicker="Citizens ask, officials answer"
            title="Q&A"
            subtitle="Q&A lives on every official, agency, and jurisdiction — here's a real one."
          >
            <QAHighlight
              q={qaHighlight}
              entityHref={`/jurisdictions/${stateId}`}
              entityLabel={stateLabel}
              total={qaTotal}
            />
          </HubSection>
        )}

        {/* ── 9. The Commons (FIX-621) ── */}
        {(topComment || (commonsPosition && commonsPosition.n > 0) || meetings.length > 0) && hb14 && (
          <HubSection
            kicker="The people"
            title="The Commons"
            subtitle="Discussion anchored to the record — where people stand, and what's next."
          >
            <CommonsStrip
              topComment={topComment}
              commentTotal={commentTotal}
              position={commonsPosition}
              proposalHref={proposalHref ?? "/proposals"}
              meetings={meetings}
            />
          </HubSection>
        )}

        {/* ── Footer CTA ── */}
        <section className="mt-8 border border-rule bg-ink px-6 py-7 text-paper">
          <h3 className="font-serif text-xl font-semibold">
            This is a demonstration. Now explore the real record.
          </h3>
          <div className="mt-4 flex flex-wrap gap-2.5">
            {[
              { label: "Officials", href: "/officials" },
              { label: "Proposals", href: "/proposals" },
              { label: "Investigations", href: "/investigations" },
              { label: "Connection graph", href: "/graph" },
            ].map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="border border-paper/40 px-4 py-2 font-mono text-xs text-paper transition-colors hover:bg-paper hover:text-ink"
              >
                {l.label} →
              </Link>
            ))}
          </div>
          <p className="mt-5 font-mono text-[11px] text-paper/60">
            The State of Franklin is fictional and AI-populated · public cost ledger — $0.00, always
          </p>
        </section>
      </main>
    </div>
  );
}
