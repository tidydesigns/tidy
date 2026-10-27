import { Component, lazy, Suspense, useState, type ComponentType, type ReactNode } from "react";
import { Button } from "@tidy/ui/button";

export function ViewLoading({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={`Loading ${label}`}
      className="flex h-full min-h-24 min-w-0 flex-1 items-center justify-center rounded bg-subtle-fill p-4 text-sm text-muted-ink"
    >
      Loading {label}…
    </div>
  );
}

class ViewBoundary extends Component<
  { children: ReactNode; label: string; retry(): void; onError?(error: unknown): void },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    this.props.onError?.(error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-full min-h-24 min-w-0 flex-1 flex-col items-center justify-center gap-3 p-4">
        <p role="alert" className="text-sm text-muted-ink">
          Could not load {this.props.label}.
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" className="secondary-button" onClick={this.props.retry}>
            Retry {this.props.label}
          </Button>
          <Button
            type="button"
            className="secondary-button"
            title="Reload app and discard unsent messages"
            onClick={() => {
              if (window.tidy?.reloadApp) void window.tidy.reloadApp();
              else window.location.reload();
            }}
          >
            Reload app
          </Button>
        </div>
      </div>
    );
  }
}

export function lazyView<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>,
  options: {
    label: string;
    fallback?: (props: NoInfer<Props>) => ReactNode;
    onError?: (props: NoInfer<Props>, error: unknown) => void;
  },
) {
  let current = lazy(load);
  return function LazyView(props: Props) {
    const [attempt, setAttempt] = useState(() => ({ View: current, revision: 0 }));
    const { View, revision } = attempt;
    return (
      <ViewBoundary
        key={revision}
        label={options.label}
        onError={(error) => options.onError?.(props, error)}
        retry={() => {
          current = lazy(load);
          setAttempt({ View: current, revision: revision + 1 });
        }}
      >
        <Suspense
          fallback={
            options.fallback ? options.fallback(props) : <ViewLoading label={options.label} />
          }
        >
          <View {...props} />
        </Suspense>
      </ViewBoundary>
    );
  };
}
