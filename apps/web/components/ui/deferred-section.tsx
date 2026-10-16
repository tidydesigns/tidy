"use client";

import { catchError, type ErrorInfo } from "next/error";
import {
  Suspense,
  use,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import { useNavigationRecovery } from "@/components/workspace/navigation-recovery";
import { Button } from "@/components/ui/button";

export function SectionLoading({ label }: { label: string }) {
  return (
    <p role="status" className="py-4 text-sm text-secondary-ink">
      Loading {label}…
    </p>
  );
}

const SectionError = catchError(function SectionRetry(
  { label, source }: { label: string; source: unknown },
  { retry, reset }: ErrorInfo,
) {
  const failedSource = useRef(source);
  useEffect(() => {
    if (!Object.is(failedSource.current, source)) {
      failedSource.current = source;
      reset();
    }
  }, [source, reset]);
  const recovering = useNavigationRecovery(retry);
  const [pending, startTransition] = useTransition();
  if (recovering) return <SectionLoading label={label} />;
  return (
    <div className="flex items-center gap-3 py-4 text-sm">
      <p role="alert" className="text-danger">
        Could not load {label}.
      </p>
      <Button
        type="button"
        variant="text"
        aria-label={`Retry loading ${label}`}
        disabled={pending}
        onClick={() => startTransition(retry)}
      >
        {pending ? "Retrying…" : "Try again"}
      </Button>
    </div>
  );
});

/** Keep content during promise refreshes; apply completed local updates immediately. */
export function DeferredSection<T>({
  value,
  label,
  children,
}: {
  value: T | Promise<T>;
  label: string;
  children: (value: T) => ReactNode;
}) {
  const deferred = useDeferredValue(value);
  const promise = value && typeof value === "object" && "then" in value;
  const [local, setLocal] = useState({ source: value, value, superseded: value });
  if (!Object.is(local.source, value)) {
    setLocal(
      promise ? { ...local, source: value } : { source: value, value, superseded: deferred },
    );
  }
  // An urgent local update can overtake the deferred render. A refresh started
  // immediately afterward must not bring back the value that update replaced.
  const current = !promise ? value : Object.is(deferred, local.superseded) ? local.value : deferred;
  return (
    <SectionError label={label} source={current}>
      <Suspense fallback={<SectionLoading label={label} />}>
        <Resolved value={current}>{children}</Resolved>
      </Suspense>
    </SectionError>
  );
}

function Resolved<T>({
  value,
  children,
}: {
  value: T | Promise<T>;
  children: (value: T) => ReactNode;
}) {
  return children(
    value && typeof value === "object" && "then" in value ? use(value as Promise<T>) : (value as T),
  );
}
