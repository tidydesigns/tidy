import { useId } from "react";

export function UsageBar({
  label,
  used,
  limit,
  format = (value) => value.toLocaleString(),
  detail,
}: {
  label: string;
  used: number;
  limit: number | null;
  format?: (value: number) => string;
  detail?: string;
}) {
  const id = useId();
  const percentage =
    limit === null ? 0 : limit === 0 ? 100 : Math.min(100, Math.max(0, (used / limit) * 100));
  const remaining =
    limit === null
      ? "Unlimited remaining"
      : used > limit
        ? `${format(used - limit)} over limit`
        : `${format(Math.max(0, limit - used))} remaining`;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-2 py-4">
      <dt id={id} className="font-medium">
        {label}
      </dt>
      <dd className="tabular-nums text-primary-black/70">
        {format(used)} / {limit === null ? "Unlimited" : format(limit)}
      </dd>
      <dd className="col-span-2 space-y-2">
        <div
          role={limit === null ? undefined : "progressbar"}
          aria-labelledby={limit === null ? undefined : id}
          aria-valuemin={limit === null ? undefined : 0}
          aria-valuemax={limit ?? undefined}
          aria-valuenow={limit === null ? undefined : Math.min(used, limit)}
          aria-valuetext={
            limit === null ? undefined : `${format(used)} of ${format(limit)} used; ${remaining}`
          }
          aria-hidden={limit === null ? true : undefined}
          className="h-1.5 overflow-hidden rounded-full bg-primary-grey/40"
        >
          <div
            className={`h-full rounded-full ${limit !== null && used >= limit ? "bg-danger" : "bg-primary-orange"}`}
            style={{ width: `${percentage}%` }}
          />
        </div>
        <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs text-primary-black/60">
          <span className="tabular-nums">{remaining}</span>
          {detail && <span>{detail}</span>}
        </div>
      </dd>
    </div>
  );
}
