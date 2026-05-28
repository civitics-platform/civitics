// FIX-418: Stage 1 institution unification — /agencies/[slug] is now a
// permanent redirect to /institutions/<id>. The "slug" param has always
// been a UUID (the route never had a true slug column), so we pass it
// through after a single existence check. notFound on miss preserves
// the original 404 behavior for invalid UUIDs.
//
// permanentRedirect issues HTTP 308 — semantically equivalent to 301 for
// SEO (Google treats 308 the same as 301) and method-preserving.
import { notFound, permanentRedirect } from "next/navigation";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AgencyRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  if (!UUID_RE.test(slug)) notFound();

  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);

  const { data } = await supabase
    .from("agencies")
    .select("id")
    .eq("id", slug)
    .maybeSingle();

  if (!data?.id) notFound();

  permanentRedirect(`/institutions/${data.id}`);
}
