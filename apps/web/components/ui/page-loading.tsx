export function PageLoading() {
  return (
    <div role="status" aria-label="Loading page" className="max-w-4xl motion-safe:animate-pulse">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" className="space-y-8">
        <div className="h-9 w-48 rounded-lg bg-primary-grey/20" />
        <div className="h-10 w-full rounded-lg bg-primary-grey/15" />
        <div className="grid grid-cols-2 gap-5 sm:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <div key={item} className="h-40 rounded-xl bg-primary-grey/15" />
          ))}
        </div>
      </div>
    </div>
  );
}
