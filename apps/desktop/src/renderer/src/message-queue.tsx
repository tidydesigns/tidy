import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@tidy/ui/button";
import { Icon } from "@tidy/editor/components/ui/icon";
import { MessageActionIcon } from "./message-action-icon";
import type { QueueAction, QueuedMessage } from "../../shared/message-queue";

export function MessageQueue({
  messages,
  running,
  error,
  onChange,
  onRecover,
}: {
  messages: QueuedMessage[];
  running: boolean;
  error?: string;
  onChange(action: QueueAction): void;
  onRecover(message: QueuedMessage): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [drag, setDrag] = useState<{ messageId: string; beforeId: string | null } | null>(null);
  const listId = useId();
  if (!messages.length) return null;
  return (
    <section className="message-queue" aria-label="Message queue">
      <div className="queue-heading">
        <Button
          type="button"
          className="queue-disclosure"
          aria-label={`${expanded ? "Collapse" : "Expand"} queued messages (${messages.length})`}
          aria-expanded={expanded}
          aria-controls={listId}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name="menu" size={14} />
          <span>Queued</span>
          {!running && <span className="queue-status">Paused</span>}
          <span className="queue-count">{messages.length}</span>
          <svg
            aria-hidden="true"
            className="queue-chevron"
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
      </div>
      {error && (
        <p className="queue-error" role="alert">
          {error}
        </p>
      )}
      <ol
        id={listId}
        className="queue-list"
        hidden={!expanded}
        onDrop={(event) => {
          if (!drag) return;
          event.preventDefault();
          setDrag(null);
          if (
            drag.beforeId !== drag.messageId &&
            messages.some((message) => message.id === drag.messageId) &&
            (drag.beforeId === null || messages.some((message) => message.id === drag.beforeId))
          )
            onChange({ kind: "move", ...drag });
        }}
        onDragLeave={(event) => {
          if (
            event.relatedTarget instanceof Node &&
            event.currentTarget.contains(event.relatedTarget)
          )
            return;
          setDrag((current) => current && { ...current, beforeId: current.messageId });
        }}
      >
        {messages.map((message, index) => (
          <QueueRow
            key={message.id}
            message={message}
            index={index}
            running={running}
            onChange={onChange}
            onRecover={onRecover}
            onMove={(direction) =>
              onChange({
                kind: "move",
                messageId: message.id,
                beforeId: messages[index + (direction === -1 ? -1 : 2)]?.id ?? null,
              })
            }
            first={index === 0}
            last={index === messages.length - 1}
            dragging={drag?.messageId === message.id}
            dropPosition={
              drag && drag.beforeId !== drag.messageId
                ? drag.beforeId === message.id
                  ? "before"
                  : drag.beforeId === null && index === messages.length - 1
                    ? "after"
                    : undefined
                : undefined
            }
            onDragStart={() => setDrag({ messageId: message.id, beforeId: message.id })}
            onDragEnd={() => setDrag(null)}
            onDragOver={(after) => {
              if (!drag) return;
              const source = messages.findIndex((item) => item.id === drag.messageId);
              if (source === -1) return;
              const insertion = index + (after ? 1 : 0);
              const beforeId =
                insertion === source || insertion === source + 1
                  ? drag.messageId
                  : (messages[insertion]?.id ?? null);
              if (beforeId !== drag.beforeId) setDrag({ ...drag, beforeId });
            }}
            canDrop={Boolean(drag)}
          />
        ))}
      </ol>
    </section>
  );
}

function QueueRow({
  message,
  index,
  running,
  first,
  last,
  onChange,
  onMove,
  onRecover,
  dragging,
  dropPosition,
  onDragStart,
  onDragEnd,
  onDragOver,
  canDrop,
}: {
  message: QueuedMessage;
  index: number;
  running: boolean;
  first: boolean;
  last: boolean;
  onChange(action: QueueAction): void;
  onMove(direction: -1 | 1): void;
  onRecover(message: QueuedMessage): void;
  dragging: boolean;
  dropPosition?: "before" | "after";
  onDragStart(): void;
  onDragEnd(): void;
  onDragOver(after: boolean): void;
  canDrop: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(message.text);
  const cancelled = useRef(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const recovery = useRef<(() => void) | undefined>(undefined);
  recovery.current =
    editing && text !== message.text ? () => onRecover({ ...message, text }) : undefined;
  useEffect(
    () => () => {
      if (!cancelled.current) recovery.current?.();
    },
    [],
  );
  function finish() {
    recovery.current = undefined;
    setEditing(false);
    if (!cancelled.current && text !== message.text && (text.trim() || message.attachments?.length))
      onChange({ kind: "edit", messageId: message.id, text });
  }
  return (
    <li
      className="queue-row"
      data-dragging={dragging || undefined}
      data-drop-position={dropPosition}
      onDragOver={(event) => {
        if (!canDrop) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        const bounds = event.currentTarget.getBoundingClientRect();
        onDragOver(event.clientY >= bounds.top + bounds.height / 2);
      }}
    >
      <Button
        type="button"
        className="queue-icon queue-drag-handle"
        draggable={!editing}
        disabled={editing || (first && last)}
        aria-label={`Reorder queued message ${index + 1}`}
        title="Drag to reorder, or use the arrow keys"
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-tidy-queued-message", message.id);
          event.dataTransfer.effectAllowed = "move";
          onDragStart();
        }}
        onDragEnd={onDragEnd}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            if (event.key === "ArrowUp" && !first) onMove(-1);
            if (event.key === "ArrowDown" && !last) onMove(1);
          }
        }}
      >
        <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
          <circle cx="9" cy="5" r="1.5" />
          <circle cx="15" cy="5" r="1.5" />
          <circle cx="9" cy="12" r="1.5" />
          <circle cx="15" cy="12" r="1.5" />
          <circle cx="9" cy="19" r="1.5" />
          <circle cx="15" cy="19" r="1.5" />
        </svg>
      </Button>
      <div className="queue-content">
        {editing ? (
          <textarea
            autoFocus
            aria-label={`Edit queued message ${index + 1}`}
            value={text}
            maxLength={32_000}
            rows={2}
            onChange={(event) => setText(event.target.value)}
            onBlur={finish}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
              if (event.key === "Escape") {
                event.preventDefault();
                cancelled.current = true;
                setEditing(false);
                editButton.current?.focus();
              } else if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.blur();
                editButton.current?.focus();
              }
            }}
          />
        ) : (
          <span className="queue-text" title={message.text || "Attached files"}>
            {message.text || "Attached files"}
          </span>
        )}
        {Boolean(message.attachments?.length) && (
          <span className="queue-attachments">
            {message.attachments?.map((file) => file.name).join(", ")}
          </span>
        )}
      </div>
      <div className="queue-row-actions">
        <Button
          type="button"
          className="queue-icon"
          title="Edit message"
          ref={editButton}
          aria-label={`Edit queued message ${index + 1}`}
          onClick={() => {
            cancelled.current = false;
            setText(message.text);
            setEditing(true);
          }}
        >
          <svg
            aria-hidden="true"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m15 5 4 4M4 20l4-1L20 7a2.8 2.8 0 0 0-4-4L4 15z" />
          </svg>
        </Button>
        <Button
          type="button"
          className="quiet-button queue-steer"
          title={running ? "Use this instruction in the active turn" : "Send this message now"}
          aria-label={`Send queued message ${index + 1} now`}
          onClick={() => onChange({ kind: "steer", messageId: message.id })}
        >
          <MessageActionIcon action="steer" />
          Send now
        </Button>
        <Button
          type="button"
          className="queue-icon"
          title="Remove message"
          aria-label={`Remove queued message ${index + 1}`}
          onClick={() => {
            cancelled.current = true;
            onChange({ kind: "remove", messageId: message.id });
          }}
        >
          <Icon name="xmark" size={12} />
        </Button>
      </div>
    </li>
  );
}
