import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  emptyBrowserState,
  type BrowserAPI,
  type BrowserScope,
  type BrowserAction,
  type BrowserInput,
  type BrowserState,
} from "../../../../shared/contracts/browser";
import { projectBrowserState, confirmBrowserState, type BrowserPending } from "./browser-pending";
import { createBrowserFramePainter } from "./browser-frame-painter";
export function useBrowserSession({
  api,
  scope,
  visible,
  canvas,
}: {
  api: BrowserAPI;
  scope: BrowserScope;
  visible: boolean;
  canvas: RefObject<HTMLCanvasElement | null>;
}) {
  const [state, setState] = useState<BrowserState>(emptyBrowserState);
  const [error, setError] = useState("");
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [painted, setPainted] = useState<string | null>(null);
  const authoritativeState = useRef<BrowserState>(emptyBrowserState);
  const pendingChanges = useRef<BrowserPending>({
    closed: new Set(),
    selected: null,
    navigation: new Map(),
  });
  const commandEpoch = useRef(0);
  const stateRef = useRef(state);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const updateOptimisticState = useCallback(() => {
    const value = projectBrowserState(authoritativeState.current, pendingChanges.current);
    if (value.activeTabId !== stateRef.current.activeTabId) setPainted(null);
    stateRef.current = value;
    setState(value);
  }, []);
  const send = useCallback(
    (input: BrowserInput) => {
      const state = stateRef.current;
      api.input(scope, {
        tabId: state.activeTabId,
        viewId: state.tabs.find((tab) => tab.id === state.activeTabId)?.viewId ?? null,
        input,
      });
    },
    [api, scope.projectId, scope.threadId],
  );
  useEffect(() => {
    let stopped = false;
    const painter = createBrowserFramePainter({
      canvas: () => canvas.current,
      state: () => stateRef.current,
      visible: () => visibleRef.current,
      acknowledge: (frameId) => send({ kind: "ack", frameId }),
      painted: setPainted,
    });
    const unwatch = api.watch(scope, (event) => {
      if (stopped) return;
      switch (event.kind) {
        case "frame":
          painter.draw(event);
          break;
        case "state": {
          const old = stateRef.current;
          authoritativeState.current = event.state;
          const projected = confirmBrowserState(event.state, pendingChanges.current);
          stateRef.current = projected;
          setState(projected);
          setDisconnected(false);
          if (projected.activeTabId !== old.activeTabId) setPainted(null);
          if (
            old.phase.kind !== event.state.phase.kind ||
            old.activeTabId !== event.state.activeTabId
          )
            setError("");
          break;
        }
        case "error":
          setError(event.message);
          break;
        case "disconnected":
          setDisconnected(true);
          break;
        default: {
          const exhaustive: never = event;
          throw new Error(String(exhaustive));
        }
      }
    });
    send({ kind: "visibility", visible: visibleRef.current });
    return () => {
      stopped = true;
      painter.close();
      unwatch();
    };
  }, [api, scope.projectId, scope.threadId, send]);
  const command = useCallback(
    async (action: BrowserAction) => {
      const epoch = ++commandEpoch.current;
      setError("");
      setDismissedError(null);
      try {
        const result = await api.command({ ...scope, action });
        return result;
      } catch (error) {
        if (epoch === commandEpoch.current)
          setError(error instanceof Error ? error.message : "Browser action failed.");
        return undefined;
      }
    },
    [api, scope.projectId, scope.threadId],
  );

  const selectTab = (id: string) => {
    pendingChanges.current.selected = id;
    updateOptimisticState();
    void command({ kind: "select", tabId: id }).then((result) => {
      if (!result && pendingChanges.current.selected === id) {
        pendingChanges.current.selected = null;
        updateOptimisticState();
      }
    });
  };
  const closeTab = (id: string) => {
    pendingChanges.current.closed.add(id);
    updateOptimisticState();
    void command({ kind: "close", tabId: id }).then((result) => {
      if (!result) {
        pendingChanges.current.closed.delete(id);
        updateOptimisticState();
      }
    });
  };

  const navigateURL = (url: string) => {
    const tab = stateRef.current.tabs.find((tab) => tab.id === stateRef.current.activeTabId);
    const id = crypto.randomUUID();
    if (tab) {
      pendingChanges.current.navigation.set(tab.id, { id, url });
      updateOptimisticState();
    }
    void command(tab ? { kind: "navigate", tabId: tab.id, url } : { kind: "open", url }).then(
      (result) => {
        if (!result && tab && pendingChanges.current.navigation.get(tab.id)?.id === id) {
          pendingChanges.current.navigation.delete(tab.id);
          updateOptimisticState();
        }
      },
    );
  };
  return {
    state,
    stateRef,
    visibleRef,
    painted,
    error,
    setError,
    dismissedError,
    setDismissedError,
    disconnected,
    send,
    command,
    selectTab,
    closeTab,
    navigateURL,
  };
}
