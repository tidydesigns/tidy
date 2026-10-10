"use client";
import { memo } from "react";

import type { DesignDocument } from "@/lib/design/document";
import {
  importNoteKey,
  importNotes,
  type ImportNote,
  type ImportNoteStatus,
} from "@/lib/design/import-notes";

export const ImportNotes = memo(function ImportNotes({
  document,
  readOnly,
  onStatus,
  onSelect,
}: {
  document: DesignDocument;
  readOnly: boolean;
  onStatus: (key: string, status: ImportNoteStatus) => void;
  onSelect: (nodeId: string) => void;
}) {
  const notes = importNotes(document);
  if (!notes.length) return null;
  const visible = notes.filter((note) => note.status !== "dismissed");
  const dismissed = notes.filter((note) => note.status === "dismissed");
  const unread = visible.filter((note) => !note.status || note.status === "unread").length;
  const actionClass =
    "rounded px-1 py-0.5 text-secondary-ink hover:bg-primary-grey/20 focus-visible:outline-2 focus-visible:outline-primary-orange";
  const renderNote = (note: ImportNote) => {
    const key = importNoteKey(note);
    const linked = note.nodeId && document.nodes.some((node) => node.id === note.nodeId);
    return (
      <li key={key} className="space-y-1">
        <div className="flex items-start gap-2">
          {(!note.status || note.status === "unread") && (
            <span
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary-orange"
              aria-label="Unread"
            />
          )}
          {linked ? (
            <button
              type="button"
              onClick={() => onSelect(note.nodeId!)}
              className="min-w-0 text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary-orange"
            >
              {note.message}
            </button>
          ) : (
            <p className="min-w-0">{note.message}</p>
          )}
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            {note.status === "dismissed" ? (
              <button type="button" className={actionClass} onClick={() => onStatus(key, "read")}>
                Restore
              </button>
            ) : (
              <>
                {(!note.status || note.status === "unread") && (
                  <button
                    type="button"
                    className={actionClass}
                    onClick={() => onStatus(key, "read")}
                  >
                    Mark as read
                  </button>
                )}
                <button
                  type="button"
                  className={actionClass}
                  onClick={() => onStatus(key, "dismissed")}
                >
                  Dismiss
                </button>
              </>
            )}
          </div>
        )}
      </li>
    );
  };
  return (
    <details className="shrink-0 border-t border-primary-grey/70 text-xs text-secondary-ink">
      <summary className="cursor-pointer px-3 py-3 font-medium hover:bg-primary-grey/15 focus-visible:outline-2 focus-visible:outline-primary-orange">
        Import notes · {visible.length}
        {unread > 0 && <span className="ml-2 text-primary-orange">{unread} unread</span>}
      </summary>
      <div className="max-h-[30dvh] space-y-3 overflow-y-auto overscroll-contain px-3 pb-3 [overflow-wrap:anywhere]">
        {visible.length > 0 && <ul className="space-y-3">{visible.map(renderNote)}</ul>}
        {dismissed.length > 0 && (
          <details>
            <summary className="cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-primary-orange">
              Dismissed · {dismissed.length}
            </summary>
            <ul className="mt-2 space-y-3">{dismissed.map(renderNote)}</ul>
          </details>
        )}
      </div>
    </details>
  );
});
