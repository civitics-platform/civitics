import { SignInForm } from "../../components/SignInForm";
import { PorticoMark } from "../../components/brand/PorticoMark";

export const metadata = {
  title: "Sign in",
};

export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const next = params.next ?? "/";
  const hasError = params.error === "auth";

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm">
        {/* Mark + wordmark — mirrors the NavBar masthead treatment */}
        <a
          href="/"
          className="mb-8 flex flex-col items-center gap-3 text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          <PorticoMark size={44} />
          <span className="flex flex-col items-center">
            <span className="font-serif text-[22px] font-black uppercase leading-none tracking-[0.12em]">
              Civitics
            </span>
            <span className="mt-1 font-mono text-[9px] font-medium uppercase tracking-[0.18em] text-ink-soft">
              The Public Ledger
            </span>
          </span>
        </a>

        {/* Heading */}
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-ink">
            Sign in to Civitics
          </h1>
          <p className="mt-2 text-sm text-ink-soft leading-relaxed">
            Track your civic engagement, save positions, and follow the
            officials who represent you.
          </p>
        </div>

        {/* Auth error banner */}
        {hasError && (
          <div className="mb-4 border border-accent/40 bg-accent/10 px-4 py-3">
            <p className="text-sm text-accent">
              That sign-in link has expired or is invalid. Please try again.
            </p>
          </div>
        )}

        {/* Sign-in form (client component) */}
        <div className="border border-rule bg-card p-6">
          <SignInForm next={next} />
        </div>

        {/* Back link */}
        <p className="mt-6 text-center font-mono text-[11px] uppercase tracking-[0.08em] text-ink-soft">
          <a href="/" className="transition-colors hover:text-accent">
            ← Back to the ledger
          </a>
        </p>
      </div>
    </div>
  );
}
