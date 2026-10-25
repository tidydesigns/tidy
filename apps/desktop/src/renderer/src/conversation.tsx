import {
  memo,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@tidy/ui/button";
import type { DesktopAPI, Message, Thread } from "../../shared/contracts";
import { MessageAttachments } from "./message-attachments";
import { ToolActivityGroup } from "./tool-activity";
import { ChatLink } from "./chat-link";
import { parseChatLink } from "../../shared/chat-links";
import { MarkdownPreview } from "./markdown-preview";

const positions = new Map<string, { top: number; following: boolean }>();
const markdownPlugins = [remarkGfm];
const MessageBody = memo(function MessageBody({
  message,
  api,
  projectId,
}: {
  message: Message;
  api: DesktopAPI;
  projectId: string;
}) {
  return message.role === "user" ? (
    <div className="message-text">{message.text}</div>
  ) : (
    <div className="message-markdown">
      <Markdown
        remarkPlugins={markdownPlugins}
        skipHtml
        urlTransform={(url) =>
          parseChatLink(url)?.kind === "file" ? url : defaultUrlTransform(url)
        }
        components={{
          a: ({ href, children }) => (
            <ChatLink href={href} api={api} projectId={projectId}>
              {children}
            </ChatLink>
          ),
          img: ({ alt }) => <span className="muted">{alt || "Image"}</span>,
        }}
      >
        {message.text}
      </Markdown>
    </div>
  );
});

function TurnButton({
  prompt,
  index,
  ...props
}: ComponentProps<typeof Button> & { prompt: string; index: number }) {
  const label = useMemo(() => prompt.replace(/\s+/g, " ").slice(0, 100) || "Attachment", [prompt]);
  return <Button {...props} aria-label={`Jump to turn ${index + 1}: ${label}`} />;
}

export function Conversation({
  thread,
  identity,
  api,
  active,
}: {
  thread?: Thread;
  identity: string;
  api: DesktopAPI;
  active: boolean;
}) {
  const previewId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(positions.get(identity)?.following ?? true);
  const initialized = useRef(false);
  const visible = useRef(active);
  visible.current = active;
  const lastUser = useRef<string | undefined>(undefined);
  const frame = useRef(0);
  const measureRef = useRef(() => {});
  const nodes = useRef(new Map<string, HTMLElement>());
  const [atEnd, setAtEnd] = useState(true);
  const [current, setCurrent] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);

  const turns = useMemo(() => {
    const result: { id: string; prompt: string; response: string }[] = [];
    for (const message of thread?.messages ?? []) {
      if (message.role === "user")
        result.push({ id: message.id, prompt: message.text, response: "" });
      else if (result.length) result[result.length - 1].response = message.text;
    }
    return result;
  }, [thread?.messages]);
  const toolsByMessage = useMemo(() => {
    const result = new Map<string, NonNullable<Thread["toolActivities"]>>();
    for (const tool of thread?.toolActivities ?? []) {
      const list = result.get(tool.afterMessageId) ?? [];
      list.push(tool);
      result.set(tool.afterMessageId, list);
    }
    return result;
  }, [thread?.toolActivities]);

  function measure() {
    const element = viewport.current;
    if (!element || !visible.current || !element.clientHeight) return;
    const end = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
    setAtEnd(end);
    const top = element.getBoundingClientRect().top + 48;
    let index = 0;
    for (let i = turns.length - 1; i >= 0; i--) {
      const node = nodes.current.get(turns[i].id);
      if (node && node.getBoundingClientRect().top <= top) {
        index = i;
        break;
      }
    }
    setCurrent(index);
    rememberPosition(element);
  }
  function rememberPosition(element: HTMLDivElement) {
    positions.delete(identity);
    positions.set(identity, { top: element.scrollTop, following: following.current });
    const oldest = positions.keys().next();
    if (positions.size > 100 && !oldest.done) positions.delete(oldest.value);
  }
  measureRef.current = measure;
  function latest() {
    following.current = true;
    const element = viewport.current;
    if (element) element.scrollTop = element.scrollHeight;
    measure();
  }
  function jump(index: number) {
    const element = viewport.current;
    const node = nodes.current.get(turns[index]?.id);
    if (!element || !node) return;
    following.current = false;
    element.scrollTop +=
      node.getBoundingClientRect().top - element.getBoundingClientRect().top - 20;
    setCurrent(index);
    setPreview(null);
    measure();
  }

  useLayoutEffect(() => {
    if (!active || !thread || !viewport.current) return;
    const user = turns.at(-1)?.id;
    if (!initialized.current) {
      const saved = positions.get(identity);
      if (saved) viewport.current.scrollTop = saved.top;
      else latest();
      initialized.current = true;
    } else if (user !== lastUser.current) {
      following.current = true;
    }
    lastUser.current = user;
    const saved = positions.get(identity);
    if (saved && !following.current) viewport.current.scrollTop = saved.top;
    if (following.current) viewport.current.scrollTop = viewport.current.scrollHeight;
    measure();
  }, [active, thread?.messages, thread?.toolActivities, thread?.status]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame.current);
      frame.current = requestAnimationFrame(() => {
        if (!visible.current) return;
        if (following.current && viewport.current)
          viewport.current.scrollTop = viewport.current.scrollHeight;
        measureRef.current();
      });
    });
    if (content.current) observer.observe(content.current);
    if (viewport.current) observer.observe(viewport.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, []);

  const selected = preview === null ? null : turns[preview];
  const running = thread?.status === "running";
  return (
    <div className="conversation">
      <div
        className="transcript"
        ref={viewport}
        tabIndex={0}
        aria-label="Conversation"
        onWheel={(event) => {
          if (event.deltaY < 0) following.current = false;
        }}
        onTouchMove={() => {
          following.current = false;
        }}
        onClickCapture={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest(".tool-activity-group summary, .tool-detail-toggle")
          )
            following.current = false;
        }}
        onKeyDown={(event) => {
          if (
            ["ArrowUp", "PageUp", "Home"].includes(event.key) ||
            (["Enter", " "].includes(event.key) &&
              event.target instanceof Element &&
              event.target.closest(".tool-activity-group summary, .tool-detail-toggle"))
          )
            following.current = false;
        }}
        onScroll={(event) => {
          if (!visible.current || !event.currentTarget.clientHeight) return;
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
          rememberPosition(element);
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(measure);
        }}
      >
        <div className="conversation-content" ref={content}>
          {thread?.toolActivityTruncated && (
            <p className="tool-log-notice">Earlier tool activity omitted</p>
          )}
          {thread?.messages.map((message) => (
            <div
              key={message.id}
              className="conversation-entry"
              ref={(node) => {
                if (node) nodes.current.set(message.id, node);
                else nodes.current.delete(message.id);
              }}
            >
              <article
                className={`message message-${message.role}`}
                aria-label={message.role === "user" ? "Your message" : "Assistant message"}
              >
                <MessageBody message={message} api={api} projectId={thread.projectId} />
                {message.attachments && message.attachments.length > 0 && (
                  <MessageAttachments
                    api={api}
                    projectId={thread.projectId}
                    files={message.attachments}
                  />
                )}
              </article>
              <ToolActivityGroup
                activities={toolsByMessage.get(message.id) ?? []}
                visible={active}
              />
            </div>
          ))}
          {running &&
            !thread.pendingApprovals?.length &&
            !thread.toolActivities?.some((tool) => tool.status === "running") && (
              <p className="thread-activity" role="status">
                <span className="working-dot" />
                {thread.activity ?? "Working"}
              </p>
            )}
          {thread?.error && (
            <p className="thread-error" role="alert">
              {thread.error}
            </p>
          )}
          {thread?.status === "stopped" && <p className="thread-activity">Stopped</p>}
        </div>
      </div>
      {turns.length > 1 && (
        <nav
          className="conversation-rail"
          aria-label="Conversation turns"
          onPointerLeave={() => setPreview(null)}
          onWheel={(event) => {
            if (viewport.current) {
              following.current = false;
              viewport.current.scrollTop += event.deltaY;
            }
          }}
        >
          <div
            className="conversation-ticks"
            style={{ height: Math.min(288, (turns.length - 1) * 8) }}
          >
            {turns.map((turn, index) => (
              <TurnButton
                key={turn.id}
                prompt={turn.prompt}
                index={index}
                className={`conversation-tick ${preview === index ? "previewing" : ""}`}
                data-hover-distance={
                  preview === null ? undefined : Math.min(3, Math.abs(index - preview))
                }
                aria-current={current === index ? "step" : undefined}
                aria-describedby={preview === index ? previewId : undefined}
                tabIndex={(preview ?? current) === index ? 0 : -1}
                style={{
                  top: `${turns.length <= 1 ? 0 : (index / (turns.length - 1)) * 100}%`,
                  height: Math.min(8, 288 / (turns.length - 1)),
                }}
                onPointerEnter={() => setPreview(index)}
                onFocus={() => setPreview(index)}
                onBlur={() => setPreview(null)}
                onClick={() => jump(index)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setPreview(null);
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    const buttons =
                      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>(
                        "button",
                      );
                    if (!buttons?.length) return;
                    const next = Math.max(
                      0,
                      Math.min(buttons.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
                    );
                    buttons[next]?.focus();
                  }
                }}
              >
                <span />
              </TurnButton>
            ))}
            {selected && (
              <div
                className="conversation-turn-preview"
                id={previewId}
                role="tooltip"
                style={{
                  top: `${((preview ?? 0) / Math.max(1, turns.length - 1)) * 100}%`,
                }}
              >
                <strong>{selected.prompt || "Attachment"}</strong>
                {selected.response && <MarkdownPreview text={selected.response} />}
              </div>
            )}
          </div>
        </nav>
      )}
      {thread?.messages.length && !atEnd ? (
        <Button className="latest-message" onClick={latest} aria-label="Jump to latest message">
          ↓ Latest
        </Button>
      ) : null}
    </div>
  );
}
