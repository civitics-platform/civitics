import { createAdminClient } from "@civitics/db";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";
  if (q.length < 2) return Response.json([]);

  const supabase = createAdminClient();
  const pattern = `%${q}%`;

  const [officialsRes, agenciesRes, proposalsRes] = await Promise.all([
    supabase
      .from("officials")
      .select("id, full_name, role_title, party, metadata")
      .ilike("full_name", pattern)
      .limit(5),
    supabase
      .from("agencies")
      .select("id, name, acronym")
      .or(`name.ilike.${pattern},acronym.ilike.${pattern}`)
      .limit(3),
    supabase
      .from("proposals")
      .select("id, title, status")
      .ilike("title", pattern)
      .limit(3),
  ]);

  const results = [
    ...(officialsRes.data ?? []).map((o: { id: string; full_name: string; role_title: string | null; party: string | null; metadata: unknown }) => ({
      id: o.id,
      label: o.full_name,
      type: "official" as const,
      subtitle: [(o.metadata as Record<string, unknown> | null)?.state, o.role_title]
        .filter(Boolean)
        .join(" · ") || undefined,
      party: o.party ?? undefined,
    })),
    ...(agenciesRes.data ?? []).map((a: { id: string; name: string; acronym: string | null }) => ({
      id: a.id,
      label: a.name,
      type: "agency" as const,
      subtitle: a.acronym ?? undefined,
    })),
    ...(proposalsRes.data ?? []).map((p: { id: string; title: string; status: string | null }) => ({
      id: p.id,
      label: p.title,
      type: "proposal" as const,
      subtitle: p.status ?? undefined,
    })),
  ];

  return Response.json(results);
}
