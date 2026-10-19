export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`rounded bg-subtle-fill motion-safe:animate-pulse ${className}`} />;
}
