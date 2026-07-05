import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { PostProblemForm } from "./PostProblemForm";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Post a Problem | Civitics",
  description: "Describe a civic problem — no solution needed yet. The community can help develop one.",
};

export default async function PostProblemPage() {
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/sign-in?next=/initiatives/problem");
  }

  return (
    <div className="min-h-screen bg-paper-2">
      <main id="main-content" className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 text-sm text-ink-soft/70">
          <a href="/initiatives" className="hover:text-ink">Initiatives</a>
          <span>/</span>
          <span className="text-ink">Post a problem</span>
        </nav>

        {/* Header */}
        <div className="mb-8">
          <div className="mb-3 flex items-center gap-2">
            <span className="rounded-full border border-amber/60 bg-amber/20 px-2.5 py-0.5 text-xs font-semibold text-ink">
              Problem statement
            </span>
          </div>
          <h1 className="text-2xl font-bold text-ink">Post a problem</h1>
          <p className="mt-2 text-sm text-ink-soft/70 leading-relaxed">
            You don&apos;t need a solution to get started. Describe a civic problem you&apos;ve
            identified — the community can discuss it, validate it, and help develop proposals to
            address it. Problems can be turned into full initiatives when the time is right.
          </p>
        </div>

        {/* Contrast with full initiative */}
        <div className="mb-8 grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-lg border border-amber/60 bg-amber/20 p-3">
            <p className="font-semibold text-ink mb-1">Problem statement</p>
            <p className="text-ink-soft">Just the problem. No solution required. Community helps validate and develop next steps.</p>
          </div>
          <div className="rounded-lg border border-accent/25 bg-accent/10 p-3">
            <a href="/initiatives/new" className="block group">
              <p className="font-semibold text-accent mb-1 group-hover:underline">Full initiative →</p>
              <p className="text-accent">Have a specific proposal? Start a full initiative with a proposed action and outcome.</p>
            </a>
          </div>
        </div>

        <PostProblemForm />
      </main>
    </div>
  );
}
