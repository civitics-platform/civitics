import { SignInForm } from "../../components/SignInForm";

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
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-sm">
        {/* Logo + wordmark */}
        <div className="mb-8 flex flex-col items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600">
            <span className="text-sm font-bold text-white">CV</span>
          </div>
          <span className="text-lg font-semibold tracking-tight text-gray-900">
            Civitics
          </span>
        </div>

        {/* Heading */}
        <div className="mb-6 text-center">
          <h1 className="text-xl font-semibold text-gray-900">
            Sign in to Civitics
          </h1>
          <p className="mt-2 text-sm text-gray-500 leading-relaxed">
            Track your civic engagement, save positions, and follow the
            officials who represent you.
          </p>
        </div>

        {/* Auth error banner */}
        {hasError && (
          <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-sm text-red-700">
              That sign-in link has expired or is invalid. Please try again.
            </p>
          </div>
        )}

        {/* Sign-in form (client component) */}
        <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
          <SignInForm next={next} />
        </div>

        {/* Back link */}
        <p className="mt-6 text-center text-xs text-gray-400">
          <a href="/" className="hover:text-gray-600 underline">
            ← Back to Civitics
          </a>
        </p>
      </div>
    </div>
  );
}
