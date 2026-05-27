import { cache } from "react";
import { createPublicClient, fetchAttributionForEntity, type AttributionShape } from "@civitics/db";

// React.cache() dedupes within a single request. generateMetadata() and the
// page component both fetch the official row; without this wrapper, that's
// two identical Supabase round-trips per page render. Keep the column list
// the union of what either caller needs so the cache hit is always a hit.
//
// Uses createPublicClient (publishable key, RLS-respecting anon role) instead
// of createAdminClient. The data is already public-readable per RLS, and
// createAdminClient would force the page off real ISR — its secret key
// isn't available at build time, so any page calling it must be
// force-dynamic. The whole point of FIX-203 is to let these pages cache.

export type CachedOfficial = {
  id: string;
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  role_title: string;
  party: string | null;
  photo_url: string | null;
  email: string | null;
  website_url: string | null;
  phone: string | null;
  district_name: string | null;
  term_start: string | null;
  term_end: string | null;
  is_active: boolean;
  tier: string | null;
  jurisdiction_id: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  jurisdictions: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  governing_bodies: any;
  attribution: AttributionShape;
};

export const getCachedOfficial = cache(
  async (id: string): Promise<CachedOfficial | null> => {
    const supabase = createPublicClient();
    const { data } = await supabase
      .from("officials")
      .select(
        "id, full_name, first_name, last_name, role_title, party, photo_url, email, website_url, phone, district_name, term_start, term_end, is_active, tier, jurisdiction_id, jurisdictions!jurisdiction_id(name), governing_bodies!governing_body_id(short_name)"
      )
      .eq("id", id)
      .single();
    if (!data) return null;
    const attribution = await fetchAttributionForEntity(supabase, "official", id);
    return { ...(data as Omit<CachedOfficial, "attribution">), attribution };
  }
);
