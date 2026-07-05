export default function ProfileLoading() {
  return (
    <div className="min-h-screen bg-paper-2">
      <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="mb-6 h-8 w-48 animate-pulse rounded bg-rule/40" />
        <div className="space-y-4 border border-rule bg-card p-6">
          <div className="flex items-center gap-4">
            <div className="h-16 w-16 animate-pulse rounded-full bg-rule/40" />
            <div className="flex-1 space-y-2">
              <div className="h-5 w-40 animate-pulse rounded bg-rule/40" />
              <div className="h-4 w-56 animate-pulse rounded bg-paper-2" />
            </div>
          </div>
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded bg-paper-2" />
          ))}
        </div>
      </div>
    </div>
  );
}
