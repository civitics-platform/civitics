import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache } from "react";
import {
  createPublicClient,
  fetchIndustryTagsByEntityId,
  fetchAttributionForEntity,
  type AttributionShape,
} from "@civitics/db";
import { withDbTimeout } from "@/lib/supabase-check";
import { ShareButton } from "../../officials/components/ShareButton";
import { PageViewTracker } from "../../components/PageViewTracker";
import { SourceBadge } from "../../components/SourceBadge";
import { SourceDetailPopover } from "../../components/SourceDetailPopover";
import { SyntheticMark } from "../../components/integrity/Synthetic";

// Donor / PAC / committee / corporation profile. Mirrors the officials page
// model: public-read RLS, createPublicClient → real ISR (5-min revalidate),
// generateStaticParams returns [] so all ~540K donors render on-demand under
// the ISR cache.
export const revalidate = 300;

export async function generateStaticParams() {
  return [];
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Entity = {
  id: string;
  display_name: string;
  canonical_name: string;
  entity_type: string;
  fec_committee_id: string | null;
  parent_entity_id: string | null;
  total_donated_cents: number;
  total_received_cents: number;
  total_contract_cents: number;
  total_grant_cents: number;
  // FIX-666: materialized Schedule E independent-expenditure totals.
  total_ie_support_cents: number;
  total_ie_oppose_cents: number;
  donor_fingerprint: string | null;
  metadata: Record<string, unknown> | null;
  // SF-P2 (FIX-599): the financial entity's own synthetic flag (entity marker).
  is_synthetic: boolean;
  attribution: AttributionShape;
};

type Relationship = {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  amount_cents: number | null;
  occurred_at: string | null;
  cycle_year: number | null;
  relationship_type: string;
  metadata: Record<string, unknown> | null;
};

type RecipientRow = {
  id: string;
  to_type: string;
  name: string;
  subtitle: string | null;
  party: string | null;
  total_cents: number;
  count: number;
  cycles: Set<number>;
  href: string | null;
};

// FIX-668: one aggregated row per (target official × support|oppose direction).
type IeTargetRow = {
  id: string;
  name: string;
  subtitle: string | null;
  party: string | null;
  href: string | null;
  direction: "support" | "oppose";
  total_cents: number;
  count: number;
};

type DonorRow = {
  id: string;
  name: string;
  industry: string | null;
  donor_type: string;
  total_cents: number;
  count: number;
};

type SpendingRow = {
  id: string;
  agency_name: string;
  award_type: string;
  amount_cents: number;
  occurred_at: string | null;
  description: string | null;
};

// withDbTimeout infers its generic T from the query builder; an `any`-typed
// builder (the `sb` cast below) collapses T to `unknown`, so annotate the
// result shape explicitly. Consumers cast `.data` downstream, so a permissive
// shape is sufficient.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DbRes = { data: any; error: any; count?: number | null };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMoney(cents: number | null | undefined): string {
  if (!cents || cents <= 0) return "$0";
  const dollars = cents / 100;
  if (dollars >= 1_000_000) return `$${(dollars / 1_000_000).toFixed(1)}M`;
  if (dollars >= 1_000) return `$${(dollars / 1_000).toFixed(0)}K`;
  return `$${dollars.toLocaleString()}`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

const ENTITY_TYPE_LABEL: Record<string, string> = {
  individual:            "Individual",
  pac:                   "PAC",
  super_pac:             "Super PAC",
  corporation:           "Corporation",
  union:                 "Union",
  party_committee:       "Party Committee",
  small_donor_aggregate: "Small-donor Aggregate",
  tribal:                "Tribal Entity",
  "527":                 "527 Organization",
  organization:          "Organization",
  other:                 "Other",
};

const ENTITY_TYPE_BADGE: Record<string, string> = {
  individual:      "bg-green-ink/10 text-green-ink",
  pac:             "bg-accent/10 text-accent",
  super_pac:       "bg-viz-7/10 text-viz-7",
  corporation:     "bg-amber/20 text-ink",
  union:           "bg-amber/20 text-ink",
  party_committee: "bg-civic-blue/10 text-civic-blue",
};

const PARTY_BADGE: Record<string, string> = {
  democrat:    "bg-civic-blue/10 text-civic-blue",
  republican:  "bg-accent/10 text-accent",
  independent: "bg-viz-7/10 text-viz-7",
};

// React.cache() dedupes the entity fetch between generateMetadata and the
// page render — same pattern as getCachedOfficial.
const getCachedDonor = cache(async (id: string): Promise<Entity | null> => {
  const supabase = createPublicClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;
  const { data } = (await withDbTimeout(
    sb
      .from("financial_entities")
      .select(
        "id, display_name, canonical_name, entity_type, fec_committee_id, parent_entity_id, total_donated_cents, total_received_cents, total_contract_cents, total_grant_cents, total_ie_support_cents, total_ie_oppose_cents, donor_fingerprint, metadata, is_synthetic"
      )
      .eq("id", id)
      .maybeSingle(),
    3000,
    "donors:entity"
  )) as DbRes;
  if (!data) return null;
  const attribution = await fetchAttributionForEntity(supabase, "financial_entity", id);
  return { ...(data as Omit<Entity, "attribution">), attribution };
});

export async function generateMetadata(
  { params }: { params: { id: string } }
): Promise<Metadata> {
  const entity = await getCachedDonor(params.id);
  if (!entity) return { title: "Donor | Civitics" };

  const typeLabel = ENTITY_TYPE_LABEL[entity.entity_type] ?? entity.entity_type;
  const description = `${typeLabel} · ${formatMoney(entity.total_donated_cents)} donated · ${formatMoney(entity.total_received_cents)} received`;

  return {
    title: `${entity.display_name} | Civitics`,
    description,
    openGraph: {
      title: `${entity.display_name} | Civitics`,
      description,
    },
  };
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function DonorProfilePage({
  params,
}: {
  params: { id: string };
}) {
  const supabase = createPublicClient();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sb = supabase as any;

  const entity = await getCachedDonor(params.id);
  if (!entity) {
    notFound();
  }

  // Parallel fetches: outbound donations, inbound donations, contracts/grants
  // received, AI summary, industry tag, parent entity name.
  const [outboundRes, inboundRes, spendingRes, aiSummaryRes, recipientCountRes, donorCountRes, ieRes] =
    (await Promise.all([
      withDbTimeout(
        sb.from("financial_relationships")
          .select("id, from_type, from_id, to_type, to_id, amount_cents, occurred_at, cycle_year, relationship_type, metadata")
          .eq("from_type", "financial_entity")
          .eq("from_id", entity.id)
          .eq("relationship_type", "donation")
          .order("amount_cents", { ascending: false })
          .limit(1000),
        3000,
        "donors:outbound"
      ),
      withDbTimeout(
        sb.from("financial_relationships")
          .select("id, from_type, from_id, to_type, to_id, amount_cents, occurred_at, cycle_year, relationship_type, metadata")
          .eq("to_type", "financial_entity")
          .eq("to_id", entity.id)
          .eq("relationship_type", "donation")
          .order("amount_cents", { ascending: false })
          .limit(1000),
        3000,
        "donors:inbound"
      ),
      withDbTimeout(
        sb.from("financial_relationships")
          .select("id, from_type, from_id, to_type, to_id, amount_cents, occurred_at, cycle_year, relationship_type, metadata")
          .eq("to_type", "financial_entity")
          .eq("to_id", entity.id)
          .in("relationship_type", ["contract", "grant"])
          .order("amount_cents", { ascending: false })
          .limit(50),
        3000,
        "donors:spending"
      ),
      withDbTimeout(
        sb.from("ai_summary_cache")
          .select("summary_text")
          .eq("entity_id", entity.id)
          .eq("entity_type", "financial")
          .eq("summary_type", "profile")
          .maybeSingle(),
        3000,
        "donors:ai-summary"
      ),
      withDbTimeout(
        sb.from("financial_relationships")
          .select("to_id", { count: "exact", head: true })
          .eq("from_type", "financial_entity")
          .eq("from_id", entity.id)
          .eq("relationship_type", "donation"),
        3000,
        "donors:recipient-count"
      ),
      withDbTimeout(
        sb.from("financial_relationships")
          .select("from_id", { count: "exact", head: true })
          .eq("to_type", "financial_entity")
          .eq("to_id", entity.id)
          .eq("relationship_type", "donation"),
        3000,
        "donors:donor-count"
      ),
      // FIX-666/FIX-668: outbound Schedule E independent expenditures. IE rows
      // are from_type='financial_entity' → to_type='official' with
      // relationship_type ie_support / ie_oppose. One combined fetch (mirrors
      // the contracts+grants .in() fetch above); split by direction in code.
      withDbTimeout(
        sb.from("financial_relationships")
          .select("id, from_type, from_id, to_type, to_id, amount_cents, occurred_at, cycle_year, relationship_type, metadata")
          .eq("from_type", "financial_entity")
          .eq("from_id", entity.id)
          .in("relationship_type", ["ie_support", "ie_oppose"])
          .order("amount_cents", { ascending: false })
          .limit(500),
        3000,
        "donors:ie"
      ),
    ])) as [DbRes, DbRes, DbRes, DbRes, DbRes, DbRes, DbRes];

  const outbound = (outboundRes.data ?? []) as Relationship[];
  const inbound = (inboundRes.data ?? []) as Relationship[];
  const spending = (spendingRes.data ?? []) as Relationship[];
  const ieRows = (ieRes.data ?? []) as Relationship[];

  // Industry tag for this donor.
  const industryMap = await fetchIndustryTagsByEntityId(supabase, [entity.id]);
  const industry = industryMap.get(entity.id)?.display_label ?? null;

  // Parent entity (if subsidiary) — single lookup.
  let parentName: string | null = null;
  if (entity.parent_entity_id) {
    const { data: parentRow } = (await withDbTimeout(
      sb
        .from("financial_entities")
        .select("id, display_name")
        .eq("id", entity.parent_entity_id)
        .maybeSingle(),
      3000,
      "donors:parent"
    )) as DbRes;
    parentName = parentRow?.display_name ?? null;
  }

  // ── Enrich recipients (outbound donations) ────────────────────────────────
  // IE targets are also officials — fold their ids into the same lookup so the
  // ie support/oppose section (below) resolves names from one officials fetch.
  const officialIds = [...new Set([
    ...outbound.filter((r) => r.to_type === "official").map((r) => r.to_id),
    ...ieRows.filter((r) => r.to_type === "official").map((r) => r.to_id),
  ])];
  const recipientEntityIds = [...new Set(outbound.filter((r) => r.to_type === "financial_entity").map((r) => r.to_id))];

  const officialInfo = new Map<string, { full_name: string; role_title: string; party: string | null }>();
  if (officialIds.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < officialIds.length; i += BATCH) {
      const batch = officialIds.slice(i, i + BATCH);
      const { data } = (await withDbTimeout(
        sb
          .from("officials")
          .select("id, full_name, role_title, party")
          .in("id", batch),
        3000,
        "donors:recipient-officials"
      )) as DbRes;
      for (const o of data ?? []) {
        officialInfo.set(o.id, {
          full_name:  o.full_name,
          role_title: o.role_title,
          party:      o.party ?? null,
        });
      }
    }
  }

  const recipientEntityInfo = new Map<string, { display_name: string; entity_type: string }>();
  if (recipientEntityIds.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < recipientEntityIds.length; i += BATCH) {
      const batch = recipientEntityIds.slice(i, i + BATCH);
      const { data } = (await withDbTimeout(
        sb
          .from("financial_entities")
          .select("id, display_name, entity_type")
          .in("id", batch),
        3000,
        "donors:recipient-entities"
      )) as DbRes;
      for (const e of data ?? []) {
        recipientEntityInfo.set(e.id, {
          display_name: e.display_name,
          entity_type:  e.entity_type,
        });
      }
    }
  }

  // Aggregate recipients by to_id.
  const recipientMap = new Map<string, RecipientRow>();
  for (const r of outbound) {
    const key = r.to_id;
    const existing = recipientMap.get(key);
    if (existing) {
      existing.total_cents += r.amount_cents ?? 0;
      existing.count += 1;
      if (r.cycle_year) existing.cycles.add(r.cycle_year);
    } else {
      let name = "Unknown";
      let subtitle: string | null = null;
      let party: string | null = null;
      let href: string | null = null;
      if (r.to_type === "official") {
        const info = officialInfo.get(r.to_id);
        if (info) {
          name = info.full_name;
          subtitle = info.role_title;
          party = info.party;
          href = `/officials/${r.to_id}`;
        }
      } else if (r.to_type === "financial_entity") {
        const info = recipientEntityInfo.get(r.to_id);
        if (info) {
          name = info.display_name;
          subtitle = ENTITY_TYPE_LABEL[info.entity_type] ?? info.entity_type;
          href = `/donors/${r.to_id}`;
        }
      }
      recipientMap.set(key, {
        id: r.to_id,
        to_type: r.to_type,
        name,
        subtitle,
        party,
        total_cents: r.amount_cents ?? 0,
        count: 1,
        cycles: new Set(r.cycle_year ? [r.cycle_year] : []),
        href,
      });
    }
  }
  const recipients = [...recipientMap.values()].sort((a, b) => b.total_cents - a.total_cents);
  const topRecipients = recipients.slice(0, 50);

  // ── Aggregate independent expenditures by (target × direction) (FIX-668) ──
  const ieTargetMap = new Map<string, IeTargetRow>();
  for (const r of ieRows) {
    const direction: IeTargetRow["direction"] =
      r.relationship_type === "ie_oppose" ? "oppose" : "support";
    const key = `${r.to_id}|${direction}`;
    const existing = ieTargetMap.get(key);
    if (existing) {
      existing.total_cents += r.amount_cents ?? 0;
      existing.count += 1;
    } else {
      const info = officialInfo.get(r.to_id);
      ieTargetMap.set(key, {
        id: r.to_id,
        name: info?.full_name ?? "Unknown",
        subtitle: info?.role_title ?? null,
        party: info?.party ?? null,
        href: info ? `/officials/${r.to_id}` : null,
        direction,
        total_cents: r.amount_cents ?? 0,
        count: 1,
      });
    }
  }
  const ieTargets = [...ieTargetMap.values()].sort((a, b) => b.total_cents - a.total_cents);

  // ── Enrich donors (inbound donations) ──────────────────────────────────────
  const inboundDonorIds = [...new Set(inbound.map((r) => r.from_id))];
  const donorEntityInfo = new Map<string, { display_name: string; entity_type: string }>();
  if (inboundDonorIds.length > 0) {
    const BATCH = 200;
    for (let i = 0; i < inboundDonorIds.length; i += BATCH) {
      const batch = inboundDonorIds.slice(i, i + BATCH);
      const { data } = (await withDbTimeout(
        sb
          .from("financial_entities")
          .select("id, display_name, entity_type")
          .in("id", batch),
        3000,
        "donors:inbound-donor-entities"
      )) as DbRes;
      for (const e of data ?? []) {
        donorEntityInfo.set(e.id, {
          display_name: e.display_name,
          entity_type:  e.entity_type,
        });
      }
    }
  }
  const donorIndustryMap = await fetchIndustryTagsByEntityId(supabase, inboundDonorIds);

  const donorMap = new Map<string, DonorRow>();
  for (const r of inbound) {
    const existing = donorMap.get(r.from_id);
    if (existing) {
      existing.total_cents += r.amount_cents ?? 0;
      existing.count += 1;
    } else {
      const info = donorEntityInfo.get(r.from_id);
      donorMap.set(r.from_id, {
        id: r.from_id,
        name: info?.display_name ?? "Unknown",
        industry: donorIndustryMap.get(r.from_id)?.display_label ?? null,
        donor_type: info?.entity_type ?? "other",
        total_cents: r.amount_cents ?? 0,
        count: 1,
      });
    }
  }
  const topDonors = [...donorMap.values()]
    .sort((a, b) => b.total_cents - a.total_cents)
    .slice(0, 50);

  // ── Enrich spending awards (contracts + grants received) ──────────────────
  const agencyIds = [...new Set(spending.map((r) => r.from_id))];
  const agencyName = new Map<string, string>();
  if (agencyIds.length > 0) {
    const { data } = (await withDbTimeout(
      sb
        .from("agencies")
        .select("id, name")
        .in("id", agencyIds),
      3000,
      "donors:agencies"
    )) as DbRes;
    for (const a of data ?? []) agencyName.set(a.id, a.name);
  }
  const spendingRows: SpendingRow[] = spending.map((r) => ({
    id:           r.id,
    agency_name:  agencyName.get(r.from_id) ?? "Unknown agency",
    award_type:   r.relationship_type,
    amount_cents: r.amount_cents ?? 0,
    occurred_at:  r.occurred_at,
    description:  ((r.metadata ?? {}) as Record<string, string>)?.description ?? null,
  }));

  // ── Aggregates for the header stat grid ────────────────────────────────────
  const cycleSet = new Set<number>();
  for (const r of outbound) if (r.cycle_year) cycleSet.add(r.cycle_year);
  for (const r of inbound)  if (r.cycle_year) cycleSet.add(r.cycle_year);
  const cyclesActive = cycleSet.size;

  const totalSpendingCents = (entity.total_contract_cents ?? 0) + (entity.total_grant_cents ?? 0);
  // FIX-668: materialized Schedule E totals drive the stat cell + section gate.
  const ieSupportCents = entity.total_ie_support_cents ?? 0;
  const ieOpposeCents  = entity.total_ie_oppose_cents ?? 0;
  const totalIeCents   = ieSupportCents + ieOpposeCents;
  const showIe         = totalIeCents > 0;
  const recipientTxCount = recipientCountRes.count ?? 0;
  const donorTxCount = donorCountRes.count ?? 0;
  const uniqueRecipients = recipients.length;
  const uniqueDonors = donorMap.size;
  const cachedAiSummary: string | null = aiSummaryRes?.data?.summary_text ?? null;

  const typeLabel = ENTITY_TYPE_LABEL[entity.entity_type] ?? entity.entity_type;
  const typeBadgeCls = ENTITY_TYPE_BADGE[entity.entity_type] ?? "bg-paper-2 text-ink-soft";

  const isIndividual = entity.entity_type === "individual";
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "https://civitics.com";
  const donorJsonLd = {
    "@context": "https://schema.org",
    "@type": isIndividual ? "Person" : "Organization",
    name: entity.display_name,
    url: `${baseUrl}/donors/${entity.id}`,
    description: `${typeLabel} · ${formatMoney(entity.total_donated_cents)} donated`,
  };

  return (
    <div className="min-h-screen bg-paper-2">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(donorJsonLd) }}
      />
      {/* FIX-398: attribution payload embedded for the FIX-399 SourceBadge
          hydration hook. Not visually rendered. */}
      <script
        type="application/json"
        data-civitics-attribution="financial_entity"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(entity.attribution) }}
      />
      <PageViewTracker entityType="financial" entityId={entity.id} />

      <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        {/* ── HEADER ─────────────────────────────────────────────────────── */}
        <div className="border border-rule bg-card overflow-hidden">
          <div className="p-6">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-5">
              {/* Dollar-sign avatar */}
              <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-full border-2 border-rule bg-green-ink/10 text-green-ink">
                <svg className="h-10 w-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>

              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-1">
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${typeBadgeCls}`}>
                    {typeLabel}
                  </span>
                  {industry && (
                    <span className="rounded-full px-2.5 py-0.5 text-xs font-medium bg-paper-2 text-ink-soft">
                      {industry}
                    </span>
                  )}
                  {entity.fec_committee_id && (
                    <span className="rounded border border-rule px-1.5 py-0.5 font-mono text-[10px] text-ink-soft/70">
                      FEC {entity.fec_committee_id}
                    </span>
                  )}
                  <SourceDetailPopover
                    entityType="financial_entity"
                    entityId={entity.id}
                    attribution={entity.attribution}
                  >
                    <SourceBadge attribution={entity.attribution} />
                  </SourceDetailPopover>
                </div>

                <h1 className="text-2xl font-bold text-ink leading-tight">
                  {entity.display_name}
                  {entity.is_synthetic && <SyntheticMark withIcon className="ml-2 align-middle" />}
                </h1>
                {parentName && (
                  <p className="mt-0.5 text-sm text-ink-soft/70">
                    Subsidiary of{" "}
                    <a
                      href={`/donors/${entity.parent_entity_id}`}
                      className="text-accent hover:underline"
                    >
                      {parentName}
                    </a>
                  </p>
                )}

                <div className="mt-4 flex flex-wrap gap-2">
                  <a
                    href={`/graph?entity=${entity.id}`}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent transition-colors"
                  >
                    <span>◎</span>
                    View in Graph
                  </a>
                  <ShareButton
                    name={entity.display_name}
                    url={`/donors/${entity.id}`}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Quick stats */}
          <div className={`grid grid-cols-2 gap-px border-t border-rule bg-rule/40 ${showIe ? "sm:grid-cols-6" : "sm:grid-cols-5"}`}>
            <StatCell value={formatMoney(entity.total_donated_cents)} label="Total donated" />
            <StatCell value={formatMoney(entity.total_received_cents)} label="Total received" />
            {showIe && (
              <StatCell
                value={formatMoney(totalIeCents)}
                label="Ind. expenditures"
                note={`${formatMoney(ieSupportCents)} support · ${formatMoney(ieOpposeCents)} oppose`}
              />
            )}
            <StatCell
              value={totalSpendingCents > 0 ? formatMoney(totalSpendingCents) : "—"}
              label="Federal spending"
              note={totalSpendingCents > 0 ? "contracts + grants" : undefined}
            />
            <StatCell
              value={uniqueRecipients.toLocaleString()}
              label="Recipients"
              note={recipientTxCount > 0 ? `${recipientTxCount.toLocaleString()} transactions` : undefined}
            />
            <StatCell
              value={uniqueDonors.toLocaleString()}
              label="Donors"
              note={
                donorTxCount > 0
                  ? `${donorTxCount.toLocaleString()} transactions`
                  : cyclesActive > 0
                    ? `${cyclesActive} cycle${cyclesActive === 1 ? "" : "s"}`
                    : undefined
              }
            />
          </div>
        </div>

        {/* AI summary */}
        {cachedAiSummary && (
          <div className="mt-6 rounded-md border border-accent bg-accent/10 px-4 py-3">
            <p className="text-sm text-ink-soft leading-relaxed">{cachedAiSummary}</p>
            <p className="mt-1.5 text-[10px] text-accent">Civic profile · AI generated</p>
          </div>
        )}

        {/* ── RECIPIENTS ─────────────────────────────────────────────────── */}
        <div className="mt-6 border border-rule bg-card overflow-hidden">
          <div className="px-5 py-4 border-b border-rule flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-ink">Top recipients</h2>
              <p className="text-xs text-ink-soft/70 mt-0.5">
                Where this {typeLabel.toLowerCase()}&apos;s donations went
              </p>
            </div>
            {recipients.length > topRecipients.length && (
              <span className="text-[10px] text-ink-soft/70">
                Showing top {topRecipients.length} of {recipients.length} unique
              </span>
            )}
          </div>
          {topRecipients.length === 0 ? (
            <div className="px-5 py-8 text-center">
              {showIe ? (
                /* FIX-676: an IE-only super PAC legally makes no direct
                   candidate contributions — the empty list is correct, so
                   explain the structure rather than implying missing data. */
                <p className="mx-auto max-w-md text-sm text-ink-soft/70">
                  Independent-expenditure-only committee (super PAC) — by law it spends
                  to support or oppose candidates rather than contributing to them
                  directly. See Independent expenditures below.
                </p>
              ) : (
                <p className="text-sm font-medium text-ink-soft/70">No outbound donations on record</p>
              )}
            </div>
          ) : (
            <div className="divide-y divide-rule">
              {topRecipients.map((r, i) => {
                const partyCls = r.party ? PARTY_BADGE[r.party] : undefined;
                const cycles = [...r.cycles].sort();
                const cycleLabel = cycles.length === 0
                  ? null
                  : cycles.length === 1
                    ? `${cycles[0]}`
                    : `${cycles[0]}–${cycles[cycles.length - 1]}`;
                return (
                  <div key={r.id} className="flex items-center gap-3 px-5 py-3">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-paper-2 text-[10px] font-bold text-ink-soft/70">
                      {i + 1}
                    </span>
                    <div className="flex-1 min-w-0">
                      {r.href ? (
                        <a
                          href={r.href}
                          className="truncate text-xs font-medium text-ink-soft hover:text-accent hover:underline transition-colors block"
                        >
                          {r.name}
                        </a>
                      ) : (
                        <p className="truncate text-xs font-medium text-ink-soft">{r.name}</p>
                      )}
                      <p className="truncate text-[10px] text-ink-soft/70">
                        {r.subtitle ?? r.to_type.replace(/_/g, " ")}
                        {cycleLabel ? ` · ${cycleLabel}` : ""}
                      </p>
                    </div>
                    {partyCls && r.party && r.party.length > 0 && (
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${partyCls}`}>
                        {r.party.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <div className="shrink-0 text-right">
                      <p className="text-xs font-semibold text-ink">{formatMoney(r.total_cents)}</p>
                      <p className="text-[10px] text-ink-soft/70">
                        {r.count} transaction{r.count === 1 ? "" : "s"}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── INDEPENDENT EXPENDITURES (Schedule E) ─────────────────────── */}
        {showIe && (
          <div className="mt-6 border border-rule bg-card overflow-hidden">
            <div className="px-5 py-4 border-b border-rule flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold text-ink">Independent expenditures</h2>
                <p className="text-xs text-ink-soft/70 mt-0.5">
                  Schedule E spending to support or oppose candidates — not coordinated with any campaign
                </p>
              </div>
              <span className="text-[10px] text-ink-soft/70">
                {formatMoney(ieSupportCents)} support · {formatMoney(ieOpposeCents)} oppose
              </span>
            </div>
            {ieTargets.length === 0 ? (
              <div className="px-5 py-8 text-center">
                <p className="text-sm font-medium text-ink-soft/70">
                  No itemized independent-expenditure targets on record
                </p>
              </div>
            ) : (
              <div className="divide-y divide-rule">
                {ieTargets.map((t, i) => {
                  const partyCls = t.party ? PARTY_BADGE[t.party] : undefined;
                  const isOppose = t.direction === "oppose";
                  return (
                    <div key={`${t.id}-${t.direction}`} className="flex items-center gap-3 px-5 py-3">
                      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-paper-2 text-[10px] font-bold text-ink-soft/70">
                        {i + 1}
                      </span>
                      <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                        isOppose ? "bg-accent/10 text-accent" : "bg-green-ink/10 text-green-ink"
                      }`}>
                        {isOppose ? "Opposes" : "Supports"}
                      </span>
                      <div className="flex-1 min-w-0">
                        {t.href ? (
                          <a
                            href={t.href}
                            className="truncate text-xs font-medium text-ink-soft hover:text-accent hover:underline transition-colors block"
                          >
                            {t.name}
                          </a>
                        ) : (
                          <p className="truncate text-xs font-medium text-ink-soft">{t.name}</p>
                        )}
                        {t.subtitle && (
                          <p className="truncate text-[10px] text-ink-soft/70">{t.subtitle}</p>
                        )}
                      </div>
                      {partyCls && t.party && t.party.length > 0 && (
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${partyCls}`}>
                          {t.party.charAt(0).toUpperCase()}
                        </span>
                      )}
                      <div className="shrink-0 text-right">
                        <p className="text-xs font-semibold text-ink">{formatMoney(t.total_cents)}</p>
                        <p className="text-[10px] text-ink-soft/70">
                          {t.count} transaction{t.count === 1 ? "" : "s"}
                        </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ── TOP DONORS (inbound) ───────────────────────────────────────── */}
        {topDonors.length > 0 && (
          <div className="mt-6 border border-rule bg-card overflow-hidden">
            <div className="px-5 py-4 border-b border-rule">
              <h2 className="text-sm font-semibold text-ink">Top donors</h2>
              <p className="text-xs text-ink-soft/70 mt-0.5">
                Who funded this {typeLabel.toLowerCase()}
              </p>
            </div>
            <div className="divide-y divide-rule">
              {topDonors.map((d, i) => (
                <div key={d.id} className="flex items-center gap-3 px-5 py-3">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-paper-2 text-[10px] font-bold text-ink-soft/70">
                    {i + 1}
                  </span>
                  <div className="flex-1 min-w-0">
                    <a
                      href={`/donors/${d.id}`}
                      className="truncate text-xs font-medium text-ink-soft hover:text-accent hover:underline transition-colors block"
                    >
                      {d.name}
                    </a>
                    <p className="truncate text-[10px] text-ink-soft/70">
                      {ENTITY_TYPE_LABEL[d.donor_type] ?? d.donor_type}
                      {d.industry ? ` · ${d.industry}` : ""}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs font-semibold text-ink">{formatMoney(d.total_cents)}</p>
                    <p className="text-[10px] text-ink-soft/70">
                      {d.count} transaction{d.count === 1 ? "" : "s"}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── FEDERAL SPENDING (contracts + grants received) ────────────── */}
        {spendingRows.length > 0 && (
          <div className="mt-6 border border-rule bg-card overflow-hidden">
            <div className="px-5 py-4 border-b border-rule">
              <h2 className="text-sm font-semibold text-ink">Federal spending awards</h2>
              <p className="text-xs text-ink-soft/70 mt-0.5">
                Government contracts and grants received
              </p>
            </div>
            <div className="divide-y divide-rule">
              {spendingRows.map((s) => (
                <div key={s.id} className="flex items-center gap-3 px-5 py-3">
                  <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ${
                    s.award_type === "contract"
                      ? "bg-civic-blue/10 text-civic-blue"
                      : "bg-green-ink/10 text-green-ink"
                  }`}>
                    {s.award_type}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-xs font-medium text-ink-soft">{s.agency_name}</p>
                    {s.description && (
                      <p className="truncate text-[10px] text-ink-soft/70">{s.description}</p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs font-semibold text-ink">{formatMoney(s.amount_cents)}</p>
                    <p className="text-[10px] text-ink-soft/70">{formatDate(s.occurred_at)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </main>

      <footer className="mt-16 border-t border-rule bg-card">
        <div className="mx-auto max-w-5xl px-4 py-6 sm:px-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-ink-soft/70">
              Civitics — open civic infrastructure. Beta · All data is public record.
            </p>
            <a href="/search?type=financial" className="text-xs text-ink-soft/70 hover:text-accent transition-colors">
              ← Back to donors &amp; PACs
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}

function StatCell({
  value,
  label,
  note,
}: {
  value: string;
  label: string;
  note?: string;
}) {
  return (
    <div className="bg-card px-4 py-3 text-center">
      <p className="text-lg font-bold text-ink">{value}</p>
      <p className="mt-0.5 text-[10px] text-ink-soft/70">{label}</p>
      {note && <p className="text-[9px] text-ink-soft/70">{note}</p>}
    </div>
  );
}
