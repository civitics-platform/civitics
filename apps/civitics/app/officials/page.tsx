// Public read-only page; no auth dependency. ISR-eligible: searchParams
// only contain the optional `selected` id, so most visitors hit the same
// cached render. 5-min window matches the rest of the public surface.
export const revalidate = 300;

import { createPublicClient } from "@civitics/db";
import { OfficialsList } from "./components/OfficialsList";
import { PageViewTracker } from "../components/PageViewTracker";
import { PageHeader } from "@civitics/ui";
import type { EntityTag } from "../components/tags/EntityTags";
import {
  fetchEngagementRollup,
  EMPTY_ENGAGEMENT,
  type EngagementRollup,
} from "../lib/engagement";

export const metadata = { title: "Officials" };

export type OfficialRow = {
  id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  role_title: string;
  party: string | null;
  photo_url: string | null;
  district_name: string | null;
  term_start: string | null;
  term_end: string | null;
  is_active: boolean | null;
  state_name: string | null;
  chamber: string | null;
  chamber_type: string | null;
  tags?: EntityTag[];
  source_ids: Record<string, string>;
  is_synthetic?: boolean;
  // FIX-618: DISPLAY-ONLY engagement rollup (claimed/engaged/active-community).
  // Attached server-side so the client "Most engaged" sort can order the full set.
  engagement?: EngagementRollup;
};

export default async function OfficialsPage({
  searchParams,
}: {
  searchParams: { selected?: string; status?: string };
}) {
  const supabase = createPublicClient();
  // FIX-457: default active only; ?status=all opts into former/inactive officials
  // (now anon-visible after the FIX-456 gate relax). Note: the directory is capped
  // at PostgREST's 1000-row default, so "Include former" shows the first 1000 by
  // last name — a UX guard, not an exhaustive former-officials browser.
  const includeFormer = searchParams.status === "all";

  const OFFICIAL_SELECT =
    `id, full_name, first_name, last_name, role_title, party,
     photo_url, district_name, term_start, term_end, is_active, source_ids, is_synthetic,
     jurisdictions!jurisdiction_id(name),
     governing_bodies!governing_body_id(short_name, type)`;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapOfficial = (o: any): OfficialRow => ({
    id: o.id,
    full_name: o.full_name,
    first_name: o.first_name ?? null,
    last_name: o.last_name ?? null,
    role_title: o.role_title,
    party: o.party ?? null,
    photo_url: o.photo_url ?? null,
    district_name: o.district_name ?? null,
    term_start: o.term_start ?? null,
    term_end: o.term_end ?? null,
    is_active: o.is_active ?? null,
    state_name: o.jurisdictions?.name ?? null,
    chamber: o.governing_bodies?.short_name ?? null,
    chamber_type: o.governing_bodies?.type ?? null,
    tags: [],
    source_ids: o.source_ids ?? {},
    is_synthetic: o.is_synthetic ?? false,
  });

  let officialsQuery = supabase.from("officials").select(OFFICIAL_SELECT);
  if (!includeFormer) officialsQuery = officialsQuery.eq("is_active", true);

  const { data, error } = await officialsQuery.order("last_name");

  if (error) console.error("officials fetch error:", error.message);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const officials: OfficialRow[] = (data ?? []).map(mapOfficial);

  // FIX-619: the index loads only the first 1000 officials by last_name
  // (PostgREST's default cap; there are ~27k active officials). Officials that
  // carry an engagement signal — the whole point of the badges + "Most engaged"
  // sort — are sparse and almost always sort PAST that window (e.g. the synthetic
  // Franklin officials). A client-side sort can't order rows it never fetched, so
  // explicitly pull the (tiny) set of officials with a rollup row into the payload
  // when they aren't already present. Without this the sort is a no-op for exactly
  // the officials it exists to surface.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sbAny = supabase as any;
  const present = new Set(officials.map((o) => o.id));
  const { data: engagedIdRows } = await sbAny
    .from("entity_engagement_rollup_mv")
    .select("entity_id")
    .eq("entity_type", "official");
  const missingEngagedIds = ((engagedIdRows ?? []) as { entity_id: string }[])
    .map((r) => r.entity_id)
    .filter((id) => !present.has(id));
  if (missingEngagedIds.length > 0) {
    let extraQuery = supabase.from("officials").select(OFFICIAL_SELECT).in("id", missingEngagedIds);
    // Match the active/former view so "Active" doesn't surprise-show a former
    // official; an engaged former official appears only under ?status=all.
    if (!includeFormer) extraQuery = extraQuery.eq("is_active", true);
    const { data: extra } = await extraQuery;
    for (const o of (extra ?? []) as unknown[]) {
      officials.push(mapOfficial(o));
    }
  }

  // Pre-fetch tags for all officials
  if (officials.length > 0) {
    const officialIds = officials.map((o) => o.id);
    const { data: tagRows } = await sbAny
      .from("entity_tags")
      .select("entity_id,tag,tag_category,display_label,display_icon,visibility,confidence,generated_by,ai_model")
      .eq("entity_type", "official")
      .in("entity_id", officialIds);

    const tagsByOfficial: Record<string, EntityTag[]> = {};
    for (const t of tagRows ?? []) {
      const eid = t.entity_id as string;
      if (!tagsByOfficial[eid]) tagsByOfficial[eid] = [];
      tagsByOfficial[eid]!.push(t as EntityTag);
    }
    for (const o of officials) {
      o.tags = tagsByOfficial[o.id] ?? [];
    }

    // FIX-618: batch-fetch the display-only engagement rollup and attach it so
    // the client-side "Most engaged" sort + OfficialCard badges read from the
    // payload (same shape as the entity_tags batch above). Officials missing
    // from the MV fall back to EMPTY_ENGAGEMENT (no badges, sorts last).
    const engagement = await fetchEngagementRollup(supabase, "official", officialIds);
    for (const o of officials) {
      o.engagement = engagement.get(o.id) ?? EMPTY_ENGAGEMENT;
    }
  }

  return (
    <main id="main-content" className="min-h-screen bg-paper">
      <PageViewTracker entityType="official_list" />
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <PageHeader
          title="Officials"
          description="Every elected and appointed official — votes, donors, and promises on record."
          breadcrumb={[
            { label: "Civitics", href: "/" },
            { label: "Officials" },
          ]}
        />
      </div>
      <OfficialsList
        officials={officials}
        defaultSelectedId={searchParams.selected}
        includeFormer={includeFormer}
      />
    </main>
  );
}
