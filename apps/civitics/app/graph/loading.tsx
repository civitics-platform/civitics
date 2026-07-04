export default function GraphLoading() {
  return (
    <div data-theme="terminal" className="flex h-screen flex-col bg-paper text-ink">
      <div className="flex items-center justify-between border-b border-rule bg-card px-4 py-3">
        <div className="h-6 w-40 animate-pulse rounded bg-ink/10" />
        <div className="flex gap-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-8 w-20 animate-pulse rounded bg-ink/10" />
          ))}
        </div>
      </div>
      <div className="flex flex-1 overflow-hidden">
        <div className="hidden w-64 shrink-0 border-r border-rule bg-card p-4 lg:block">
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded bg-ink/10" />
            ))}
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="h-full w-full max-w-3xl animate-pulse rounded-lg border border-rule bg-card" />
        </div>
      </div>
    </div>
  );
}
