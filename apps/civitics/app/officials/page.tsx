// Public read-only page; no auth dependency. ISR-eligible: searchParams
// only contain the optional `selected` id, so most visitors hit the same
// cached render. 5-min window matches the rest of the public surface.
export const revalidate = 300;

import { createPublicClient } from "@civitics/db";
import { OfficialsList } from "./components/OfficialsList";
import { PageViewTracker } from "../components/PageViewTracker";
import { PageHeader } from "@civitics/ui";
import type { EntityTag } from "../components/tags/EntityTags";

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

  let officialsQuery = supabase
    .from("officials")
    .select(
      `id, full_name, first_name, last_name, role_title, party,
       photo_url, district_name, term_start, term_end, is_active, source_ids,
       jurisdictions!jurisdiction_id(name),
       governing_bodies!governing_body_id(short_name, type)`
    );
  if (!includeFormer) officialsQuery = officialsQuery.eq("is_active", true);

  const { data, error } = await officialsQuery.order("last_name");

  if (error) console.error("officials fetch error:", error.message);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const officials: OfficialRow[] = (data ?? []).map((o: any) => ({
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
  }));

  // Pre-fetch tags for all officials
  if (officials.length > 0) {
    const officialIds = officials.map((o) => o.id);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sbAny = supabase as any;
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
