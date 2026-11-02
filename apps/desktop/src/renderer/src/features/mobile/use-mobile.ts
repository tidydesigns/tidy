import { useCallback, useEffect, useRef, useState } from "react";
import type { MobileAPI, MobileCommand, MobileState } from "../../../../shared/contracts/mobile";

const cached = new WeakMap<MobileAPI, Map<string, MobileState>>();
export function useMobile(api: MobileAPI, projectId: string, active: boolean) {
  const [state, setState] = useState<MobileState | null>(
    () => cached.get(api)?.get(projectId) ?? null,
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const mounted = useRef(true);
  const changing = useRef(false);
  const remember = useCallback(
    (value: MobileState) => {
      let projects = cached.get(api);
      if (!projects) {
        projects = new Map();
        cached.set(api, projects);
      }
      projects.delete(projectId);
      projects.set(projectId, value);
      if (projects.size > 32) projects.delete(projects.keys().next().value!);
      setState(value);
    },
    [api, projectId],
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      version.current++;
    };
  }, []);
  const refresh = useCallback(
    async (force = false) => {
      const request = version.current;
      try {
        const value = await api.state({ projectId, ...(force ? { refresh: true } : {}) });
        if (mounted.current && request === version.current && !changing.current) {
          remember(value);
          setError(undefined);
        }
      } catch (cause) {
        if (mounted.current && request === version.current)
          setError(cause instanceof Error ? cause.message : "Could not read devices.");
      }
    },
    [api, projectId, remember],
  );
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!changing.current) await refresh();
      if (!cancelled) timer = setTimeout(() => void poll(), 1200);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, refresh]);
  const command = useCallback(
    async (input: MobileCommand) => {
      if (changing.current) return;
      changing.current = true;
      const request = ++version.current;
      setBusy(true);
      setError(undefined);
      if (input.kind === "connect") {
        setState((current) =>
          current
            ? {
                ...current,
                session: {
                  id: crypto.randomUUID(),
                  deviceId: input.deviceId,
                  phase: "starting",
                  message: "Connecting device…",
                },
              }
            : current,
        );
      } else if (input.kind === "disconnect")
        setState((current) => (current ? { ...current, session: null } : current));
      else if (input.kind === "stop")
        setState((current) =>
          current?.session?.run
            ? {
                ...current,
                session: {
                  ...current.session,
                  run: { ...current.session.run, phase: "stopped", message: "Run stopped" },
                },
              }
            : current,
        );
      else if (input.kind === "run")
        setState((current) =>
          current?.session
            ? {
                ...current,
                session: {
                  ...current.session,
                  run: {
                    id: crypto.randomUUID(),
                    targetId: input.targetId,
                    phase: "building",
                    message: "Preparing app…",
                    output: "",
                  },
                },
              }
            : current,
        );
      try {
        const value = await api.command(input);
        if (mounted.current && request === version.current) remember(value);
      } catch (cause) {
        if (mounted.current && request === version.current) {
          setError(cause instanceof Error ? cause.message : "The device action failed.");
          // Recover the authoritative state without replacing a later user action.
          const value = await api.state({ projectId }).catch(() => null);
          if (value && mounted.current && request === version.current) remember(value);
        }
      } finally {
        if (request === version.current) {
          changing.current = false;
          if (mounted.current) setBusy(false);
        }
      }
    },
    [api, projectId, remember],
  );
  return { state, error, busy, command, refresh };
}
