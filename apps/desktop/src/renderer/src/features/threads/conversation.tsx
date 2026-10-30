import { ThreadVideo } from "./video/thread-video";
import { videoMimeType } from "../../../../shared/contracts/video-preview";
import { HarnessFailureDialog, HarnessFailureSummary } from "./harness-failure-dialog";
import { codeFontClassName } from "../../styles/code-ui";
import {
  memo,
  useCallback,
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
import { showToast } from "@tidy/ui/toast";
import { Icon } from "@tidy/editor/components/ui/icon";
import type { DesktopAPI, Message, Thread } from "../../../../shared/contracts/desktop";
import { attachmentText } from "../../../../shared/models/attachment-references";
import { AttachmentText, MessageAttachments } from "../composer/message-attachments";
import { groupTurnActivity } from "./turn-activity";
import { ChatLink } from "../../components/chat-link";
import { parseChatLink } from "../../../../shared/models/chat-links";
import { MarkdownPreview } from "../../components/markdown-preview";
import { TurnStatus } from "./turn-status";
import { remarkCompleteBlocks, useBlockReveal, useBufferedMarkdown } from "./streamed-markdown";

const messageTime = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const positions = new Map<string, { top: number; following: boolean }>();
const MarkdownContent = memo(function MarkdownContent({
  text,
  streaming,
  minimum,
  active,
  api,
  projectId,
  threadId,
}: {
  text: string;
  streaming: boolean;
  minimum: number;
  active: boolean;
  api: DesktopAPI;
  projectId: string;
  threadId: string;
}) {
  const markdownPlugins = useMemo<ComponentProps<typeof Markdown>["remarkPlugins"]>(
    () => [remarkGfm, [remarkCompleteBlocks, { text, streaming, minimum }]],
    [text, minimum, streaming],
  );
  const markdownComponents = useMemo<ComponentProps<typeof Markdown>["components"]>(
    () => ({
      a: ({ href, children }) => {
        const link = parseChatLink(href);
        return href && link?.kind === "file" && videoMimeType(link.path) ? (
          <ThreadVideo
            key={href}
            api={api}
            input={{ projectId, threadId, href }}
            name={link.name}
            active={active}
          />
        ) : (
          <ChatLink href={href} api={api} projectId={projectId}>
            {children}
          </ChatLink>
        );
      },
      img: ({ alt, src }) => {
        const link = typeof src === "string" ? parseChatLink(src) : null;
        return typeof src === "string" && link?.kind === "file" && videoMimeType(link.path) ? (
          <ThreadVideo
            key={src}
            api={api}
            input={{ projectId, threadId, href: src }}
            name={link.name}
            active={active}
          />
        ) : (
          <span className="text-xs text-muted-ink">{alt || "Image"}</span>
        );
      },
    }),
    [api, projectId, threadId, active],
  );
  return (
    <Markdown
      remarkPlugins={markdownPlugins}
      skipHtml
      urlTransform={(url) => (parseChatLink(url)?.kind === "file" ? url : defaultUrlTransform(url))}
      components={markdownComponents}
    >
      {text}
    </Markdown>
  );
});

const MessageBody = memo(function MessageBody({
  message,
  api,
  projectId,
  threadId,
  streaming,
  visible,
}: {
  message: Message;
  api: DesktopAPI;
  projectId: string;
  threadId: string;
  streaming: boolean;
  visible: boolean;
}) {
  const buffered = useBufferedMarkdown(message.text, streaming && visible);
  const revealing = useBlockReveal(streaming && visible);
  return message.role === "user" ? (
    <div className="message-text whitespace-pre-wrap">
      <AttachmentText text={message.text} files={message.attachments ?? []} />
    </div>
  ) : (
    <div
      className="message-markdown [&_table]:text-sm [&_th]:font-semibold [&_strong]:font-semibold"
      data-streaming={streaming && visible ? "" : undefined}
      data-revealing={revealing && visible ? "" : undefined}
    >
      <MarkdownContent
        text={buffered.text}
        streaming={streaming}
        minimum={buffered.minimum}
        active={visible}
        api={api}
        projectId={projectId}
        threadId={threadId}
      />
    </div>
  );
});

const ConversationEntry = memo(function ConversationEntry({
  message,
  activities,
  active,
  streaming,
  statusThread,
  api,
  projectId,
  threadId,
  nodes,
}: {
  message: Message;
  activities: NonNullable<Thread["toolActivities"]>;
  active: boolean;
  streaming: boolean;
  statusThread?: Thread;
  api: DesktopAPI;
  projectId: string;
  threadId: string;
  nodes: Map<string, HTMLElement>;
}) {
  const register = useCallback(
    (node: HTMLDivElement | null) => {
      if (node) nodes.set(message.id, node);
      else nodes.delete(message.id);
    },
    [message.id, nodes],
  );
  const sentAt = message.sentAt ?? message.turn?.startedAt;
  return (
    <div className="conversation-entry" ref={register}>
      <div
        className={
          message.role === "user"
            ? "group/prompt relative ml-auto w-fit max-w-[90%] pb-7.5"
            : undefined
        }
      >
        <article
          className={`message message-${message.role} text-[15px] leading-[1.65] wrap-anywhere ${message.role === "user" ? "rounded-[12px_12px_4px_12px] bg-subtle-fill px-4 py-3" : "mt-6 mb-7 text-[light-dark(#292929,#e2e2e2)]"}`}
          aria-label={message.role === "user" ? "Your message" : "Assistant message"}
        >
          <MessageBody
            message={message}
            api={api}
            projectId={projectId}
            threadId={threadId}
            streaming={streaming}
            visible={active}
          />
          {message.attachments && message.attachments.length > 0 && (
            <MessageAttachments api={api} projectId={projectId} files={message.attachments} />
          )}
        </article>
        {message.role === "user" && (
          <div className="pointer-events-none absolute right-0 bottom-0 flex h-7 items-center gap-2 text-xs text-muted-ink opacity-0 group-focus-within/prompt:pointer-events-auto group-focus-within/prompt:opacity-100 group-hover/prompt:pointer-events-auto group-hover/prompt:opacity-100">
            {sentAt && (
              <time dateTime={sentAt} title={new Date(sentAt).toLocaleString()}>
                {messageTime.format(new Date(sentAt))}
              </time>
            )}
            <Button
              type="button"
              className="flex size-7 cursor-pointer items-center justify-center rounded-md hover:text-[light-dark(#292929,#ffffff)] focus-visible:outline-2 focus-visible:outline-offset-2"
              aria-label="Copy prompt"
              title="Copy prompt"
              onClick={() => {
                void navigator.clipboard.writeText(message.text).then(
                  () => showToast("Prompt copied", "success"),
                  () => showToast("Could not copy the prompt. Please try again."),
                );
              }}
            >
              <Icon name="copy" size={16} />
            </Button>
          </div>
        )}
      </div>
      {message.role === "user" && (
        <TurnStatus
          message={message}
          thread={statusThread}
          visible={active}
          activities={activities}
        />
      )}
    </div>
  );
});
const emptyActivities: NonNullable<Thread["toolActivities"]> = [];

const TurnButton = memo(function TurnButton({
  id,
  prompt,
  index,
  count,
  previewId,
  previewing,
  distance,
  current,
  focusable,
  onPreview,
  onJump,
}: {
  id: string;
  prompt: string;
  index: number;
  count: number;
  previewId: string;
  previewing: boolean;
  distance?: number;
  current: boolean;
  focusable: boolean;
  onPreview: (index: number | null) => void;
  onJump: (id: string, index: number) => void;
}) {
  const label = useMemo(() => prompt.replace(/\s+/g, " ").slice(0, 100) || "Attachment", [prompt]);
  return (
    <Button
      aria-label={`Jump to turn ${index + 1}: ${label}`}
      className={`conversation-tick ${previewing ? "previewing" : ""}`}
      data-hover-distance={distance}
      aria-current={current ? "step" : undefined}
      aria-describedby={previewing ? previewId : undefined}
      tabIndex={focusable ? 0 : -1}
      style={{
        top: `${count <= 1 ? 0 : (index / (count - 1)) * 100}%`,
        height: Math.min(8, 288 / (count - 1)),
      }}
      onPointerEnter={() => onPreview(index)}
      onFocus={() => onPreview(index)}
      onBlur={() => onPreview(null)}
      onClick={() => onJump(id, index)}
      onKeyDown={(event) => {
        if (event.key === "Escape") onPreview(null);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          const buttons =
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button");
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
    </Button>
  );
});

export const Conversation = memo(function Conversation({
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
  const [showFailure, setShowFailure] = useState(false);
  useEffect(() => {
    if (!thread?.error || !active) setShowFailure(false);
  }, [thread?.error, active]);
  const previewId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const following = useRef(positions.get(identity)?.following ?? true);
  const scrollTarget = useRef<number | undefined>(undefined);
  const initialized = useRef(false);
  const visible = useRef(active);
  visible.current = active;
  const lastUser = useRef<string | undefined>(undefined);
  const frame = useRef(0);
  const resizeFrame = useRef(0);
  const measureRef = useRef(() => {});
  const nodes = useRef(new Map<string, HTMLElement>());
  const [atEnd, setAtEnd] = useState(true);
  const [current, setCurrent] = useState(0);
  const [preview, setPreview] = useState<number | null>(null);

  const turns = useMemo(() => {
    const result: { id: string; prompt: string; response: string }[] = [];
    for (const message of thread?.messages ?? []) {
      if (message.role === "user")
        result.push({
          id: message.id,
          prompt: attachmentText(message.text, message.attachments ?? []),
          response: "",
        });
      else if (result.length) result[result.length - 1].response = message.text;
    }
    return result;
  }, [thread?.messages]);
  const previousToolsByTurn = useRef<ReturnType<typeof groupTurnActivity>>(new Map());
  const toolsByTurn = useMemo(
    () =>
      groupTurnActivity(
        {
          messages: thread?.messages ?? [],
          toolActivities: thread?.toolActivities,
        },
        previousToolsByTurn.current,
      ),
    [thread?.messages, thread?.toolActivities],
  );
  useLayoutEffect(() => {
    previousToolsByTurn.current = toolsByTurn;
  }, [toolsByTurn]);

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
  function scrollTo(top: number) {
    const element = viewport.current;
    if (!element) return;
    element.scrollTop = top;
    scrollTarget.current = element.scrollTop;
  }
  function latest() {
    following.current = true;
    const element = viewport.current;
    if (element) scrollTo(element.scrollHeight);
    measure();
  }
  const jump = useCallback((id: string, index: number) => {
    const element = viewport.current;
    const node = nodes.current.get(id);
    if (!element || !node) return;
    following.current = false;
    scrollTo(
      element.scrollTop +
        node.getBoundingClientRect().top -
        element.getBoundingClientRect().top -
        Number.parseFloat(getComputedStyle(element).paddingTop),
    );
    setCurrent(index);
    setPreview(null);
    measureRef.current();
  }, []);

  useLayoutEffect(() => {
    if (!active || !thread || !viewport.current) return;
    const user = turns.at(-1)?.id;
    if (!initialized.current) {
      const saved = positions.get(identity);
      if (saved) scrollTo(saved.top);
      else latest();
      initialized.current = true;
    } else if (user !== lastUser.current) {
      following.current = true;
    }
    lastUser.current = user;
    const saved = positions.get(identity);
    if (saved && !following.current) scrollTo(saved.top);
    if (following.current) scrollTo(viewport.current.scrollHeight);
    measure();
  }, [active, thread?.messages, thread?.toolActivities, thread?.status]);

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame.current);
      resizeFrame.current = requestAnimationFrame(() => {
        if (!visible.current) return;
        if (following.current && viewport.current) scrollTo(viewport.current.scrollHeight);
        measureRef.current();
      });
    });
    if (content.current) observer.observe(content.current);
    if (viewport.current) observer.observe(viewport.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(resizeFrame.current);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  const selected = preview === null ? null : turns[preview];
  const running = thread?.status === "running";
  const prompts = thread?.messages.filter((message) => message.role === "user");
  const currentTurn = (
    prompts
      ?.slice()
      .reverse()
      .find((message) => message.turn) ?? prompts?.at(-1)
  )?.id;
  const streamingMessage =
    running && thread.activity === "Replying" ? thread.messages.at(-1)?.id : undefined;
  return (
    <div className="conversation relative min-h-0 min-w-0 flex-1">
      <div
        className={`transcript h-full min-h-0 overflow-auto overscroll-contain px-[max(var(--chat-gutter),calc((100%_-_var(--chat-content-width))_/_2))] pt-8 pb-5 [overflow-anchor:none] [scroll-padding-bottom:20px] [scrollbar-width:thin] [scrollbar-color:var(--color-border)_transparent] focus-visible:outline focus-visible:outline-border focus-visible:-outline-offset-1 max-[700px]:pt-6 [scroll-padding-top:32px] max-[700px]:[scroll-padding-top:24px] ${codeFontClassName}`}
        ref={viewport}
        tabIndex={0}
        role="region"
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
          const atEnd = element.scrollHeight - element.scrollTop - element.clientHeight <= 40;
          const programmatic =
            scrollTarget.current !== undefined &&
            Math.abs(element.scrollTop - scrollTarget.current) < 1;
          if (!programmatic) scrollTarget.current = undefined;
          if (!programmatic || atEnd) following.current = atEnd;
          rememberPosition(element);
          cancelAnimationFrame(frame.current);
          frame.current = requestAnimationFrame(measure);
        }}
      >
        <div className="conversation-content flow-root" ref={content}>
          {thread?.toolActivityTruncated && (
            <p className="tool-log-notice">Earlier tool activity omitted</p>
          )}
          {thread?.messages.map((message) => (
            <ConversationEntry
              key={message.id}
              message={message}
              activities={toolsByTurn.get(message.id) ?? emptyActivities}
              active={active}
              streaming={message.role === "assistant" && message.id === streamingMessage}
              statusThread={message.id === currentTurn ? thread : undefined}
              api={api}
              projectId={thread.projectId}
              threadId={thread.id}
              nodes={nodes.current}
            />
          ))}
          {thread?.error && (
            <HarnessFailureSummary
              error={thread.error}
              kind={thread.errorKind}
              onDetails={() => setShowFailure(true)}
            />
          )}
          {thread?.status === "stopped" && !thread.messages.some((message) => message.turn) && (
            <p className="thread-activity text-xs wrap-anywhere">Stopped</p>
          )}
        </div>
      </div>
      {showFailure && thread?.error && active && (
        <HarnessFailureDialog thread={thread} api={api} onClose={() => setShowFailure(false)} />
      )}
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
                id={turn.id}
                count={turns.length}
                previewId={previewId}
                previewing={preview === index}
                distance={preview === null ? undefined : Math.min(3, Math.abs(index - preview))}
                current={current === index}
                focusable={(preview ?? current) === index}
                onPreview={setPreview}
                onJump={jump}
              />
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
        <Button
          className="latest-message absolute bottom-2.5 left-1/2 -translate-x-1/2 cursor-pointer rounded-[20px] border border-border bg-(--desktop-surface) px-[13px] py-[7px] text-xs text-ink shadow-[0_3px_14px_#0001]"
          onClick={latest}
          aria-label="Jump to latest message"
        >
          ↓ Latest
        </Button>
      ) : null}
    </div>
  );
});
