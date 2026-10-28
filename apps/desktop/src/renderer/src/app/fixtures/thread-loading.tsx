import { useDeferredValue, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
  DesktopAPI,
  DesktopEvent,
  ProjectSnapshot,
  Thread,
} from "../../../../shared/contracts/desktop";
import type { ToolActivity } from "../../../../shared/contracts/tool-activity";
import { summarizeThread } from "../../../../shared/models/thread-updates";
import { lazyView } from "../../components/lazy-view";
import { Conversations } from "../../features/threads/conversations";
import { ToolActivityGroup } from "../../features/threads/tool-activity";
import { ThreadSidebar } from "../../features/threads/thread-sidebar";
import { useWorkspaceState } from "../use-workspace-state";

const projectId = crypto.randomUUID();
const timestamp = "2026-10-20T12:00:00.000Z";
const host = required(document.getElementById("root"), "Test root");
const nativeAPI = required(window.tidy, "Native preload API");

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function required<T>(value: T | null | undefined, label: string): T {
  check(value !== null && value !== undefined, `${label} is missing`);
  return value;
}

function frame(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, 50);
    const scheduled = requestAnimationFrame(finish);
    function finish() {
      clearTimeout(timer);
      cancelAnimationFrame(scheduled);
      resolve();
    }
  });
}

async function settle() {
  await frame();
  await frame();
  await frame();
}

async function until(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await frame();
  }
}

function makeThread({ count = 8 }: { count?: number } = {}): Thread {
  const id = crypto.randomUUID();
  return {
    id,
    projectId,
    revision: 1,
    title: id,
    harness: "codex",
    status: "running",
    designIds: [],
    updatedAt: timestamp,
    messages: Array.from({ length: count }, (_, index): Thread["messages"][number] => ({
      id: crypto.randomUUID(),
      role: index % 2 ? "assistant" : "user",
      text:
        index % 2
          ? `## Response ${index}\n\nA **formatted** response.\n\n${"Conversation content. ".repeat(40)}`
          : `Request ${index} in ${id}`,
    })),
  };
}

function visibleTranscript(): HTMLDivElement {
  return required(
    [...host.querySelectorAll<HTMLDivElement>(".transcript")].find(
      (element) => element.getBoundingClientRect().height > 0,
    ),
    "Visible transcript",
  );
}

function conversationFixture(root: Root) {
  const a = makeThread();
  const b = makeThread();
  const c = makeThread();
  const d = makeThread();
  const threads = { [a.id]: a, [b.id]: b, [c.id]: c, [d.id]: d };
  function render({
    selected,
    active = true,
    project = projectId,
  }: {
    selected: string | null;
    active?: boolean;
    project?: string;
  }) {
    flushSync(() =>
      root.render(
        <Conversations
          key={project}
          projectId={project}
          selected={selected}
          threads={threads}
          api={nativeAPI}
          active={active}
        />,
      ),
    );
  }
  return { a, b, c, d, threads, render };
}

type ReadRequest = {
  resolve(value: Thread): void;
  reject(cause: Error): void;
};

async function workspaceFixture(root: Root) {
  const initial = makeThread({ count: 2 });
  const listeners = new Set<(event: DesktopEvent) => void>();
  const requests = new Map<string, ReadRequest>();
  const calls: { projectId: string; threadId: string }[] = [];
  const snapshot: ProjectSnapshot = {
    project: { id: projectId, path: "/synthetic/project", name: "Fixture", openedAt: timestamp },
    threads: [summarizeThread(initial)],
    designs: [],
    folders: [],
  };
  const api: Pick<DesktopAPI, "bootstrap" | "selectProject" | "readThread" | "onEvent"> = {
    async bootstrap() {
      return { projects: [snapshot.project], harnesses: [], activeProject: snapshot };
    },
    async selectProject(id) {
      check(id === projectId, "Unexpected project selection");
      return snapshot;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    readThread(projectId, threadId) {
      calls.push({ projectId, threadId });
      return new Promise((resolve, reject) => requests.set(threadId, { resolve, reject }));
    },
  };
  let current: ReturnType<typeof useWorkspaceState> | undefined;
  const errors: unknown[] = [];
  function Probe() {
    const navigation = useRef(0);
    current = useWorkspaceState({ api, navigation, onError: (error) => errors.push(error) });
    return null;
  }
  flushSync(() => root.render(<Probe />));
  const state = () => required(current, "Workspace state");
  await until(() => !state().loading, "Workspace bootstrap");
  function emit(event: DesktopEvent) {
    flushSync(() => {
      for (const listener of listeners) listener(event);
    });
  }
  const pending = (id: string) => required(requests.get(id), "Pending read");
  return { initial, state, calls, pending, emit, listeners, errors };
}

async function runThreadLoadingTests(): Promise<string[]> {
  const passed: string[] = [];
  async function run(name: string, test: (root: Root) => Promise<void>) {
    sessionStorage.clear();
    const root = createRoot(host);
    try {
      await test(root);
      passed.push(name);
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      flushSync(() => root.unmount());
      check(host.childElementCount === 0, "Renderer test leaked mounted content");
    }
  }

  await run("failed lazy views stay local and retry with current props", async (root) => {
    function Loaded({ value }: { value: string }) {
      return <p data-loaded-view>{value}</p>;
    }
    const loads: {
      resolve(module: { default: typeof Loaded }): void;
      reject(error: Error): void;
    }[] = [];
    let loadError: unknown;
    const View = lazyView(
      () =>
        new Promise<{ default: typeof Loaded }>((resolve, reject) =>
          loads.push({ resolve, reject }),
        ),
      {
        label: "test view",
        onError: (_props, error) => {
          loadError = error;
        },
      },
    );
    function Fixture({ value }: { value: string }) {
      const [count, setCount] = useState(0);
      return (
        <>
          <button data-neighbor onClick={() => setCount(count + 1)}>
            {count}
          </button>
          <View value={value} />
        </>
      );
    }
    flushSync(() => root.render(<Fixture value="original" />));
    check(host.querySelector('[aria-label="Loading test view"]'), "Missing pending view status");
    const neighbor = required(host.querySelector<HTMLButtonElement>("[data-neighbor]"), "Neighbor");
    flushSync(() => neighbor.click());
    required(loads[0], "Initial import").reject(new Error("Fixture chunk failure"));
    await until(() => Boolean(host.querySelector('[role="alert"]')), "Local load error");
    check(
      loadError instanceof Error && loadError.message === "Fixture chunk failure",
      "Load failure was not reported",
    );
    check(host.contains(neighbor) && neighbor.textContent === "1", "Failure reset adjacent UI");
    const clickButton = (name: string) =>
      required(
        [...host.querySelectorAll("button")].find((button) => button.textContent === name),
        name,
      ).click();
    clickButton("Reload app");
    check(
      host.querySelector('dialog[open][aria-label="Reload app?"]'),
      "Reload skipped confirmation",
    );
    check(
      host.contains(neighbor) && neighbor.textContent === "1",
      "Opening confirmation changed app state",
    );
    clickButton("Cancel");
    check(!host.querySelector("dialog[open]"), "Cancel left confirmation open");
    check(host.contains(neighbor) && neighbor.textContent === "1", "Cancel changed app state");
    flushSync(() => root.render(<Fixture value="updated" />));
    required(
      [...host.querySelectorAll("button")].find(
        (button) => button.textContent === "Retry test view",
      ),
      "Retry action",
    ).click();
    await until(() => loads.length === 2, "Fresh lazy import on retry");
    check(host.querySelector('[aria-label="Loading test view"]'), "Retry has no pending status");
    required(loads[1], "Retry import").resolve({ default: Loaded });
    await until(() => Boolean(host.querySelector("[data-loaded-view]")), "Recovered view");
    check(
      host.querySelector("[data-loaded-view]")?.textContent === "updated",
      "Retry lost current props",
    );
    check(!host.querySelector('[role="alert"]'), "Retry retained the previous error");
    check(host.contains(neighbor) && neighbor.textContent === "1", "Retry reset adjacent UI");
  });

  await run("recent thread returns preserve DOM, scroll and turn navigation", async (root) => {
    const { a, b, render } = conversationFixture(root);
    render({ selected: a.id });
    check(
      host.querySelector('[aria-label="Loading conversation"]'),
      "Missing initial transcript status",
    );
    await until(
      () =>
        [...host.querySelectorAll(".transcript")].some(
          (node) => node.getBoundingClientRect().height > 0,
        ),
      "First lazy-loaded transcript",
    );
    await settle();
    const viewport = visibleTranscript();
    check(
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 41,
      "Initial view did not follow the latest message",
    );
    const original = required(viewport.querySelector("article"), "Original message");
    viewport.scrollTop = Math.floor((viewport.scrollHeight - viewport.clientHeight) / 2);
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
    const top = viewport.scrollTop;
    check(top > 0, "Fixture needs scrollable history");
    render({ selected: b.id });
    await settle();
    render({ selected: a.id });
    await settle();
    check(
      visibleTranscript().querySelector("article") === original,
      "Returning rebuilt the message DOM",
    );
    check(Math.abs(visibleTranscript().scrollTop - top) < 2, "Returning lost the scroll position");
    const rail = required(
      [...host.querySelectorAll<HTMLElement>(".conversation-rail")].find(
        (node) => node.getBoundingClientRect().height > 0,
      ),
      "Turn rail",
    );
    required(rail.querySelector("button"), "First turn button").click();
    await until(() => visibleTranscript().scrollTop < 80, "Jump to first turn");
  });

  await run("streaming retains selection, tool disclosure and turn targets", async (root) => {
    const { a, threads, render } = conversationFixture(root);
    const tool: ToolActivity = {
      id: crypto.randomUUID(),
      afterMessageId: a.messages[0].id,
      kind: "command",
      title: "Inspect",
      toolName: "Shell",
      status: "running",
      startedAt: timestamp,
      output: "Partial output",
    };
    threads[a.id] = { ...a, toolActivities: [tool] };
    render({ selected: a.id });
    await settle();
    const viewport = visibleTranscript();
    const article = required(viewport.querySelector("article"), "First message");
    const group = required(viewport.querySelector(".tool-activity-group summary"), "Tool group");
    group.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await until(() => Boolean(viewport.querySelector(".tool-call")), "Tool rows");
    required(viewport.querySelector(".tool-call summary"), "Tool row").dispatchEvent(
      new MouseEvent("click", { bubbles: true }),
    );
    await until(() => Boolean(viewport.querySelector("pre")), "Tool output");
    const selection = required(window.getSelection(), "Text selection");
    const range = document.createRange();
    range.selectNodeContents(article);
    selection.removeAllRanges();
    selection.addRange(range);
    const selectedText = selection.toString();
    const last = required(a.messages.at(-1), "Last message");
    threads[a.id] = {
      ...a,
      revision: 2,
      messages: [...a.messages.slice(0, -1), { ...last, text: `${last.text} Streamed text` }],
      toolActivities: [
        { ...tool, status: "completed", endedAt: timestamp, output: "Final output" },
      ],
    };
    render({ selected: a.id });
    await settle();
    check(viewport.querySelector("article") === article, "Streaming replaced an earlier message");
    check(selection.toString() === selectedText, "Streaming changed the selection");
    check(viewport.textContent?.includes("Streamed text"), "Streamed message did not update");
    const row = required(viewport.querySelector<HTMLDetailsElement>(".tool-call"), "Open tool");
    check(
      row.open && row.querySelector("pre")?.textContent === "Final output",
      "Tool update lost disclosure or output",
    );
    required(host.querySelector<HTMLButtonElement>(".conversation-tick"), "First turn").click();
    await until(() => viewport.scrollTop < 80, "Updated turn target");
    selection.removeAllRanges();
  });

  await run("a cold thread fills its existing selected view when data arrives", async (root) => {
    const { a, threads, render } = conversationFixture(root);
    delete threads[a.id];
    render({ selected: a.id });
    const viewport = visibleTranscript();
    check(viewport.querySelectorAll("article").length === 0, "Unloaded thread displayed history");
    threads[a.id] = a;
    render({ selected: a.id });
    const content = required(viewport.querySelector(".conversation-content"), "Content");
    const delayed = document.createElement("div");
    delayed.style.height = "200px";
    content.append(delayed);
    check(
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight > 40,
      "Late message layout must move the bottom beyond the following threshold",
    );
    await new Promise<void>((resolve) => {
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        viewport.dispatchEvent(new Event("scroll"));
        resolve();
      });
      observer.observe(content);
    });
    await until(
      () => viewport.querySelectorAll("article").length === a.messages.length,
      "Render cold thread response",
    );
    check(visibleTranscript() === viewport, "Data arrival replaced the selected view");
    await until(
      () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 41,
      "Cold thread follows latest message",
    );
  });

  await run(
    "hidden threads freeze DOM and show current streamed content when selected",
    async (root) => {
      const { a, b, threads, render } = conversationFixture(root);
      render({ selected: a.id });
      await settle();
      render({ selected: b.id });
      await settle();
      threads[a.id] = {
        ...a,
        revision: 2,
        messages: [
          ...a.messages,
          { id: crypto.randomUUID(), role: "assistant", text: "Background response" },
        ],
      };
      render({ selected: b.id });
      await settle();
      check(
        !host.textContent?.includes("Background response"),
        "Hidden transcript rendered a streaming update",
      );
      render({ selected: a.id });
      await until(
        () => Boolean(visibleTranscript().textContent?.includes("Background response")),
        "Show current background response",
      );
      render({ selected: a.id, active: false });
      await settle();
      const prior = required(threads[a.id], "Active thread");
      threads[a.id] = {
        ...prior,
        revision: 3,
        messages: [
          ...prior.messages,
          { id: crypto.randomUUID(), role: "assistant", text: "Inactive response" },
        ],
      };
      render({ selected: a.id, active: false });
      await settle();
      check(
        !host.textContent?.includes("Inactive response"),
        "Inactive workspace rendered a streaming update",
      );
      render({ selected: a.id });
      await until(
        () => Boolean(visibleTranscript().textContent?.includes("Inactive response")),
        "Reactivate workspace",
      );
      await settle();
      const viewport = visibleTranscript();
      await until(
        () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 41,
        "Stream updates follow the latest message after workspace reactivation",
      );
    },
  );

  await run("view retention evicts old DOM and isolates drafts and projects", async (root) => {
    const { a, b, c, d, threads, render } = conversationFixture(root);
    render({ selected: a.id });
    await settle();
    const original = required(visibleTranscript().querySelector("article"), "Original message");
    for (const thread of [b, c, d]) {
      render({ selected: thread.id });
      await settle();
    }
    check(
      host.querySelectorAll(".conversation").length === 3,
      "Rendered view count exceeded its budget",
    );
    check(!host.contains(original), "Least recently visited DOM was retained");
    render({ selected: null });
    await settle();
    check(
      visibleTranscript().querySelectorAll("article").length === 0,
      "Draft displayed another thread's messages",
    );
    const other = { ...makeThread({ count: 2 }), projectId: crypto.randomUUID() };
    threads[other.id] = other;
    render({ selected: other.id, project: other.projectId });
    await settle();
    check(
      host.querySelectorAll(".conversation").length === 1,
      "Project navigation retained the previous project's views",
    );
  });

  await run("collapsed tool logs defer rows and retain expanded output on reopen", async (root) => {
    const output = "one\ntwo\nthree\nfour\nFinal output";
    const activities: ToolActivity[] = Array.from({ length: 2 }, () => ({
      id: crypto.randomUUID(),
      afterMessageId: crypto.randomUUID(),
      kind: "command",
      title: "Inspect",
      toolName: "Shell",
      status: "completed",
      startedAt: timestamp,
      endedAt: timestamp,
      output,
    }));
    flushSync(() => root.render(<ToolActivityGroup activities={activities} visible />));
    check(host.querySelectorAll(".tool-call").length === 0, "Collapsed logs mounted hidden rows");
    const group = required(
      host.querySelector<HTMLDetailsElement>(".tool-activity-group"),
      "Tool group",
    );
    required(group.querySelector("summary"), "Group summary").click();
    await until(
      () => host.querySelectorAll(".tool-call").length === activities.length,
      "Expand tool rows",
    );
    const row = required(group.querySelector<HTMLDetailsElement>(".tool-call"), "Tool row");
    required(row.querySelector("summary"), "Tool summary").click();
    await until(() => Boolean(row.querySelector("pre")), "Expand tool output");
    check(
      !row.querySelector("pre")?.textContent?.includes("Final output"),
      "Full output appeared before disclosure",
    );
    required(
      row.querySelector<HTMLButtonElement>(".tool-detail-toggle"),
      "Full output button",
    ).click();
    await until(() => row.querySelector("pre")?.textContent === output, "Show full output");
    required(group.querySelector("summary"), "Group summary").click();
    await until(() => !group.open, "Collapse group");
    required(group.querySelector("summary"), "Group summary").click();
    await until(() => group.open, "Reopen group");
    check(
      row.open && row.querySelector("pre")?.textContent === output,
      "Reopening discarded tool disclosure state",
    );
  });

  await run(
    "pending thread reads are shared and newer events survive late disk responses",
    async (root) => {
      const { initial, state, calls, pending, emit, errors } = await workspaceFixture(root);
      const request = { projectId, threadId: initial.id };
      const first = state().readThread(request);
      check(
        state().readThread(request) === first && calls.length === 1,
        "Pending reads were duplicated",
      );
      check(
        calls[0]?.projectId === projectId && calls[0]?.threadId === initial.id,
        "Read arguments were swapped",
      );
      emit({ type: "thread", thread: makeThread({ count: 2 }) });
      check(
        state().readThread(request) === first && calls.length === 1,
        "Unrelated streaming restarted the read",
      );
      const live = { ...initial, revision: 3, title: "Current live title" };
      emit({ type: "thread", thread: live });
      pending(initial.id).resolve(initial);
      await first;
      await settle();
      check(state().threads[initial.id] === live, "Late disk response replaced live state");
      await state().readThread(request);
      check(calls.length === 1, "Cached thread triggered another disk read");
      check(errors.length === 0, "Successful reads reported an error");
    },
  );

  await run(
    "stale events preserve state identity and equal-revision snapshots still reconcile",
    async (root) => {
      const { initial, state, emit } = await workspaceFixture(root);
      const live = { ...initial, revision: 3 };
      emit({ type: "thread", thread: live });
      const threads = state().threads;
      const snapshots = state().snapshots;
      const { messages, toolActivities, ...metadata } = initial;
      emit({
        type: "thread-patch",
        thread: metadata,
        summary: summarizeThread(initial),
        messages,
        toolActivities: toolActivities ?? [],
        toolActivityIds: [],
      });
      emit({ type: "thread", thread: initial });
      check(
        state().threads === threads && state().snapshots === snapshots,
        "Stale events replaced state containers",
      );
      emit({ type: "thread", thread: { ...live, title: "Reconciled title" } });
      check(
        state().threads[initial.id]?.title === "Reconciled title",
        "Equal-revision full response did not reconcile",
      );
      check(
        state().snapshots[projectId]?.threads[0]?.title === "Reconciled title",
        "Summary did not reconcile",
      );
    },
  );

  await run("failed reads can retry and unmount releases event listeners", async (root) => {
    const { initial, state, calls, pending, listeners } = await workspaceFixture(root);
    const request = { projectId, threadId: initial.id };
    const cause = new Error("Synthetic read failure");
    const first = state()
      .readThread(request)
      .catch((error: unknown) => error);
    pending(initial.id).reject(cause);
    check((await first) === cause, "Read failure was swallowed");
    const retry = state().readThread(request);
    check(calls.length === 2, "Failed request remained cached");
    pending(initial.id).resolve(initial);
    await retry;
    await until(() => state().threads[initial.id] === initial, "Retry fills thread state");
    flushSync(() => root.render(null));
    check(listeners.size === 0, "Unmount leaked an event listener");
  });
  await run(
    "rapid deferred searches retain order and finish with the latest query",
    async (root) => {
      const first = { ...makeThread({ count: 1 }), title: "Alpha search" };
      const second = { ...makeThread({ count: 1 }), title: "Beta loading" };
      const completed = { ...makeThread({ count: 1 }), title: "Alpha done", doneAt: timestamp };
      const summaries = [first, second, completed].map(summarizeThread);
      let update: (query: string) => void = () => {};
      let selected: string | undefined;
      const renderThread = (item: (typeof summaries)[number]) => (
        <button
          data-search-result={item.id}
          onClick={() => {
            selected = item.id;
          }}
        >
          {item.title}
        </button>
      );
      function Search() {
        const [query, setQuery] = useState("");
        update = setQuery;
        const deferredQuery = useDeferredValue(query);
        return (
          <>
            <input aria-label="Query" readOnly value={query} />
            <ThreadSidebar
              projectId={projectId}
              threads={summaries}
              search={deferredQuery}
              renderThread={renderThread}
            />
          </>
        );
      }
      flushSync(() => root.render(<Search />));
      await settle();
      const results = () => [...host.querySelectorAll<HTMLButtonElement>("[data-search-result]")];
      flushSync(() => update("Alpha"));
      check(host.querySelector("input")?.value === "Alpha", "Input did not update immediately");
      flushSync(() => update("Beta"));
      flushSync(() => update("missing"));
      flushSync(() => update("  ALPHA  "));
      await until(
        () =>
          results().length === 2 &&
          results().every((item) => item.textContent?.startsWith("Alpha")),
        "Latest search results",
      );
      check(results()[0].dataset.searchResult === first.id, "Active result order changed");
      check(host.querySelector("details")?.open, "Matching done threads stayed collapsed");
      results()[0].focus();
      results()[0].click();
      check(selected === first.id, "Search selected a different thread");
      flushSync(() => update(""));
      await until(() => results().length === 3, "Clear search restores all results");
      check(results()[1].dataset.searchResult === second.id, "Clearing search changed order");
    },
  );

  return passed;
}

Object.assign(window, { runThreadLoadingTests });
