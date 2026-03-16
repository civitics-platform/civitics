import { createAdminClient } from "@civitics/db";

export const dynamic = "force-dynamic";

// graph_snapshots was created after the Database type was generated.
// TODO: run `supabase gen types typescript` to regenerate packages/db/src/types/database.ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyClient = ReturnType<typeof createAdminClient> & { from(table: string): any; rpc(fn: string, args?: Record<string, unknown>): any };
import { GraphPage } from "../GraphPage";
import type { Metadata } from "next";

interface Props {
  params: { code: string };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return {
    title: `Graph ${params.code}`,
    description: `Shared connection graph: ${params.code}`,
    openGraph: {
      title: `Civitics Connection Graph — ${params.code}`,
      description: "Explore connections between officials, agencies, and legislation.",
    },
  };
}

export default async function SharedGraphPage({ params }: Props) {
  const code = params.code.toUpperCase();

  // Validate format: CIV-XXXX-XXXX
  if (!/^CIV-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    return <InvalidCode code={code} />;
  }

  const supabase = createAdminClient() as AnyClient;
  const { data } = await supabase
    .from("graph_snapshots")
    .select("code, state, title, created_at")
    .eq("code", code)
    .maybeSingle();

  if (!data) {
    return <InvalidCode code={code} />;
  }

  // Increment view count (fire-and-forget)
  supabase.rpc("increment_snapshot_view", { p_code: code }).then(() => {}).catch(() => {});

  return (
    <GraphPage
      initialCode={code}
      initialState={data.state as Record<string, unknown>}
    />
  );
}

function InvalidCode({ code }: { code: string }) {
  return (
    <main className="min-h-screen bg-gray-950 flex items-center justify-center">
      <div className="text-center">
        <p className="text-gray-400 text-sm mb-1">Share code not found</p>
        <p className="text-gray-600 text-xs font-mono mb-6">{code}</p>
        <a
          href="/graph"
          className="px-4 py-2 text-xs font-medium rounded bg-gray-800 hover:bg-gray-700 text-gray-300 hover:text-white transition-colors"
        >
          ← Open Connection Graph
        </a>
      </div>
    </main>
  );
}
