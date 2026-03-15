export const dynamic = "force-dynamic";

import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { OfficialsList } from "./components/OfficialsList";

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
  state_name: string | null;
  chamber: string | null;
  chamber_type: string | null;
};

export default async function OfficialsPage({
  searchParams,
}: {
  searchParams: { selected?: string };
}) {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  const { data, error } = await supabase
    .from("officials")
    .select(
      `id, full_name, first_name, last_name, role_title, party,
       photo_url, district_name, term_start, term_end,
       jurisdictions!jurisdiction_id(name),
       governing_bodies!governing_body_id(short_name, type)`
    )
    .eq("is_active", true)
    .order("last_name");

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
    state_name: o.jurisdictions?.name ?? null,
    chamber: o.governing_bodies?.short_name ?? null,
    chamber_type: o.governing_bodies?.type ?? null,
  }));

  return (
    <OfficialsList
      officials={officials}
      defaultSelectedId={searchParams.selected}
    />
  );
}
