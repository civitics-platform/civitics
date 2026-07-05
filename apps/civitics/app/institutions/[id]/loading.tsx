export default function InstitutionLoading() {
  return (
    <div className="min-h-screen bg-paper-2">
      <div className="border-b border-rule bg-card px-5 py-3">
        <div className="h-4 w-48 animate-pulse rounded bg-rule/40" />
      </div>
      <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="border border-rule bg-card p-6">
          <div className="flex items-start gap-5">
            <div className="h-16 w-16 shrink-0 animate-pulse rounded-lg bg-paper-2" />
            <div className="flex-1 space-y-3">
              <div className="h-4 w-32 animate-pulse rounded bg-paper-2" />
              <div className="h-7 w-3/4 animate-pulse rounded bg-rule/40" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-paper-2" />
            </div>
          </div>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden border border-rule bg-rule/40 sm:grid-cols-5">
          {[1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="h-20 animate-pulse bg-card" />
          ))}
        </div>
        <div className="mt-6 grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2 flex flex-col gap-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-32 animate-pulse border border-rule bg-card" />
            ))}
          </div>
          <div className="h-64 animate-pulse border border-rule bg-card" />
        </div>
      </div>
    </div>
  );
}
