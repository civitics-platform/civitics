const VERSION =
  process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? "dev";

export default function HomePage() {
  return (
    <main className="min-h-screen bg-white flex flex-col">
      <div className="flex-1 mx-auto max-w-7xl px-4 py-16 sm:px-6 lg:px-8">
        <div className="text-center">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
            Civitics
          </h1>
          <p className="mt-4 text-lg text-gray-600">
            Wikipedia meets Bloomberg Terminal for democracy.
          </p>
          <p className="mt-2 text-sm text-gray-400">Phase 0 — scaffold complete</p>
        </div>
      </div>
      <footer className="border-t border-gray-100 px-6 py-3 flex items-center justify-end">
        <span className="text-xs text-gray-300 font-mono">v:{VERSION}</span>
      </footer>
    </main>
  );
}
