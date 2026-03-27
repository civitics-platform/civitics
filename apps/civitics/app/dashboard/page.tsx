export const dynamic = "force-dynamic";
export const revalidate = 0;

import { createAdminClient } from "@civitics/db";
import { PageHeader } from "@civitics/ui";
import nextDynamic from "next/dynamic";

const DashboardClient = nextDynamic(
  () => import("./DashboardClient").then((m) => ({ default: m.DashboardClient })),
  {
    ssr: false,
    loading: () => (
      <div className="space-y-6">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className="h-40 bg-white rounded-xl border border-gray-200 shadow-sm animate-pulse"
          />
        ))}
      </div>
    ),
  },
);
import { PageViewTracker } from "../components/PageViewTracker";

export const metadata = { title: "Platform Transparency | Civitics" };

// ── Server-side data fetching ─────────────────────────────────────────────────

type OpenProposal = {
  id: string;
  title: string;
  agency: string;
  comment_period_end: string;
};

type ActivityRow = {
  path: string;
  views: number;
};

async function getOpenProposals(): Promise<OpenProposal[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    const now = new Date().toISOString();
    const in30 = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const { data } = await db
      .from("proposals")
      .select("id,title,metadata,comment_period_end")
      .eq("status", "open_comment")
      .gt("comment_period_end", now)
      .lt("comment_period_end", in30)
      .order("comment_period_end", { ascending: true })
      .limit(3);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (data ?? []).map((p: any) => ({
      id: p.id as string,
      title: p.title as string,
      agency: (p.metadata?.agency_id as string | undefined) ?? "Federal Agency",
      comment_period_end: p.comment_period_end as string,
    }));
  } catch {
    return [];
  }
}

async function getActivity(): Promise<ActivityRow[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    const { data } = await db
      .from("page_views")
      .select("path")
      .gt("viewed_at", yesterday)
      .eq("is_bot", false)
      .not("path", "in", `("/","/dashboard")`)
      .limit(1000);
    // Aggregate manually
    const counts: Record<string, number> = {};
    for (const r of data ?? []) {
      const p = r.path as string;
      counts[p] = (counts[p] ?? 0) + 1;
    }
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([path, views]) => ({ path, views }));
  } catch {
    return [];
  }
}

async function getOfficialsBreakdown(): Promise<{
  federal: number;
  state: number;
  judges: number;
} | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = createAdminClient() as any;
    const { data } = await db
      .rpc("get_officials_breakdown")
      .catch(() => ({ data: null }));
    if (!data) return null;
    type Row = { category: string; count: number };
    const rows = data as Row[];
    const get = (cat: string) => rows.find((r) => r.category === cat)?.count ?? 0;
    return { federal: get("federal"), state: get("state"), judges: get("judges") };
  } catch {
    return null;
  }
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default async function DashboardPage() {
  const [openProposals, activity, officialsBreakdown] = await Promise.all([
    getOpenProposals(),
    getActivity(),
    getOfficialsBreakdown(),
  ]);

  return (
    <div className="min-h-screen bg-gray-50">
      <PageViewTracker entityType="dashboard" />
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <PageHeader
          title="Platform Transparency"
          description="Live data on what Civitics tracks, how pipelines are performing, and what the platform costs to run."
          breadcrumb={[
            { label: "Civitics", href: "/" },
            { label: "Transparency" },
          ]}
        />

        {/* FIX 2: The Receipt */}
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-6 mb-8">
          <p className="text-base font-semibold text-amber-900 mb-2">
            This page is our receipt.
          </p>
          <p className="text-sm text-amber-800 leading-relaxed">
            Every dollar spent building Civitics is tracked here. Every API call logged. Every cost
            visible. We hold ourselves to the same standard of transparency we demand from
            government.
          </p>
          <p className="text-sm text-amber-800 leading-relaxed mt-2">
            The platform earns no revenue from surveillance advertising. Official comment submission
            is always free. Blockchain is invisible.
          </p>
        </div>

        <DashboardClient
          openProposals={openProposals}
          activity={activity}
          officialsBreakdown={officialsBreakdown}
        />
      </div>
    </div>
  );
}
