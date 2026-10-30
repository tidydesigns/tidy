import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import type { DesktopAPI } from "../../../../shared/contracts/desktop";
import { threadPortURL, type ThreadPort } from "../../../../shared/contracts/thread-ports";

export function ThreadPortsStrip({
  api,
  projectId,
  threadId,
  active,
  connected = true,
  remoteLabel,
}: {
  api: DesktopAPI;
  projectId: string;
  threadId: string;
  active: boolean;
  connected?: boolean;
  remoteLabel?: string;
}) {
  const [ports, setPorts] = useState<ThreadPort[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const listId = useId();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [unavailable, setUnavailable] = useState(false);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  const stoppingRef = useRef(new Set<string>());
  const mutation = useRef(0);
  const mounted = useRef(false);
  const refresh = useRef<() => void>(() => {});
  const groups = useMemo(() => {
    const result = new Map<string, [ThreadPort, ...ThreadPort[]]>();
    for (const port of ports) {
      const group = result.get(port.processId);
      if (group) group.push(port);
      else result.set(port.processId, [port]);
    }
    return [...result.values()];
  }, [ports]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!active || !connected) return;
    let disposed = false,
      loading = false,
      requested = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (disposed || document.hidden) return;
      if (loading) {
        requested = true;
        return;
      }
      clearTimeout(timer);
      loading = true;
      const version = mutation.current;
      try {
        const next = await api.threadPorts(projectId, threadId);
        if (!disposed && version === mutation.current) {
          setPorts((previous) =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next,
          );
          setUnavailable(false);
        }
      } catch {
        if (!disposed && version === mutation.current) setUnavailable(true);
      } finally {
        loading = false;
        if (!disposed) {
          const interval = requested ? 0 : 2000;
          requested = false;
          timer = setTimeout(() => void load(), interval);
        }
      }
    };
    const update = () => void load();
    refresh.current = update;
    document.addEventListener("visibilitychange", update);
    window.addEventListener("focus", update);
    update();
    return () => {
      disposed = true;
      clearTimeout(timer);
      refresh.current = () => {};
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("focus", update);
    };
  }, [api, projectId, threadId, active, connected]);

  async function stop(port: ThreadPort) {
    if (stoppingRef.current.has(port.processId)) return;
    stoppingRef.current.add(port.processId);
    setStopping(new Set(stoppingRef.current));
    setAnnouncement(`Stopping ${port.processName} on port ${port.port}.`);
    mutation.current++;
    setErrors((previous) => ({ ...previous, [port.processId]: "" }));
    try {
      await api.stopThreadPort(projectId, threadId, port.id);
      if (mounted.current) {
        setPorts((previous) => previous.filter((entry) => entry.processId !== port.processId));
        setAnnouncement(`Stopped ${port.processName} on port ${port.port}.`);
      }
    } catch (error) {
      if (mounted.current) {
        setAnnouncement("");
        setErrors((previous) => ({
          ...previous,
          [port.processId]: error instanceof Error ? error.message : "Could not stop this process.",
        }));
      }
    } finally {
      mutation.current++;
      stoppingRef.current.delete(port.processId);
      if (mounted.current) {
        setStopping(new Set(stoppingRef.current));
        refresh.current();
      }
    }
  }

  async function open(port: ThreadPort) {
    try {
      await api.openChatLink(projectId, threadPortURL(port));
    } catch {
      if (mounted.current)
        setErrors((previous) => ({ ...previous, [port.processId]: "Could not open this port." }));
    }
  }

  return (
    <>
      <span className="sr-only" role="status">
        {announcement}
      </span>
      {ports.length > 0 && (
        <section className="mb-2 px-1" aria-label="Running ports">
          {groups.length > 1 && (
            <Button
              type="button"
              className="flex w-full items-center gap-2 rounded py-1 text-left text-[11px] leading-5 text-muted-ink hover:text-ink"
              aria-expanded={expanded}
              aria-controls={listId}
              onClick={() => setExpanded((value) => !value)}
            >
              <span
                aria-hidden="true"
                className="size-1.5 shrink-0 rounded-full bg-current opacity-60"
              />
              <span>
                {groups.length}{" "}
                {unavailable || !connected ? "processes · status unknown" : "running processes"}
              </span>
              {remoteLabel && <span className="truncate">{remoteLabel}</span>}
              {stopping.size > 0 && <span>{stopping.size} stopping…</span>}
              <svg
                aria-hidden="true"
                className="ml-auto shrink-0"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d={expanded ? "m7 14 5-5 5 5" : "m7 10 5 5 5-5"} />
              </svg>
            </Button>
          )}
          {(unavailable || !connected) && (
            <p className="mb-1 text-[11px] text-muted-ink" role="status">
              {connected
                ? "Port status unavailable. Retrying…"
                : "Connection unavailable. Port status is unknown."}
            </p>
          )}
          <div
            id={listId}
            hidden={groups.length > 1 && !expanded}
            className="max-h-[132px] overflow-y-auto"
          >
            {groups.map((group) => {
              const port = group[0];
              const pending = stopping.has(port.processId);
              return (
                <div key={port.processId} className="py-1">
                  <div className="flex min-w-0 items-center gap-2 text-[11px] leading-5 text-muted-ink">
                    <span
                      aria-hidden="true"
                      className="size-1.5 shrink-0 rounded-full bg-current opacity-60"
                    />
                    <span className="shrink-0">
                      {pending
                        ? "Stopping…"
                        : unavailable || !connected
                          ? "Status unknown"
                          : "Running"}
                    </span>
                    {remoteLabel && (
                      <span className="truncate" title={remoteLabel}>
                        {remoteLabel}
                      </span>
                    )}
                    <span className="truncate" title={port.processName}>
                      {port.processName}
                    </span>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
                      {group.map((entry) =>
                        remoteLabel ? (
                          <span
                            key={entry.id}
                            title={`Port ${entry.port} on ${remoteLabel}`}
                            className="text-ink"
                          >
                            :{entry.port}
                          </span>
                        ) : (
                          <Button
                            key={entry.id}
                            type="button"
                            className="truncate text-[11px] text-ink underline decoration-border underline-offset-4 hover:decoration-current"
                            title={`Open ${threadPortURL(entry)}`}
                            disabled={pending}
                            onClick={() => void open(entry)}
                          >
                            {entry.host === "::1" ? "[::1]" : "localhost"}:{entry.port}
                          </Button>
                        ),
                      )}
                    </div>
                    <Button
                      type="button"
                      className="shrink-0 rounded px-1.5 text-[11px] hover:bg-hover-surface hover:text-ink disabled:opacity-50"
                      disabled={pending || !connected}
                      aria-label={`Stop ${port.processName} on ${group.map((entry) => `port ${entry.port}`).join(", ")}`}
                      onClick={() => void stop(port)}
                    >
                      {pending ? "Stopping…" : "Stop"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
          {Object.entries(errors).map(([processId, error]) =>
            error ? (
              <p key={processId} className="mt-1 text-[11px] text-muted-ink" role="alert">
                {error}
              </p>
            ) : null,
          )}
        </section>
      )}
    </>
  );
}
