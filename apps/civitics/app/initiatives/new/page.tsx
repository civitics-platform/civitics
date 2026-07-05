import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { createServerClient } from "@civitics/db";
import { CreateInitiativeForm } from "./CreateInitiativeForm";
import Link from "next/link";

export const metadata = {
  title: "New Initiative",
};

export const dynamic = "force-dynamic";

export default async function NewInitiativePage() {
  // Server-side auth check — redirect to sign-in if not logged in
  const cookieStore = await cookies();
  const supabase = createServerClient(cookieStore);
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/auth/sign-in?next=/initiatives/new");
  }

  return (
    <div className="min-h-screen bg-paper-2">
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        {/* Breadcrumb */}
        <nav className="mb-6 flex items-center gap-2 text-sm text-ink-soft/70">
          <Link href="/initiatives" className="hover:text-ink">Initiatives</Link>
          <span>/</span>
          <span className="text-ink">New initiative</span>
        </nav>

        <h1 className="mb-2 text-2xl font-bold text-ink">Start a civic initiative</h1>
        <p className="mb-8 text-sm text-ink-soft/70">
          Draft a proposal for community deliberation. It stays in draft until you&apos;re ready
          to open it for discussion.
        </p>

        <CreateInitiativeForm />
      </main>
    </div>
  );
}
