"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { applyDocumentPatch, diffDocument, type DocumentPatch } from "../design/document-patch";
import { applyRevisionChanges } from "../design/revision-sync";
import { parseImmutableDesignDocument, type DesignDocument } from "../design/document";
import { RoomEditQueue, type CommitDependency, type RoomCommit } from "../design/room-edit-queue";
import { EMPTY_PRESENCE, type Presence, readRoomMessage } from "../lib/realtime/protocol";
import { PresenceStore } from "../lib/realtime/presence-store";
import { AgentActivityStore } from "../lib/realtime/agent-activity";
import { useEditorHost } from "../host";
import { fetchWithRateLimitRetry } from "../lib/retry-after";

import { fileChangesSchema, fileCommitSchema, presenceTicketSchema } from "../design/sync-protocol";
import {
  readJsonResponse,
  readJsonValue,
  responseError,
  ResponseError,
} from "../lib/http/json-response";
import { UserFacingError, diagnosticError } from "@tidy/ui/errors";
import { z } from "zod";

const editErrorSchema = z.object({ error: z.string().optional() });
type Snapshot = { revision: number; content: DesignDocument };
export type ConnectionState = "connecting" | "live" | "reconnecting" | "unavailable";
export function useFileRoom({
  fileId,
  enabled,
  initialSnapshot,
  onSnapshot,
  onName,
  onPermission,
  onNavigationBlocked,
  local = false,
  onLocalCommit,
}: {
  fileId: string;
  enabled: boolean;
  initialSnapshot: Snapshot;
  onSnapshot: (snapshot: Snapshot) => void;
  onName: (name: string) => void;
  onPermission?: (canEdit: boolean) => void;
  onNavigationBlocked?: () => void;
  local?: boolean;
  onLocalCommit?: (document: DesignDocument) => Promise<void>;
}) {
  const { reportError: appErrorReporter } = useEditorHost();
  const localCommit = useRef(onLocalCommit);
  useLayoutEffect(() => {
    localCommit.current = onLocalCommit;
  }, [onLocalCommit]);
  const [store] = useState(() => new PresenceStore());
  const [activities] = useState(() => new AgentActivityStore());
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [commentsVersion, setCommentsVersion] = useState(0);
  const callbacks = useRef({ onSnapshot, onName, onPermission, onNavigationBlocked });
  const socket = useRef<WebSocket | null>(null);
  const presence = useRef<Presence>({ ...EMPTY_PRESENCE });
  const publishTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  useEffect(() => {
    callbacks.current = { onSnapshot, onName, onPermission, onNavigationBlocked };
  }, [onSnapshot, onName, onPermission, onNavigationBlocked]);
  const [edits] = useState(
    () => new RoomEditQueue(initialSnapshot, onSnapshot, parseImmutableDesignDocument),
  );
  useEffect(() => edits.setNotify(onSnapshot), [edits, onSnapshot]);
  const hasPendingEdits = useCallback(() => edits.hasPendingEdits, [edits]);
  const pendingEdits = edits.hasPendingEdits;
  useLayoutEffect(() => {
    if ((!enabled && !local) || !pendingEdits) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!edits.hasPendingEdits) return;
      event.preventDefault();
      event.returnValue = "";
    }
    // The Navigation API can cancel same-document Back/Forward before Next's
    // popstate handler unmounts the editor. Older browsers retain Link and unload guards.
    const navigation = (window as Window & { navigation?: EventTarget }).navigation;
    function navigate(event: Event & { navigationType?: string }) {
      if (event.navigationType !== "traverse" || !event.cancelable || !edits.hasPendingEdits)
        return;
      event.preventDefault();
      callbacks.current.onNavigationBlocked?.();
    }
    window.addEventListener("beforeunload", beforeUnload);
    navigation?.addEventListener("navigate", navigate);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      navigation?.removeEventListener("navigate", navigate);
    };
  }, [enabled, local, edits, pendingEdits]);
  const getSnapshot = useCallback(() => edits.getSnapshot(), [edits]);
  const reconcile = useCallback(() => edits.restore(), [edits]);
  const receive = useCallback((snapshot: Snapshot) => edits.receive(snapshot), [edits]);
  const flushPresence = useCallback(() => {
    if (socket.current?.readyState === WebSocket.OPEN)
      socket.current.send(JSON.stringify({ type: "presence", presence: presence.current }));
  }, []);
  const publishPresence = useCallback(
    (changes: Partial<Presence>, immediate = false) => {
      presence.current = { ...presence.current, ...changes };
      if (immediate) {
        if (publishTimer.current) clearTimeout(publishTimer.current);
        publishTimer.current = null;
        flushPresence();
      } else if (!publishTimer.current) {
        publishTimer.current = setTimeout(() => {
          publishTimer.current = null;
          flushPresence();
        }, 40);
      }
    },
    [flushPresence],
  );
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    lifecycle.current = controller;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let renewalTimer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    let wantedSequence = 0;
    let seenSequence = -1;
    let reading = false;
    let requireSnapshot = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshFailureReported = false;
    let connectionFailureReported = false;
    async function refresh() {
      if (reading || controller.signal.aborted) return;
      const reportSyncError = appErrorReporter("file_sync");
      reading = true;
      try {
        do {
          const response = await fetch(
            `/api/files/${encodeURIComponent(fileId)}/changes${requireSnapshot ? "" : `?revision=${edits.saved.revision}`}`,
            {
              cache: "no-store",
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
            },
          );
          if ([401, 403, 404].includes(response.status)) {
            callbacks.current.onPermission?.(false);
            setConnection("unavailable");
            socket.current?.close(1000, "Access ended");
            controller.abort();
            return;
          }
          const result = await readJsonResponse({
            response,
            schema: fileChangesSchema,
            message: "Could not synchronize file.",
          });
          if (controller.signal.aborted) return;
          callbacks.current.onPermission?.(result.canEdit);
          const saved = edits.saved;
          const next =
            "snapshot" in result
              ? result.snapshot
              : applyRevisionChanges(saved, result, parseImmutableDesignDocument);
          if (next !== saved) edits.receive(next);
          requireSnapshot = false;
          if (!result.canEdit) edits.restore();
          callbacks.current.onName(result.name);
          seenSequence = Math.max(seenSequence, result.sequence);
          refreshFailureReported = false;
        } while (wantedSequence > seenSequence && !controller.signal.aborted);
      } catch (error) {
        requireSnapshot = true;
        if (!controller.signal.aborted && !refreshFailureReported) {
          reportSyncError(error);
          refreshFailureReported = true;
        }
        if (!controller.signal.aborted) refreshTimer = setTimeout(() => void refresh(), 1500);
      } finally {
        reading = false;
      }
    }
    function reconnect() {
      if (controller.signal.aborted) return;
      clearTimeout(renewalTimer);
      clearTimeout(reconnectTimer);
      store.replace([]);
      activities.clear();
      setConnection("reconnecting");
      reconnectTimer = setTimeout(
        () => void connect(),
        Math.min(10_000, 500 * 2 ** Math.min(attempt++, 5)) * (0.75 + Math.random() * 0.5),
      );
    }
    async function connect() {
      if (
        controller.signal.aborted ||
        socket.current?.readyState === WebSocket.CONNECTING ||
        socket.current?.readyState === WebSocket.OPEN
      )
        return;
      const reportConnectionError = appErrorReporter("file_sync");
      try {
        const response = await fetch(`/api/files/${encodeURIComponent(fileId)}/presence-ticket`, {
          method: "POST",
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
        });
        if ([401, 403, 404].includes(response.status)) {
          setConnection("unavailable");
          return;
        }
        const ticket = await readJsonResponse({
          response,
          schema: presenceTicketSchema,
          message: "Could not join file.",
        });
        if (controller.signal.aborted) return;
        store.identify(ticket.sessionId);
        const ws = new WebSocket(ticket.url);
        socket.current = ws;
        ws.onmessage = (event) => {
          if (socket.current !== ws || controller.signal.aborted) return;
          const message = readRoomMessage(event.data);
          if (!message) return;
          switch (message.type) {
            case "ready":
              attempt = 0;
              connectionFailureReported = false;
              setConnection("live");
              flushPresence();
              seenSequence = -1;
              void refresh();
              setCommentsVersion((version) => version + 1);
              break;
            case "access":
              callbacks.current.onPermission?.(message.canEdit);
              if (!message.canEdit) {
                edits.restore();
                publishPresence({ preview: null, action: null }, true);
              }
              break;
            case "peers":
              store.replace(message.peers);
              break;
            case "activities":
              activities.replace(message.activities);
              break;
            case "activity":
              activities.update(message.activity);
              break;
            case "presence":
              store.update(message.peer);
              break;
            case "leave":
              store.remove(message.sessionId);
              break;
            case "events":
              wantedSequence = Math.max(
                wantedSequence,
                ...message.events.map((item) => item.sequence),
              );
              if (message.events.some((item) => item.kind === "comments"))
                setCommentsVersion((version) => version + 1);
              if (wantedSequence > seenSequence && !document.hidden) void refresh();
              break;
            case "pong":
              break;
            default: {
              const exhaustive: never = message;
              throw new Error(`Unhandled room message: ${exhaustive}`);
            }
          }
        };
        ws.onclose = () => {
          if (socket.current === ws && !controller.signal.aborted) reconnect();
        };
        ws.onerror = () => ws.close();
        renewalTimer = setTimeout(
          () => ws.close(1000, "Renew authorization"),
          Math.max(1000, ticket.expiresAt - Date.now() - 15_000),
        );
      } catch (cause) {
        if (!controller.signal.aborted) {
          if (!connectionFailureReported) {
            reportConnectionError(cause);
            connectionFailureReported = true;
          }
          reconnect();
        }
      }
    }
    void connect();
    const heartbeat = setInterval(() => {
      if (socket.current?.readyState === WebSocket.OPEN) {
        socket.current.send(JSON.stringify({ type: "ping" }));
        flushPresence();
      }
      store.expire();
    }, 20_000);
    const expirePreviews = setInterval(() => {
      store.expire();
      activities.expire(Date.now(), true);
    }, 1000);
    const visibility = () => {
      publishPresence({ away: document.hidden, cursor: null, preview: null }, true);
      if (!document.hidden) void refresh();
    };
    const online = () => {
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (socket.current?.readyState !== WebSocket.OPEN) void connect();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
    return () => {
      controller.abort();
      clearTimeout(reconnectTimer);
      clearTimeout(renewalTimer);
      clearTimeout(refreshTimer);
      if (publishTimer.current) clearTimeout(publishTimer.current);
      publishTimer.current = null;
      clearInterval(heartbeat);
      clearInterval(expirePreviews);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
      socket.current?.close(1000, "Left file");
      socket.current = null;
      store.replace([]);
      activities.clear();
    };
  }, [fileId, enabled, store, activities, edits, flushPresence, publishPresence, appErrorReporter]);
  const commit = useCallback(
    (
      patch: DocumentPatch,
      conditional = false,
      sourceNodeId?: string,
      dependency?: CommitDependency,
    ): Promise<RoomCommit> => {
      return edits.commit(
        patch,
        async (operationId, canonicalPatch, expectedSequence, allowedSequences) => {
          if (local) {
            const before = edits.saved;
            const content = applyDocumentPatch(
              before.content,
              canonicalPatch,
              conditional,
              parseImmutableDesignDocument,
            );
            const accepted = diffDocument(before.content, content);
            const snapshot = { revision: before.revision + Number(accepted.length > 0), content };
            if (accepted.length) await localCommit.current?.(content);
            return { patch: accepted, snapshot, sequence: snapshot.revision };
          }
          const controller = lifecycle.current;
          if (!controller || controller.signal.aborted)
            throw new Error("File connection is unavailable.");
          const base = edits.saved;
          let result: { patch: DocumentPatch; snapshot: Snapshot; sequence: number } | undefined;
          const reportSaveError = appErrorReporter("file_save");
          for (let attempt = 0; !controller.signal.aborted; attempt++) {
            try {
              const response = await fetchWithRateLimitRetry(
                () =>
                  fetch(`/api/files/${encodeURIComponent(fileId)}/changes`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      operationId,
                      patch: canonicalPatch,
                      conditional,
                      sourceNodeId,
                      expectedSequence,
                      allowedSequences,
                      baseRevision: base.revision,
                    }),
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
                  }),
                controller.signal,
              );
              let value: unknown;
              let parseFailure: unknown;
              try {
                value = await readJsonValue(response, "Could not apply edit.");
              } catch (cause) {
                // A malformed acknowledgement is uncertain. An explicit 4xx
                // remains a definitive rejection even if its body is invalid;
                // never replay a retired edit because JSON parsing failed.
                if (response.ok || response.status >= 500) throw cause;
                parseFailure = diagnosticError(cause);
                value = null;
              }
              if (response.status >= 500)
                throw responseError(response, value, "Server unavailable");
              const failure = editErrorSchema.safeParse(value);
              const rejection = failure.success ? failure.data.error : undefined;
              if (response.status === 410) {
                // A receipt may already have been retired: never retag or replay this edit.
                // Reconcile an accepted-but-unacknowledged edit from the authoritative snapshot.
                try {
                  const latest = await fetch(`/api/files/${encodeURIComponent(fileId)}/changes`, {
                    cache: "no-store",
                    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]),
                  });
                  if (latest.ok) {
                    const synchronized = await readJsonResponse({
                      response: latest,
                      schema: fileChangesSchema,
                      message: "Could not synchronize file.",
                    });
                    if ("snapshot" in synchronized && !controller.signal.aborted)
                      edits.receive(synchronized.snapshot);
                  }
                } catch (cause) {
                  if (!controller.signal.aborted) reportSaveError(cause);
                  /* A failed refresh must not replay an explicitly expired edit. */
                }
                throw new RejectedEdit(
                  rejection ??
                    "This edit has expired. Synchronize the latest file before editing again.",
                  { cause: parseFailure ?? new ResponseError(response, value) },
                );
              }
              if (!response.ok) {
                // An explicit response is a definitive rejection, unlike a lost ack.
                throw new RejectedEdit(rejection ?? "Could not apply edit.", {
                  cause: parseFailure ?? new ResponseError(response, value),
                });
              }
              // An invalid acknowledgement is uncertain, so retry this same operation ID.
              const payload = fileCommitSchema.parse(value);
              const snapshot =
                "snapshot" in payload
                  ? payload.snapshot
                  : edits.acknowledge(operationId, base, {
                      baseRevision: payload.baseRevision,
                      revision: payload.revision,
                      patches: payload.patch.length
                        ? [
                            {
                              baseRevision: payload.baseRevision,
                              revision: payload.revision,
                              patch: payload.patch,
                            },
                          ]
                        : [],
                    });
              result = { patch: payload.patch, snapshot, sequence: payload.sequence };
              break;
            } catch (error) {
              if (error instanceof RejectedEdit || controller.signal.aborted) throw error;
              if (attempt === 0) reportSaveError(error);
              await new Promise<void>((resolve) => {
                const finish = () => {
                  clearTimeout(timer);
                  controller.signal.removeEventListener("abort", finish);
                  resolve();
                };
                const timer = setTimeout(finish, Math.min(5000, 500 * (attempt + 1)));
                controller.signal.addEventListener("abort", finish, { once: true });
              });
            }
          }
          if (!result) throw new Error("File was closed before the edit completed.");
          return result;
        },
        dependency,
      );
    },
    [fileId, edits, local, appErrorReporter],
  );
  const getPreview = useCallback(() => presence.current.preview, []);
  const clearPreview = useCallback(
    (expected: Presence["preview"]) => {
      if (presence.current.preview === expected)
        publishPresence({ preview: null, action: null }, true);
    },
    [publishPresence],
  );
  return {
    store,
    activities,
    connection,
    commentsVersion,
    publishPresence,
    commit,
    getPreview,
    clearPreview,
    getSnapshot,
    hasPendingEdits,
    restore: reconcile,
    receive,
  };
}
class RejectedEdit extends UserFacingError {}
