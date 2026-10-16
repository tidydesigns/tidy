"use client";

import { unstable_rethrow, useRouter } from "next/navigation";
import {
  Component,
  Suspense,
  use,
  useDeferredValue,
  useState,
  useTransition,
  type ReactNode,
} from "react";

import { Button } from "@/components/ui/button";

export function SectionLoading({ label }: { label: string }) {
  return (
    <p role="status" className="py-4 text-sm text-secondary-ink">
      Loading {label}…
    </p>
  );
}

class SectionError extends Component<
  { source: unknown; label: string; children: ReactNode },
  { failed: boolean; source: unknown }
> {
  state = { failed: false, source: this.props.source };
  static getDerivedStateFromError(error: unknown) {
    unstable_rethrow(error);
    return { failed: true };
  }
  static getDerivedStateFromProps(props: { source: unknown }, state: { source: unknown }) {
    return props.source !== state.source ? { source: props.source, failed: false } : null;
  }
  render() {
    return this.state.failed ? <SectionRetry label={this.props.label} /> : this.props.children;
  }
}

function SectionRetry({ label }: { label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
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
        onClick={() => startTransition(() => router.refresh())}
      >
        {pending ? "Retrying…" : "Try again"}
      </Button>
    </div>
  );
}

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
    <SectionError source={current} label={label}>
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
