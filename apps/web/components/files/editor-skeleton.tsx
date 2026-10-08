export function EditorSkeleton() {
  return (
    <main
      role="status"
      aria-label="Loading file"
      data-page-skeleton="editor"
      className="relative h-dvh w-full overflow-hidden bg-canvas"
    >
      <span className="sr-only">Loading file…</span>
      <div aria-hidden="true" className="absolute inset-0">
        <div className="absolute left-3 top-6 flex h-14 max-w-[calc(100%-1.5rem)] items-center gap-3 rounded-lg border border-primary-grey/65 bg-primary-white/95 p-2 shadow-sm">
          <div className="size-10 shrink-0 rounded-lg bg-subtle-fill motion-safe:animate-pulse" />
          <div className="h-6 w-px bg-primary-grey/65" />
          <div className="h-4 w-28 rounded bg-subtle-fill motion-safe:animate-pulse" />
          <div className="size-10 shrink-0 rounded-lg bg-subtle-fill motion-safe:animate-pulse" />
        </div>
        <div className="absolute left-3 top-1/2 flex -translate-y-1/2 flex-col gap-2 rounded-lg border border-primary-grey/65 bg-primary-white/95 p-1.5 shadow-sm">
          {[0, 1, 2, 3, 4, 5].map((tool) => (
            <div
              key={tool}
              className="size-10 rounded-lg bg-subtle-fill motion-safe:animate-pulse"
            />
          ))}
        </div>
        <div className="absolute right-4 top-4 hidden h-10 items-center gap-2 rounded-lg border border-primary-grey/65 bg-primary-white/95 px-3 shadow-sm sm:flex">
          <div className="size-6 rounded-full bg-subtle-fill motion-safe:animate-pulse" />
          <div className="h-4 w-12 rounded bg-subtle-fill motion-safe:animate-pulse" />
        </div>
      </div>
    </main>
  );
}
