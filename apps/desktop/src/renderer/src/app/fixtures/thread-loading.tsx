import { runFileLocationTests } from "./file-location";
import { FileNavigationContext } from "../../features/repository/file-navigation";
import { runFileNavigationTests } from "./file-navigation";
import { runBrowserInputTests } from "./browser-input";
import type { Draft } from "../../features/composer/machine-context";
import { runHarnessUsageTests } from "./harness-usage";
import { runAppUpdateTests } from "./app-update";
import { runDraftNavigationTests } from "./draft-navigation";
import { ThreadVideo } from "../../features/threads/video/thread-video";
import type { ThreadTask } from "../../../../shared/contracts/thread-tasks";
import { ThreadWorkPermission } from "../../features/threads/thread-work-permission";
import { AgentTasks } from "../../features/threads/agent-tasks";
import { Conversation } from "../../features/threads/conversation";
import { ThreadTitle } from "../../features/threads/thread-title";
import { ThreadNamingSettings } from "../../features/settings/thread-naming-settings";
import {
  currentThreadNaming,
  selectThreadNaming,
} from "../../features/settings/thread-naming-preferences";
import { HarnessFailureNotices } from "../../features/threads/harness-failure-dialog";
import { StrictMode, useDeferredValue, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
  DesktopAPI,
  Bootstrap,
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
import { ThreadReadingContext } from "../../features/threads/thread-reading";
import { PrivacySettings } from "../../features/settings/privacy-settings";
import { readAnalyticsState } from "../../features/settings/analytics-state";
import { ANALYTICS_NOTICE, type AnalyticsAPI, type AnalyticsState } from "@tidy/design/analytics";
import { ThreadCard } from "../../features/threads/thread-card";
import { pullRequestStatus } from "../../components/pull-request-status";
import { RemoteMachines } from "../../features/settings/remote-machines";
import { Settings } from "../../features/settings/settings";
import type { MachineBridge } from "../../../../shared/remote";
import { UserFacingError } from "@tidy/ui/errors";
import { SelectMenu } from "@tidy/ui/select-menu";
import { ComposerControls } from "../../features/composer/composer-controls";
import { HarnessControls } from "../../features/harnesses/harness-controls";
import { DesktopShell, SidebarToggle, SidebarNavigation } from "../desktop-shell";
import { WorkspaceSurfaces } from "../../features/workspace/workspace-surfaces";
import { ProjectSwitcher } from "../../features/workspace/project-switcher";
import { ProjectSetupDialog } from "../../features/composer/project-setup-dialog";
import { SkillPrompt } from "../../features/composer/skill-prompt";
import type { AttachedFile } from "../../../../shared/contracts/attachments";
import type { ProjectSetupResult } from "../../../../shared/contracts/workspace-response";
import { useWorkspaceState } from "../use-workspace-state";
import { NavigationScope } from "../session-state";
import { readSidebarCache, writeSidebarCache } from "../sidebar-cache";

const projectId = crypto.randomUUID();
const timestamp = "2026-10-20T12:00:00.000Z";
const host = required(document.getElementById("root"), "Test root");
const nativeAPI = { ...required(window.tidy, "Native preload API"), readThreadTasks: undefined };

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function required<T>(value: T | null | undefined, label: string): T {
  check(value !== null && value !== undefined, `${label} is missing`);
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
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
    scope = "local",
  }: {
    selected: string | null;
    active?: boolean;
    project?: string;
    scope?: string;
  }) {
    flushSync(() =>
      root.render(
        <Conversations
          key={scope}
          projectId={project}
          selected={selected}
          threads={{ ...threads }}
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
  let online = true;
  let bootstraps = 0;
  const api: Pick<DesktopAPI, "bootstrap" | "selectProject" | "readThread" | "onEvent"> = {
    async bootstrap() {
      bootstraps++;
      if (!online) return { projects: [], harnesses: [], activeProject: null };
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
  let changeConnection: (connection: string) => void = () => {};
  function Probe() {
    const navigation = useRef(0);
    const [connection, setConnection] = useState("connected");
    changeConnection = setConnection;
    current = useWorkspaceState({
      api,
      navigation,
      connection,
      onError: (error) => errors.push(error),
    });
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
  return {
    initial,
    state,
    calls,
    pending,
    emit,
    listeners,
    errors,
    get bootstraps() {
      return bootstraps;
    },
    connection(connected: boolean) {
      online = connected;
      flushSync(() => changeConnection(connected ? "connected" : "offline"));
    },
  };
}

export async function runHarnessFailureNoticeTests(root: Root) {
  const listeners = new Set<(event: DesktopEvent) => void>();
  const api: DesktopAPI = {
    ...nativeAPI,
    onEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const render = (accessKey: string) =>
    flushSync(() =>
      root.render(
        <StrictMode>
          <HarnessFailureNotices key={accessKey} api={api} />
        </StrictMode>,
      ),
    );
  render("initial-access");
  await settle();
  const thread = {
    ...makeThread(),
    status: "failed" as const,
    error: "The provider could not complete this request.",
    errorKind: "policy" as const,
  };
  const emit = (value: Thread) => {
    for (const listener of listeners) listener({ type: "thread", thread: value });
  };
  const modal = () => host.querySelector<HTMLDialogElement>("dialog[open]");
  emit({ ...thread, id: "historical-failure" });
  emit({ ...thread, id: "historical-failure", revision: 2, doneAt: timestamp });
  await settle();
  check(!modal(), "Historical failure opened a new dialog after a metadata update");
  emit({ ...thread, status: "running", error: undefined });
  emit(thread);
  await until(() => Boolean(modal()), "Failure dialog");
  await settle();
  check(modal()?.querySelector("h2")?.textContent === "Request blocked", "Policy guidance missing");
  check(
    document.activeElement?.getAttribute("aria-label") === "Dismiss error",
    "Dismiss did not receive initial focus",
  );
  check(!modal()?.querySelector("details")?.open, "Technical details expanded by default");
  emit({ ...thread, revision: 2 });
  modal()?.close();
  await until(() => !modal(), "Dismiss failure");
  emit({ ...thread, revision: 3 });
  await settle();
  check(!modal(), "Duplicate failure reopened a dismissed dialog");
  emit({ ...thread, revision: 4, status: "running", error: undefined });
  emit({ ...thread, revision: 3 });
  await settle();
  check(!modal(), "Stale failure interrupted a retry");
  emit({ ...thread, revision: 5 });
  await until(() => Boolean(modal()), "New failure after retry");
  const previousDialog = required(modal(), "Previous failure dialog");
  previousDialog.close();
  emit({ ...thread, revision: 6, status: "running", error: undefined });
  emit({ ...thread, revision: 7, errorKind: "account", error: "Verification required" });
  await until(
    () => modal()?.querySelector("h2")?.textContent === "Account needs attention",
    "Replacement failure after immediate retry",
  );
  await settle();
  check(Boolean(modal()), "Old close event dismissed the replacement failure");
  emit({ ...thread, id: "second-failure", status: "running", error: undefined });
  emit({
    ...thread,
    id: "second-failure",
    errorKind: undefined,
    error: "401 authentication failed",
  });
  await settle();
  modal()?.close();
  await until(
    () => modal()?.querySelector("h2")?.textContent === "Sign in again",
    "Queued background failure",
  );
  emit({ ...thread, id: "second-failure", revision: 2, status: "running", error: undefined });
  await until(() => !modal(), "Retry removes stale dialog");
  emit({ ...thread, revision: 8, status: "running", error: undefined });
  emit({ ...thread, revision: 9 });
  emit({ ...thread, id: "second-failure", revision: 3, status: "running", error: undefined });
  emit({ ...thread, id: "second-failure", revision: 4 });
  await until(() => Boolean(modal()), "Open and queued failures before access change");
  render("changed-access");
  await settle();
  check(!modal(), "Access change retained a previous account’s failure dialog");
  emit({ ...thread, revision: 10 });
  emit({ ...thread, id: "second-failure", revision: 5 });
  await settle();
  check(!modal(), "Access change retained queued failures or replayed historical errors");
  check(listeners.size === 1, "Access change leaked an event subscription");
}

function videoVisibilityFixture() {
  const NativeObserver = window.IntersectionObserver;
  const observers = new Map<IntersectionObserver, (visible: boolean) => void>();
  window.IntersectionObserver = class extends NativeObserver {
    constructor(
      private readonly notify: IntersectionObserverCallback,
      options?: IntersectionObserverInit,
    ) {
      super(notify, options);
    }
    override observe(target: Element) {
      const show = (visible: boolean) => {
        const bounds = target.getBoundingClientRect();
        this.notify(
          [
            {
              target,
              boundingClientRect: bounds,
              intersectionRect: bounds,
              intersectionRatio: visible ? 1 : 0,
              isIntersecting: visible,
              rootBounds: bounds,
              time: performance.now(),
            },
          ],
          this,
        );
      };
      observers.set(this, show);
      show(true);
    }
    override disconnect() {
      observers.delete(this);
      super.disconnect();
    }
  };
  return {
    show: (visible: boolean) => {
      for (const show of observers.values()) show(visible);
    },
    restore: () => {
      window.IntersectionObserver = NativeObserver;
    },
  };
}

async function runThreadLoadingTests(filter = ""): Promise<string[]> {
  const passed: string[] = [];
  async function run(name: string, test: (root: Root) => Promise<void>) {
    if (!name.includes(filter)) return;
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

  await run("file locations preserve focus and reveal exact characters", runFileLocationTests);

  await run(
    "chat file references reveal sidebar lines and ignore stale host responses",
    runFileNavigationTests,
  );

  await run(
    "workspace sidebar adapts to narrow screens and preserves explicit toggles",
    async (root) => {
      flushSync(() =>
        root.render(
          <DesktopShell canvasFocused={false}>
            <SidebarNavigation className="desktop-navigation workspace-header">
              <SidebarToggle />
            </SidebarNavigation>
          </DesktopShell>,
        ),
      );
      const shell = required(host.querySelector<HTMLElement>(".desktop"), "Workspace shell");
      const narrow = window.matchMedia("(max-width: 800px)").matches;
      const navigation = required(
        shell.querySelector<HTMLElement>(".desktop-navigation"),
        "Navigation",
      );
      const collapsed = () => getComputedStyle(navigation).display === "none";
      check(collapsed() === narrow, "Initial sidebar does not match available width");
      const toggle = () =>
        required(
          shell.querySelector<HTMLButtonElement>(
            collapsed()
              ? ".desktop-sidebar-reopen button"
              : ".desktop-navigation .desktop-sidebar-toggle",
          ),
          "Sidebar toggle",
        ).click();
      toggle();
      await until(() => collapsed() !== narrow, "Explicit sidebar toggle");
      toggle();
      await until(() => collapsed() === narrow, "Sidebar toggle restores initial state");
    },
  );

  await run(
    "composer controls retain their labels, values and focus across available widths",
    async (root) => {
      let rename: (name: string) => void = () => {};
      function Probe() {
        const [name, setName] = useState("Standard model");
        rename = setName;
        return (
          <div data-composer-host className="@container/composer flex gap-2" style={{ width: 600 }}>
            <ComposerControls>
              <button className="size-8 shrink-0" aria-label="Attach files">
                +
              </button>
              <div className="composer-settings contents">
                <HarnessControls
                  harness="codex"
                  settings={{ model: "default", effort: "low" }}
                  disabled={false}
                  catalogs={[
                    {
                      connection: { id: "codex", name: "Codex", status: "ready" },
                      loading: false,
                      details: {
                        models: [{ id: "default", name, efforts: ["low", "high"] }],
                        windows: [],
                        updatedAt: timestamp,
                        usagePage: "subscription",
                      },
                    },
                  ]}
                  onModelChange={() => {}}
                  onSettingsChange={() => {}}
                  onRefresh={() => {}}
                />
              </div>
            </ComposerControls>
            <button className="size-8 shrink-0" aria-label="Send">
              ↑
            </button>
          </div>
        );
      }
      flushSync(() => root.render(<Probe />));
      const container = required(
        host.querySelector<HTMLElement>("[data-composer-host]"),
        "Composer host",
      );
      const controls = required(
        container.querySelector<HTMLElement>(".composer-controls"),
        "Composer controls",
      );
      const model = required(
        container.querySelector<HTMLButtonElement>(".model-trigger"),
        "Model control",
      );
      const permissions = required(
        container.querySelector<HTMLButtonElement>(".permission-trigger"),
        "Permission control",
      );
      await until(() => controls.dataset.compactCount === "0", "Full composer labels");
      permissions.click();
      await until(() => Boolean(container.querySelector(":popover-open")), "Permissions open");
      const focused = document.activeElement;
      container.style.width = "240px";
      await until(() => controls.dataset.compactCount === "3", "Narrow composer controls");
      check(
        model.getBoundingClientRect().width >= 31 && model.getBoundingClientRect().width <= 33,
        "Model did not compact to its icon width",
      );
      check(permissions.getBoundingClientRect().width <= 33, "Permission label did not compact");
      const label = required(
        model.querySelector<HTMLElement>("span:not(.model-provider-icon)"),
        "Model label",
      );
      check(
        getComputedStyle(label).visibility === "hidden" &&
          model.title === model.getAttribute("aria-label") &&
          model.title.includes("Model:"),
        "Compact model lost its accessible label",
      );
      check(document.activeElement === focused, "Compaction lost menu focus");
      check(container.querySelector(".model-trigger") === model, "Compaction replaced its trigger");
      flushSync(() => rename("A much longer model name"));
      await until(
        () => model.title.includes("A much longer model name"),
        "Changed selected model label",
      );
      container.style.width = "600px";
      await until(() => controls.dataset.compactCount === "0", "Composer labels restored");
      check(document.activeElement === focused, "Expansion lost menu focus");
      check(
        getComputedStyle(label).visibility === "visible" && label.clientWidth > 0,
        "Model label did not return after expansion",
      );
      document.activeElement?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await until(
        () => !container.querySelector(":popover-open"),
        "Permissions close after expansion",
      );
      check(
        document.activeElement === permissions,
        "Closing menu did not restore its original trigger",
      );
    },
  );

  await run(
    "workspace panel preserves chat width on narrow screens and restores focus",
    async (root) => {
      const api = {
        onEvent: () => () => {},
        repositoryDirectory: async () => ({
          entries: [{ path: "file.txt", name: "file.txt", kind: "file" as const }],
          limited: false,
        }),
        repositoryChanges: async () => ({
          repository: true,
          head: null,
          changes: [],
        }),
        repositoryFile: async () => ({ kind: "unavailable" as const, reason: "missing" as const }),
      };
      function Probe() {
        const [open, setOpen] = useState(false);
        return (
          <section
            className="project-workspace surfaces-workspace"
            data-panel-open={open}
            style={{ width: "100%", height: 500 }}
          >
            <div data-chat>
              <button onClick={() => setOpen(true)}>Open panel</button>
            </div>
            <WorkspaceSurfaces
              projectId={projectId}
              repositoryAPI={api}
              active={open}
              open={open}
              onClose={() => setOpen(false)}
            />
          </section>
        );
      }
      flushSync(() => root.render(<Probe />));
      const chat = required(host.querySelector<HTMLElement>("[data-chat]"), "Conversation");
      const trigger = required(chat.querySelector<HTMLButtonElement>("button"), "Panel toggle");
      const workspace = required(chat.parentElement, "Workspace");
      const width = chat.getBoundingClientRect().width;
      const availableWidth = workspace.clientWidth;
      const viewportWidth = window.innerWidth;
      trigger.focus();
      trigger.click();
      const panel = required(
        host.querySelector<HTMLDialogElement>("#workspace-side-panel"),
        "Workspace panel",
      );
      await until(() => panel.open, "Panel opens");
      const narrow = window.matchMedia("(max-width: 980px)").matches;
      check(panel.matches(":modal") === narrow, "Panel presentation does not match viewport");
      if (narrow)
        check(
          Math.abs(
            chat.getBoundingClientRect().width - width - (workspace.clientWidth - availableWidth),
          ) < 1,
          `Overlay compressed the conversation: chat ${width}px → ${chat.getBoundingClientRect().width}px; workspace ${availableWidth}px → ${workspace.clientWidth}px; viewport ${viewportWidth}px → ${window.innerWidth}px; grid ${getComputedStyle(workspace).gridTemplateColumns}; panel ${getComputedStyle(panel).position}`,
        );
      await until(() => Boolean(panel.querySelector('[role="treeitem"]')), "Files load");
      required(panel.querySelector<HTMLButtonElement>('[role="treeitem"]'), "File entry").click();
      await until(
        () =>
          Boolean(
            panel.querySelector(
              '.repository-file-pane:not([hidden]) [aria-label="Close file preview"]',
            ),
          ),
        "File preview opens",
      );
      const explorer = required(
        panel.querySelector<HTMLElement>(".repository-explorer"),
        "File explorer",
      );
      if (panel.clientWidth <= 420)
        check(
          getComputedStyle(explorer).display === "none",
          "File list compressed the narrow preview",
        );
      required(
        panel.querySelector<HTMLButtonElement>('[aria-label="Close file preview"]'),
        "Preview close",
      ).click();
      await until(
        () => document.activeElement === panel.querySelector(".repository-tree"),
        "Closing preview restores file-list focus",
      );
      required(
        panel.querySelector<HTMLButtonElement>('[aria-label="Close side panel"]'),
        "Panel close",
      ).click();
      await until(() => !panel.open, "Panel closes");
      check(document.activeElement === trigger, "Panel did not return focus to its opener");
    },
  );

  await run("browser touch scrolling and soft keyboard editing", runBrowserInputTests);

  await run("open settings menus follow layout resizing without losing focus", async (root) => {
    flushSync(() =>
      root.render(
        <div
          data-menu-host
          style={{
            display: "flex",
            justifyContent: "flex-end",
            width: Math.min(600, window.innerWidth - 24),
          }}
        >
          <SelectMenu
            label="Layout option"
            value="one"
            options={[{ value: "one", label: "First option" }]}
            onChange={() => {}}
            placement="bottom"
            align="end"
            triggerClassName="inline-flex size-8 shrink-0 items-center justify-center"
            triggerContent={<span aria-hidden="true">A</span>}
          />
        </div>,
      ),
    );
    const container = required(host.querySelector<HTMLElement>("[data-menu-host]"), "Menu host");
    const trigger = required(container.querySelector<HTMLButtonElement>("button"), "Menu trigger");
    trigger.click();
    await until(() => Boolean(container.querySelector(":popover-open")), "Settings menu opens");
    const popup = required(container.querySelector<HTMLElement>(":popover-open"), "Settings menu");
    const focused = document.activeElement;
    const triggerWidth = trigger.getBoundingClientRect().width;
    const aligned = () =>
      Math.abs(popup.getBoundingClientRect().right - trigger.getBoundingClientRect().right) < 1;
    await until(aligned, "Initial menu position");
    for (const width of [
      Math.min(320, window.innerWidth - 48),
      Math.min(600, window.innerWidth - 24),
    ]) {
      container.style.width = `${width}px`;
      await until(aligned, "Menu follows its resized layout");
      check(trigger.getBoundingClientRect().width === triggerWidth, "Trigger size changed");
      check(document.activeElement === focused, "Resize lost menu focus");
      check(popup.matches(":popover-open"), "Resize dismissed the menu");
    }
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await until(() => !popup.matches(":popover-open"), "Escape closes the resized menu");
    check(document.activeElement === trigger, "Escape did not restore trigger focus");
  });

  await run(
    "thread names edit immediately, cancel cleanly and expose explicit regeneration",
    async (root) => {
      const initial = { ...makeThread({ count: 1 }), title: "Original name" };
      const renamed: string[] = [];
      let regenerations = 0;
      let finishGeneration = () => {};
      function Probe() {
        const [thread, setThread] = useState(initial);
        const [generating, setGenerating] = useState(false);
        finishGeneration = () => setGenerating(false);
        return (
          <ThreadTitle
            thread={thread}
            generating={generating}
            editRequested={false}
            onEditFinished={() => {}}
            onRename={(_, title) => {
              renamed.push(title);
              setThread((current) => ({ ...current, title, titleSource: "manual" }));
            }}
            onRegenerate={() => {
              regenerations++;
              setGenerating(true);
            }}
          />
        );
      }
      flushSync(() => root.render(<Probe />));
      const heading = () => required(host.querySelector("h1"), "Thread heading");
      flushSync(() => heading().dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
      const input = required(host.querySelector("input"), "Thread name input");
      check(document.activeElement === input, "Renaming did not focus immediately");
      const setValue = required(
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set,
        "Input setter",
      );
      flushSync(() => {
        setValue.call(input, "Navigation polish");
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      flushSync(() =>
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
      );
      check(heading().textContent === "Navigation polish", "Rename was not visible immediately");
      check(renamed.length === 1, "Enter and blur committed twice");
      flushSync(() =>
        heading().dispatchEvent(new KeyboardEvent("keydown", { key: "F2", bubbles: true })),
      );
      const cancelled = required(host.querySelector("input"), "Thread name input");
      flushSync(() => {
        setValue.call(cancelled, "Discard this");
        cancelled.dispatchEvent(new Event("input", { bubbles: true }));
      });
      flushSync(() =>
        cancelled.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
      );
      check(
        renamed.length === 1 && heading().textContent === "Navigation polish",
        "Escape committed a rename",
      );
      const actions = required(
        host.querySelector<HTMLButtonElement>('[aria-label="Thread name actions"]'),
        "Name actions",
      );
      flushSync(() => actions.click());
      const regenerate = required(
        [...host.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) =>
          item.textContent?.includes("Regenerate name"),
        ),
        "Regenerate action",
      );
      flushSync(() => regenerate.click());
      check(regenerations === 1, "Regeneration did not run explicitly");
      check(!host.querySelector('[role="menu"]'), "Name menu stayed open after regeneration");
      check(
        actions.getAnimations({ subtree: true }).length === 3,
        "The three dots did not show regeneration after the menu closed",
      );
      check(heading().textContent === "Navigation polish", "Regeneration hid the current name");
      flushSync(finishGeneration);
      check(
        actions.getAnimations({ subtree: true }).length === 0,
        "The dots kept animating after regeneration finished",
      );
    },
  );

  await run(
    "naming preferences persist immediately and preserve spaces while typing",
    async (root) => {
      const previous = currentThreadNaming();
      try {
        flushSync(() => root.render(<ThreadNamingSettings />));
        const input = required(host.querySelector("textarea"), "Naming instructions");
        const setValue = required(
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set,
          "Textarea setter",
        );
        flushSync(() => {
          setValue.call(input, "Short task ");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        });
        check(
          currentThreadNaming().instructions === "Short task ",
          "Spaces were removed while typing",
        );
        check(host.querySelectorAll("select").length === 0, "Naming settings used native selects");
        check(
          ![...host.querySelectorAll("button")].some((item) => item.textContent === "Save"),
          "Naming settings require a save action",
        );
      } finally {
        selectThreadNaming(previous);
      }
    },
  );

  await run(
    "account usage opens immediately, retains refresh state and isolates providers",
    runHarnessUsageTests,
  );

  await run(
    "updates stay visible, reflect native state and reject stale results",
    runAppUpdateTests,
  );

  await run("harness failures deduplicate, queue and clear on retry", runHarnessFailureNoticeTests);

  await run(
    "remote thread images preview through their host without reopening files",
    async (root) => {
      const visibility = videoVisibilityFixture();
      try {
        const png =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSkcAAAAASUVORK5CYII=";
        const source = `data:image/png;base64,${png}`;
        const thread = { ...makeThread({ count: 0 }), status: "completed" as const };
        thread.messages = [
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: "![Remote screenshot](/tmp/remote-screen.png)",
          },
        ];
        let reads = 0;
        let fileOpens = 0;
        const api: DesktopAPI = {
          ...nativeAPI,
          readChatImage: async (project, id, href) => {
            check(
              project === thread.projectId && id === thread.id,
              "Image read used the wrong thread",
            );
            check(href === "/tmp/remote-screen.png", "Image read lost its host path");
            reads++;
            return {
              name: "remote-screen.png",
              dataUrl: source,
              offset: 0,
              size: atob(png).length,
              revision: "image-v1",
            };
          },
          openChatLink: async () => {
            fileOpens++;
          },
        };
        const render = (active: boolean) =>
          flushSync(() =>
            root.render(
              <StrictMode>
                <Conversation thread={thread} identity={thread.id} api={api} active={active} />
              </StrictMode>,
            ),
          );
        render(false);
        await settle();
        check(reads === 0, "Inactive thread loaded its image");
        render(true);
        await until(
          () => Boolean(host.querySelector('[aria-label="Preview Remote screenshot"]')),
          "Remote thumbnail",
        );
        const thumbnail = required(
          host.querySelector<HTMLButtonElement>('[aria-label="Preview Remote screenshot"]'),
          "Remote thumbnail",
        );
        flushSync(() => {
          thumbnail.focus();
          thumbnail.click();
        });
        const preview = required(
          document.querySelector<HTMLDialogElement>(
            'dialog[open][aria-label="Image preview: Remote screenshot"]',
          ),
          "Remote image preview",
        );
        check(preview.matches(":modal"), "Remote preview did not open as a modal");
        check(preview.querySelector("img")?.src === source, "Remote preview used the wrong source");
        check(
          Number(reads) === 1 && fileOpens === 0,
          "Opening the preview fetched or reopened the image",
        );
        preview.requestClose();
        await until(() => !preview.isConnected, "Close remote preview");
        check(document.activeElement === thumbnail, "Remote preview lost thumbnail focus");
      } finally {
        visibility.restore();
      }
    },
  );

  await run(
    "thread videos render inline, defer inactive reads and isolate late responses",
    async (root) => {
      const visibility = videoVisibilityFixture();
      try {
        const thread = { ...makeThread({ count: 0 }), status: "completed" as const };
        thread.messages = [
          {
            id: crypto.randomUUID(),
            role: "assistant",
            text: "[Watch recording](recordings/demo.mp4)",
          },
        ];
        let requests = 0;
        const opened: [string, string][] = [];
        const pending = deferred<Awaited<ReturnType<DesktopAPI["readVideoChunk"]>>>();
        const api: DesktopAPI = {
          ...nativeAPI,
          openChatLink: async (projectId, href) => {
            opened.push([projectId, href]);
          },
          readVideoChunk: async () => {
            requests++;
            if (requests === 2) return pending.promise;
            throw new Error("Video previews support recordings up to 128 MiB.");
          },
        };
        const render = (active: boolean) =>
          flushSync(() =>
            root.render(
              <StrictMode>
                <FileNavigationContext value={(href) => opened.push([thread.projectId, href])}>
                  <Conversation thread={thread} identity={thread.id} api={api} active={active} />
                </FileNavigationContext>
              </StrictMode>,
            ),
          );
        render(false);
        await settle();
        check(requests === 0, "Inactive thread fetched its video");
        check(host.querySelector(".thread-video"), "Video reference did not render inline");
        render(true);
        await until(
          () => Boolean(host.querySelector(".thread-video [role=alert]")),
          "Inline video error",
        );
        check(!document.querySelector("dialog[open]"), "Inline recording opened a dialog");
        check(
          host.textContent?.includes("128 MiB"),
          "Oversized recording lost its size-limit error",
        );
        required(
          host.querySelector<HTMLAnchorElement>('.thread-video [role="alert"] a'),
          "Recording file link after preview failure",
        ).click();
        check(
          opened.length === 1 &&
            opened[0][0] === projectId &&
            opened[0][1] === "recordings/demo.mp4",
          "Preview failure lost the recording's file action",
        );
        required(
          host.querySelector<HTMLButtonElement>(".thread-video-retry"),
          "Retry recording",
        ).click();
        await until(() => requests === 2, "Retry inline recording");
        render(false);
        pending.resolve({ data: "ZGVtbw==", size: 4, mimeType: "video/mp4", revision: "late" });
        await settle();
        check(!host.querySelector("video"), "Late transfer restarted an inactive video");
        render(true);
        await until(
          () => requests === 3 && Boolean(host.querySelector(".thread-video [role=alert]")),
          "Reopen inline recording",
        );
      } finally {
        visibility.restore();
      }
    },
  );

  await run(
    "playable thread videos retain their source and seek position when scrolled away",
    async (root) => {
      const visibility = videoVisibilityFixture();
      const originalRevoke = URL.revokeObjectURL;
      const revoked: string[] = [];
      URL.revokeObjectURL = (url) => {
        revoked.push(url);
        originalRevoke.call(URL, url);
      };
      let requests = 0;
      const data =
        "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAI5EU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEyTbuMU6uEHFO7a1OsggIj7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjMuMS4xMDFXQYxMYXZmNjMuMS4xMDFEiYhAn0AAAAAAABZUrmvXrgEAAAAAAABO14EBc8WIVLBHIumQ0S6cgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QdzWUA4JCwgRC6gRCagQJVsIRVuYEBVe6BAOwBAAAAAAAAAgAAElTDZ/pzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYzLjEuMTAxc3PVY8CLY8WIVLBHIumQ0S5nyKBFo4dFTkNPREVSRIeTTGF2YzYzLjEuMTAxIGxpYnZweGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDIuMDAwMDAwMDAwAB9DtnXt54EAo6OBAACAEAIAnQEqEAAQAABHCIWFiIWEiAICAAwNYAD+/6tQgKOVgQH0ALEBAAEQEAAYABhYL/QACAAAo5WBA+gAsQEAARAQABgAGFgv9AAIAACjlYEF3ACxAQABEBAAGAAYWC/0AAgAABxTu2uRu4+zgQC3iveBAfGCAbHwgQM=";
      const api: DesktopAPI = {
        ...nativeAPI,
        readVideoChunk: async () => {
          requests++;
          return { data, size: atob(data).length, mimeType: "video/webm", revision: "finished" };
        },
      };
      const input = { projectId, threadId: crypto.randomUUID(), href: "recordings/demo.webm" };
      const render = (active: boolean) =>
        flushSync(() =>
          root.render(
            <StrictMode>
              <ThreadVideo api={api} input={input} name="demo.webm" active={active} />
            </StrictMode>,
          ),
        );
      try {
        render(true);
        await until(
          () => (host.querySelector("video")?.readyState ?? 0) >= 1,
          "Decode recording metadata",
        );
        const video = required(host.querySelector("video"), "Inline player");
        check(requests === 1, "Initial video loaded more than once");
        check(video.controls && video.playsInline, "Recording lost its playback controls");
        video.muted = true;
        await video.play();
        await until(() => video.currentTime > 0, "Play recording");
        video.pause();
        video.currentTime = 1;
        await until(() => !video.seeking && video.currentTime >= 0.9, "Seek recording");
        const url = video.currentSrc;
        visibility.show(false);
        await settle();
        check(host.querySelector("video") === video, "Scrolling discarded the player");
        visibility.show(true);
        await settle();
        check(
          host.querySelector("video") === video && video.currentTime >= 0.9,
          "Returning lost playback position",
        );
        check(
          requests === 1 && !revoked.includes(url),
          "Returning transferred the recording again",
        );
        input.href = "recordings/another.webm";
        render(true);
        await until(
          () =>
            host.querySelector("video") !== video &&
            (host.querySelector("video")?.readyState ?? 0) >= 1,
          "Load another recording",
        );
        check(
          host.querySelector("video")?.currentTime === 0,
          "Another recording inherited the seek position",
        );
        render(false);
        await settle();
        check(
          !host.querySelector("video") && revoked.includes(url),
          "Inactive thread retained its video data",
        );
      } finally {
        visibility.restore();
        URL.revokeObjectURL = originalRevoke;
      }
    },
  );

  await run("blank stored thread titles retain labels and row height", async (root) => {
    let expectedHeight = 0;
    for (const title of ["Workspace review", "", "  \n  ", "日本語のレビュー"]) {
      const thread = { ...summarizeThread(makeThread()), title };
      flushSync(() =>
        root.render(
          <ThreadCard
            thread={thread}
            selected={false}
            loaded={false}
            now={Date.now()}
            pending={false}
            onSelect={() => {}}
            onDone={() => {}}
          />,
        ),
      );
      const expected = title.trim() || "New thread";
      const row = required(host.querySelector<HTMLElement>(".thread-item"), "Thread row");
      check(
        row.querySelector(".thread-title")?.textContent === expected,
        "Stored title has no display fallback",
      );
      check(
        row.querySelector(".thread-done")?.getAttribute("aria-label") === `Mark done: ${expected}`,
        "Action has no identifying label",
      );
      const height = row.getBoundingClientRect().height;
      if (!expectedHeight) expectedHeight = height;
      check(height === expectedHeight, "Empty stored title collapsed its row");
      check(thread.title === title, "Rendering changed the stored title");
    }
  });

  await run("sidebar search matches fallback thread titles", async (root) => {
    const threads = ["Workspace review", "", "  \n  ", "NEW THREAD notes"].map((title) => ({
      ...summarizeThread(makeThread()),
      title,
    }));
    for (const search of ["  nEw ThReAd  ", "workspace"]) {
      flushSync(() =>
        root.render(
          <ThreadSidebar
            projectId={projectId}
            threads={threads}
            search={search}
            renderThread={(thread) => (
              <ThreadCard
                thread={thread}
                selected={false}
                loaded={false}
                pending={false}
                now={Date.now()}
                onSelect={() => {}}
                onDone={() => {}}
              />
            )}
          />,
        ),
      );
      const titles = [...host.querySelectorAll(".thread-title")].map((node) => node.textContent);
      check(
        JSON.stringify(titles) ===
          JSON.stringify(
            search === "workspace"
              ? ["Workspace review"]
              : ["New thread", "New thread", "NEW THREAD notes"],
          ),
        "Search results differ from displayed titles",
      );
    }
  });

  await run(
    "thread preloads wait for hover intent and keyboard focus remains immediate",
    async (root) => {
      let preloads = 0;
      flushSync(() =>
        root.render(
          <ThreadCard
            thread={summarizeThread(makeThread())}
            selected={false}
            loaded={false}
            now={Date.now()}
            pending={false}
            onSelect={() => {}}
            onDone={() => {}}
            onPreload={() => {
              preloads++;
            }}
          />,
        ),
      );
      const row = required(host.querySelector(".thread-item"), "Thread row");
      const enter = () =>
        row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" }));
      const leave = () =>
        row.dispatchEvent(
          new PointerEvent("pointerout", {
            bubbles: true,
            pointerType: "mouse",
            relatedTarget: document.body,
          }),
        );
      enter();
      check(preloads === 0, "Crossing a row started a full transcript read");
      leave();
      await new Promise((resolve) => setTimeout(resolve, 200));
      check(preloads === 0, "Leaving a row did not cancel the pending read");
      enter();
      await until(() => Number(preloads) === 1, "Sustained hover preloads");
      leave();
      required(
        host.querySelector<HTMLButtonElement>(".thread-select"),
        "Thread selection",
      ).dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      check(Number(preloads) === 2, "Keyboard focus did not preload immediately");
    },
  );

  await run(
    "cached sidebar PRs stay mounted through bootstrap and sparse refreshes",
    async (root) => {
      const scope = crypto.randomUUID();
      const url = "https://github.com/owner/repo/pull/42";
      const thread = { ...makeThread(), pullRequests: [url] };
      const snapshot: ProjectSnapshot = {
        project: { id: projectId, name: "Cached project", path: "/fixture", openedAt: timestamp },
        threads: [summarizeThread(thread)],
        designs: [],
        folders: [],
      };
      writeSidebarCache({ scope, projects: [snapshot.project], activeProject: snapshot });
      const pending = deferred<Bootstrap>();
      const listeners = new Set<(event: DesktopEvent) => void>();
      const errors: unknown[] = [];
      const status = deferred<"closed">();
      const api = {
        bootstrap: () => pending.promise,
        selectProject: async () => snapshot,
        readThread: async () => thread,
        openChatLink: async () => {},
        pullRequestState: () => status.promise,
        onEvent: (listener: (event: DesktopEvent) => void) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      };
      await pullRequestStatus({
        api: { pullRequestState: async () => "merged" },
        projectId,
        url,
        scope,
      }).refresh();
      let current: ReturnType<typeof useWorkspaceState> | undefined;
      function Probe() {
        const navigation = useRef(0);
        current = useWorkspaceState({ api, navigation, onError: (error) => errors.push(error) });
        const visible = current.activeProjectId
          ? current.snapshots[current.activeProjectId]
          : undefined;
        return visible ? (
          <ThreadSidebar
            projectId={visible.project.id}
            threads={visible.threads}
            search=""
            renderThread={(item) => (
              <ThreadCard
                thread={item}
                api={api}
                selected={false}
                loaded={false}
                pending={false}
                now={Date.now()}
                onSelect={() => {}}
                onDone={() => {}}
              />
            )}
          />
        ) : null;
      }
      flushSync(() =>
        root.render(
          <NavigationScope value={scope}>
            <Probe />
          </NavigationScope>,
        ),
      );
      const link = required(
        host.querySelector<HTMLAnchorElement>(".thread-pull-requests a"),
        "Cached PR link before bootstrap",
      );
      const icon = required(link.querySelector("svg"), "Cached PR icon");
      check(current?.loading, "Bootstrap should still be pending");
      check(icon.getAttribute("data-state") === "merged", "Cached status missing before bootstrap");
      const sparse = { ...snapshot.threads[0], pullRequests: undefined, revision: 2 };
      flushSync(() => {
        for (const listener of listeners) listener({ type: "thread-summary", thread: sparse });
      });
      check(
        host.querySelector(".thread-pull-requests a") === link,
        "Sparse update removed the cached PR",
      );
      pending.resolve({
        projects: [snapshot.project],
        activeProject: { ...snapshot, threads: [sparse] },
        harnesses: [],
      });
      await until(() => !current?.loading, "Refreshed workspace bootstrap");
      check(
        host.querySelector(".thread-pull-requests a") === link,
        "Bootstrap replaced the cached PR link",
      );
      check(
        link.querySelector("svg") === icon &&
          icon.getAttribute("data-state") === "merged" &&
          link.textContent?.includes("#42"),
        "Bootstrap changed the PR contents or cleared its known colour",
      );
      link.focus();
      check(
        getComputedStyle(required(link.querySelector("span"), "PR number")).textDecorationLine ===
          "underline",
        "Focused PR number has no underline",
      );
      flushSync(() =>
        current?.applySnapshot({ ...snapshot, threads: [{ ...sparse, revision: 3 }] }),
      );
      check(
        host.querySelector(".thread-pull-requests a") === link,
        "Snapshot refresh removed the cached PR",
      );
      status.resolve("closed");
      await until(() => icon.getAttribute("data-state") === "closed", "Updated PR status");
      check(
        host.querySelector(".thread-pull-requests a") === link,
        "Status update replaced the link",
      );
      flushSync(() =>
        current?.applySnapshot({
          ...snapshot,
          threads: [{ ...sparse, revision: 4, pullRequests: [] }],
        }),
      );
      check(!link.isConnected, "Explicit PR removal was ignored");
      window.dispatchEvent(new Event("pagehide"));
      check(
        readSidebarCache(scope)?.activeProject?.threads[0].pullRequests?.length === 0,
        "Reload would restore a removed PR",
      );
      check(errors.length === 0, "Workspace refresh failed");
    },
  );

  await run(
    "partial cached lists preserve complete manual order and keyboard changes",
    async (root) => {
      const threads = Array.from({ length: 300 }, (_, index) => ({
        ...summarizeThread(makeThread()),
        title: `Thread ${index}`,
      }));
      const key = `tidy:thread-order:${projectId}`;
      localStorage.setItem(key, JSON.stringify(threads.map((thread) => thread.id)));
      const render = (complete: boolean) =>
        flushSync(() =>
          root.render(
            <ThreadSidebar
              projectId={projectId}
              threads={complete ? threads : threads.slice(0, 256)}
              search=""
              complete={complete}
              renderThread={(thread, orderControls) => (
                <ThreadCard
                  thread={thread}
                  selected={false}
                  loaded={false}
                  pending={false}
                  now={Date.now()}
                  orderControls={orderControls}
                  onSelect={() => {}}
                  onDone={() => {}}
                />
              )}
            />,
          ),
        );
      render(false);
      await settle();
      check(
        localStorage.getItem(key) === JSON.stringify(threads.map((thread) => thread.id)),
        "Cached hydration pruned the saved order",
      );
      const first = required(
        host.querySelector<HTMLButtonElement>(".thread-select"),
        "First cached thread",
      );
      flushSync(() =>
        first.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowDown", altKey: true, bubbles: true }),
        ),
      );
      await settle();
      const expected = [
        threads[1].id,
        threads[0].id,
        ...threads.slice(2).map((thread) => thread.id),
      ];
      check(
        localStorage.getItem(key) === JSON.stringify(expected),
        "Reordering cached rows discarded hidden threads",
      );
      render(true);
      await settle();
      check(
        localStorage.getItem(key) === JSON.stringify(expected),
        "Complete hydration changed the saved order",
      );
      check(
        host.querySelector<HTMLElement>(".thread-order-row")?.dataset.threadId === threads[1].id,
        "Uncached rows jumped ahead of manual order",
      );
    },
  );

  for (const cleared of [false, true]) {
    await run(`startup cache respects a ${cleared ? "cleared" : "saved"} project`, async (root) => {
      const scope = crypto.randomUUID();
      const project = { id: projectId, name: "Saved project", path: "/a", openedAt: timestamp };
      const other = { ...project, id: crypto.randomUUID(), name: "Other project", path: "/b" };
      const snapshot: ProjectSnapshot = { project, threads: [], designs: [], folders: [] };
      const projects = [project, other];
      const bootstrap = { projects, activeProject: { ...snapshot, project: other }, harnesses: [] };
      writeSidebarCache({ scope, projects, activeProject: bootstrap.activeProject });
      const expected = cleared ? null : project.id;
      sessionStorage.setItem(`tidy:navigation:${scope}:project`, JSON.stringify(expected));
      const pending = deferred<Bootstrap>();
      const selected: string[] = [];
      const api = {
        bootstrap: () => pending.promise,
        selectProject: async (id: string) => {
          selected.push(id);
          return snapshot;
        },
        readThread: async () => makeThread(),
        onEvent: () => () => {},
      };
      let current: ReturnType<typeof useWorkspaceState> | undefined;
      function Probe() {
        const navigation = useRef(0);
        current = useWorkspaceState({
          api,
          navigation,
          onError: (error) => {
            throw error;
          },
        });
        return null;
      }
      flushSync(() =>
        root.render(
          <NavigationScope value={scope}>
            <Probe />
          </NavigationScope>,
        ),
      );
      check(current?.activeProjectId === expected, "Shared cache replaced the window selection");
      if (!cleared) {
        flushSync(() => current?.applySnapshot(snapshot));
        check(current?.bootstrapped && !current.loading, "Fresh snapshot did not finish startup");
      }
      pending.resolve(bootstrap);
      await until(
        () => !current?.loading && (cleared || selected.length === 1),
        "Restore window selection",
      );
      check(current?.activeProjectId === expected, "Bootstrap replaced the window selection");
      check(
        JSON.stringify(selected) === JSON.stringify(cleared ? [] : [project.id]),
        "Wrong project reopened",
      );
    });
  }

  await run(
    "failed initial discovery is retryable without inventing installation guidance",
    async (root) => {
      let fail = true;
      let current: ReturnType<typeof useWorkspaceState> | undefined;
      const api = {
        ...nativeAPI,
        bootstrap: async (): Promise<Bootstrap> => ({
          projects: [],
          activeProject: null,
          harnesses: [],
        }),
        checkHarnesses: async (): Promise<Bootstrap["harnesses"]> => {
          if (fail) throw new Error("Synthetic discovery failure");
          return [{ id: "codex", name: "Codex", status: "ready" }];
        },
        onEvent: () => () => {},
      };
      function Probe({ connection }: { connection: string }) {
        const navigation = useRef(0);
        current = useWorkspaceState({ api, navigation, connection, onError: () => {} });
        return null;
      }
      flushSync(() => root.render(<Probe connection="initial" />));
      check(current?.harnessDiscoveryFailed === false, "Pending discovery was reported as failed");
      await until(
        () => current?.harnessDiscoveryFailed === true,
        "Discovery failure exposed for retry",
      );
      check(current?.harnesses.length === 0, "Failure invented an installed agent status");
      fail = false;
      flushSync(() => root.render(<Probe connection="reconnected" />));
      await until(() => current?.harnesses[0]?.status === "ready", "Discovery recovery");
      check(
        current?.harnessDiscoveryFailed === false,
        "Successful discovery retained the retry error",
      );
    },
  );

  await run("expired purpose toggles never renew the other purpose", async (root) => {
    const expired: AnalyticsState = {
      notice: ANALYTICS_NOTICE,
      available: true,
      usage: true,
      diagnostics: true,
      expiresAt: new Date(0).toISOString(),
      linked: true,
      pendingDeletion: false,
      reference: null,
    };
    const submitted: { usage: boolean; diagnostics: boolean }[] = [];
    const read = deferred<AnalyticsState>();
    let reads = 0;
    const api: AnalyticsAPI = {
      ...required(nativeAPI.analytics, "Analytics preload API"),
      state: () => (++reads === 1 ? Promise.resolve(expired) : read.promise),
      subscribe: () => () => {},
      choose: async (choice) => {
        submitted.push(choice);
        return {
          ...expired,
          ...choice,
          linked: false,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        };
      },
    };
    await readAnalyticsState(api);
    flushSync(() => root.render(<PrivacySettings api={api} active />));
    check(host.textContent?.includes("Both off"), "Expired choices were displayed as enabled");
    flushSync(() =>
      required(
        host.querySelector<HTMLButtonElement>(".settings-privacy-disclosure"),
        "Purpose disclosure",
      ).click(),
    );
    const switches = [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')];
    check(
      switches.every((button) => button.getAttribute("aria-checked") === "false"),
      "Expired purpose switches were enabled",
    );
    required(switches[0], "Usage switch").click();
    await until(() => submitted.length === 1, "Submit explicit usage choice");
    check(
      submitted[0].usage && !submitted[0].diagnostics,
      "Usage toggle silently renewed expired diagnostics",
    );
    read.resolve({ ...expired, usage: false, diagnostics: false, linked: false, expiresAt: null });
    await settle();
    check(
      switches[0].getAttribute("aria-checked") === "true",
      "Late expiration read undid the explicit choice",
    );
  });

  await run(
    "privacy refresh recovery clears read errors and expires displayed choices",
    async (root) => {
      let fail = true;
      const api: AnalyticsAPI = {
        ...required(nativeAPI.analytics, "Analytics preload API"),
        state: async () => {
          if (fail) throw new Error("Synthetic offline read");
          return {
            notice: ANALYTICS_NOTICE,
            available: true,
            usage: true,
            diagnostics: true,
            expiresAt: new Date(Date.now() + 150).toISOString(),
            linked: false,
            pendingDeletion: false,
            reference: null,
          };
        },
        subscribe: () => () => {},
      };
      const render = (active: boolean) =>
        flushSync(() => root.render(<PrivacySettings api={api} active={active} />));
      render(true);
      await until(() => Boolean(host.querySelector('[role="alert"]')), "Read error displayed");
      render(false);
      fail = false;
      render(true);
      await until(
        () => Boolean(host.textContent?.includes("Both enabled")),
        "Activation read recovered",
      );
      check(!host.querySelector('[role="alert"]'), "Successful read retained the old read error");
      await until(
        () => Boolean(host.textContent?.includes("Both off")),
        "Visible consent expires without focus or navigation",
      );
    },
  );

  await run(
    "reopening privacy refreshes retained consent and allows expired choices to renew",
    async (root) => {
      const expired: AnalyticsState = {
        notice: ANALYTICS_NOTICE,
        available: true,
        usage: true,
        diagnostics: true,
        expiresAt: new Date(0).toISOString(),
        linked: false,
        pendingDeletion: false,
        reference: null,
      };
      const off = { ...expired, usage: false, diagnostics: false, expiresAt: null };
      let reads = 0;
      let choices = 0;
      let pending = deferred<AnalyticsState>();
      const api: AnalyticsAPI = {
        ...required(nativeAPI.analytics, "Analytics preload API"),
        state: () => (++reads === 1 ? Promise.resolve(expired) : pending.promise),
        subscribe: () => () => {},
        choose: async (choice) => {
          choices++;
          return {
            ...expired,
            ...choice,
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
          };
        },
      };
      await readAnalyticsState(api);
      const render = (active: boolean) =>
        flushSync(() => root.render(<PrivacySettings api={api} active={active} />));
      render(false);
      check(reads === 1, "Hidden privacy settings refetched consent");
      const panel = required(host.querySelector(".settings-privacy"), "Privacy panel");
      render(true);
      await until(() => reads === 2, "Activation refresh without window focus");
      check(
        host.querySelector(".settings-privacy") === panel,
        "Refreshing replaced the cached controls",
      );
      check(!panel.textContent?.includes("Loading your choices"), "Refreshing hid cached choices");
      required(
        [...host.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Accept",
        ),
        "Accept choice",
      ).click();
      await until(() => choices === 1, "Expired same choice can renew before refresh finishes");
      await settle();
      pending.resolve(off);
      await settle();
      check(
        panel.textContent?.includes("Both enabled"),
        "Late refresh undid a newer consent choice",
      );
      render(false);
      pending = deferred<AnalyticsState>();
      render(true);
      await until(() => reads === 3, "Next activation refresh");
      pending.resolve(off);
      await until(
        () => Boolean(panel.textContent?.includes("Both off")),
        "Native expiration updates retained controls",
      );
    },
  );

  await run(
    "settings retain loaded panels without occupying hidden layout or stealing focus",
    async (root) => {
      const cloud = {
        state: undefined,
        account: undefined,
        busy: false,
        error: "",
        signIn: async () => {},
        signOut: async () => {},
        retry() {},
      };
      const render = (active: boolean) =>
        flushSync(() => root.render(<Settings cloud={cloud} active={active} onBack={() => {}} />));
      render(false);
      const navigation = required(
        host.querySelector<HTMLElement>("#desktop-settings-navigation"),
        "Settings navigation",
      );
      const panel = required(
        host.querySelector<HTMLElement>(".settings-workspace"),
        "Settings panel",
      );
      check(
        navigation.getClientRects().length === 0 && panel.getClientRects().length === 0,
        "Hidden settings occupied workspace layout",
      );
      render(true);
      check(
        document.activeElement === host.querySelector(".settings-back"),
        "Opening settings did not focus its back button",
      );
      const appearance = required(
        host.querySelector(".settings-appearance-row"),
        "Appearance controls",
      );
      render(false);
      check(
        navigation.getClientRects().length === 0 && panel.getClientRects().length === 0,
        "Closing settings left visible panels",
      );
      render(true);
      check(
        host.querySelector(".settings-appearance-row") === appearance,
        "Reopening settings remounted its controls",
      );
      await settle();
    },
  );

  await run(
    "retained remote settings refresh on changes and discard hidden authentication inputs",
    async (root) => {
      const remote = required(window.tidyRemote, "Remote preload API");
      let reads = 0;
      let changed = () => {};
      const machines: MachineBridge = {
        list: async () => {
          reads++;
          return [
            {
              id: projectId,
              label: "Fixture machine",
              status: {
                kind: "authentication",
                target: "fixture",
                promptId: projectId,
                question: "Password",
                secret: true,
              },
            },
          ];
        },
        onChanged: (listener) => {
          changed = listener;
          return () => {
            changed = () => {};
          };
        },
        workspace: () => ({ api: nativeAPI, remote }),
      };
      const render = (active: boolean) =>
        flushSync(() =>
          root.render(<RemoteMachines machines={machines} remote={remote} active={active} />),
        );
      render(true);
      await until(
        () => Boolean(host.querySelector('input[type="password"]')),
        "Remote machine metadata",
      );
      required(
        host.querySelector<HTMLInputElement>('input[type="password"]'),
        "Authentication input",
      ).value = "synthetic-secret";
      render(false);
      check(
        !host.querySelector('input[type="password"]'),
        "Hidden settings retained an authentication answer",
      );
      render(true);
      check(reads === 1, "Reopening settings refetched available machines");
      check(
        required(
          host.querySelector<HTMLInputElement>('input[type="password"]'),
          "New authentication input",
        ).value === "",
        "Reopening restored a secret",
      );
      changed();
      await until(() => reads === 2, "Machine change refresh");
    },
  );

  await run(
    "read markers follow transcript activity even with the sidebar hidden",
    async (root) => {
      const thread = { ...summarizeThread(makeThread()), status: "completed" as const };
      const key = `tidy:thread-seen:${thread.projectId}:${thread.id}`;
      const focus = Object.getOwnPropertyDescriptor(document, "hasFocus");
      const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
      Object.defineProperty(document, "hasFocus", { configurable: true, value: () => true });
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      const render = (active: boolean) =>
        flushSync(() =>
          root.render(
            <ThreadReadingContext value={active}>
              <div style={{ display: "none" }}>
                <ThreadCard
                  thread={thread}
                  selected
                  loaded
                  now={Date.now()}
                  pending={false}
                  onSelect={() => {}}
                  onDone={() => {}}
                />
              </div>
            </ThreadReadingContext>,
          ),
        );
      try {
        localStorage.removeItem(key);
        render(false);
        await settle();
        window.dispatchEvent(new Event("focus"));
        check(
          localStorage.getItem(key) === null,
          "A response hidden behind settings was marked read",
        );
        render(true);
        await until(
          () => localStorage.getItem(key) !== null,
          "Active transcript marked read despite hidden sidebar",
        );
      } finally {
        if (focus) Object.defineProperty(document, "hasFocus", focus);
        else Reflect.deleteProperty(document, "hasFocus");
        if (visibility) Object.defineProperty(document, "visibilityState", visibility);
        else Reflect.deleteProperty(document, "visibilityState");
        localStorage.removeItem(key);
      }
    },
  );

  await run(
    "offline transitions retain loaded projects and refresh once on reconnect",
    async (root) => {
      const f = await workspaceFixture(root);
      const snapshot = f.state().snapshots[projectId];
      const harnesses = f.state().harnesses;
      check(f.bootstraps === 1, "Initial bootstrap did not run once");
      f.connection(false);
      await settle();
      check(f.bootstraps === 1, "Offline transition called bootstrap");
      check(f.state().activeProjectId === projectId, "Offline transition cleared the project");
      check(
        f.state().snapshots[projectId] === snapshot,
        "Offline transition replaced loaded content",
      );
      check(f.state().harnesses === harnesses, "Offline transition replaced harnesses");
      check(f.listeners.size === 1, "Offline transition dropped event subscription");
      check(f.errors.length === 0, "Offline transition showed a bootstrap error");
      f.connection(true);
      await settle();
      check(Number(f.bootstraps) === 2, "Reconnect did not refresh exactly once");
      check(f.state().activeProjectId === projectId, "Reconnect lost project selection");
    },
  );

  await run(
    "an in-flight import survives reconnect without starting another copy",
    async (root) => {
      const project = {
        id: crypto.randomUUID(),
        path: "/fixture/project",
        name: "Project",
        openedAt: timestamp,
      };
      const snapshot: ProjectSnapshot = { project, threads: [], designs: [], folders: [] };
      const attachment = {
        id: crypto.randomUUID(),
        name: "notes.txt",
        size: 5,
        mimeType: "text/plain",
      };
      const source = {
        project,
        contextProjectId: project.id,
        draft: {
          text: "Keep draft",
          harness: "codex" as const,
          designIds: [],
          attachments: [attachment],
        },
      };
      let complete: (
        value: Awaited<ReturnType<NonNullable<DesktopAPI["importDraft"]>>>,
      ) => void = () => {};
      const pending = new Promise<Awaited<ReturnType<NonNullable<DesktopAPI["importDraft"]>>>>(
        (resolve) => {
          complete = resolve;
        },
      );
      let imports = 0;
      let completed = 0;
      let closes = 0;
      const api: DesktopAPI = {
        ...nativeAPI,
        bootstrap: async () => ({ projects: [project], activeProject: snapshot, harnesses: [] }),
        projectCheckouts: async () => [
          {
            projectId: project.id,
            remotes: ["https://git.example/team/project.git"],
            repositoryPath: "",
          },
        ],
        selectProject: async () => snapshot,
        exportAttachment: async () => ({
          name: attachment.name,
          dataUrl: "data:text/plain;base64,aGVsbG8=",
        }),
        importDraft: async () => {
          imports++;
          return pending;
        },
      };
      const machineId = crypto.randomUUID();
      function render(connected: boolean) {
        flushSync(() =>
          root.render(
            <ProjectSetupDialog
              machine={{
                id: machineId,
                label: "Remote",
                status: connected
                  ? { kind: "connected", target: "remote" }
                  : { kind: "reconnecting", target: "remote", message: "Reconnecting", attempt: 1 },
              }}
              api={api}
              sourceAPI={api}
              source={source}
              onSetup={() => {}}
              onClose={() => {
                closes++;
              }}
              onReady={({ draft }) => {
                check(
                  draft?.attachments?.[0].id === attachment.id,
                  "Recovered import lost attachment",
                );
                completed++;
              }}
            />,
          ),
        );
      }
      render(true);
      await until(() => imports === 1, "Import started");
      const close = required(
        host.querySelector<HTMLButtonElement>("[aria-label='Close project setup']"),
        "Close button",
      );
      await until(() => close.disabled, "Import blocks dismissal before its result is known");
      host.querySelector("dialog")?.dispatchEvent(new Event("cancel", { cancelable: true }));
      check(closes === 0, "Escape dismissed the import");
      render(false);
      await settle();
      render(true);
      await settle();
      check(imports === 1, "Reconnect duplicated the import");
      complete({ attachments: [attachment], designIds: [], snapshot });
      await until(() => completed === 1, "Recovered import completes");
      check(imports === 1, "Recovered import was repeated");
    },
  );

  for (const failure of ["rejection", "result"] as const) {
    await run(`background clone ${failure} returns to an actionable form`, async (root) => {
      const project = {
        id: crypto.randomUUID(),
        path: "/fixture/project",
        name: "Project",
        openedAt: timestamp,
      };
      const snapshot: ProjectSnapshot = { project, threads: [], designs: [], folders: [] };
      const bootstrap: Bootstrap = { projects: [], harnesses: [], activeProject: null };
      let resolve: (value: ProjectSetupResult) => void = () => {};
      let reject: (error: Error) => void = () => {};
      const pending = new Promise<ProjectSetupResult>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let setups = 0;
      let completed = 0;
      const api: DesktopAPI = {
        ...nativeAPI,
        bootstrap: async () => bootstrap,
        projectCheckouts: async () => [],
        projectDirectories: async () => ({
          path: "/fixture",
          parent: "/",
          directories: [],
          initialProject: "/fixture",
        }),
        selectProject: async () => snapshot,
        setupProject: async () => {
          setups++;
          return { kind: "ready", snapshot };
        },
      };
      const sourceAPI: DesktopAPI = {
        ...api,
        projectCheckouts: async () => [
          {
            projectId: project.id,
            remotes: ["https://git.example/team/project.git"],
            repositoryPath: "",
          },
        ],
      };
      flushSync(() =>
        root.render(
          <ProjectSetupDialog
            machine={{ id: "local", label: "This machine", status: null }}
            api={api}
            sourceAPI={sourceAPI}
            source={{
              project,
              contextProjectId: project.id,
              draft: { text: "Keep this draft", harness: "codex", designIds: [] },
            }}
            pendingSetup={pending}
            onSetup={() => {}}
            onClose={() => {}}
            onReady={() => {
              completed++;
            }}
          />,
        ),
      );
      await until(() => host.textContent?.includes("Cloning repository") ?? false, "Pending clone");
      if (failure === "rejection") reject(new Error("Connection interrupted"));
      else resolve({ kind: "failed", reason: "clone-failed" });
      await until(
        () => Boolean(host.querySelector("input[aria-label='Parent folder']")),
        "Actionable retry form",
      );
      check(Boolean(host.querySelector("[role='alert']")), "Clone failure message is missing");
      const submit = required(
        host.querySelector<HTMLButtonElement>("button[type='submit']"),
        "Clone button",
      );
      await until(() => !submit.disabled, "Clone retry enabled");
      submit.click();
      await until(() => completed === 1, "Fresh clone completes");
      check(setups === 1, "Retry reused the settled promise or started duplicate clones");
    });
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
    await until(
      () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 41,
      "Initial view follows the latest message",
    );
    const original = required(viewport.querySelector("article"), "Original message");
    viewport.scrollTop = Math.floor((viewport.scrollHeight - viewport.clientHeight) / 2);
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
    const top = viewport.scrollTop;
    check(top > 0, "Fixture needs scrollable history");
    const first = required(
      host.querySelector<HTMLButtonElement>(".conversation-tick"),
      "First marker",
    );
    first.focus();
    first.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    await settle();
    check(
      Boolean(host.querySelector(".conversation-turn-preview")),
      "Focused marker has no preview",
    );
    render({ selected: b.id });
    await settle();
    render({ selected: a.id });
    await settle();
    check(
      visibleTranscript().querySelector("article") === original,
      "Returning rebuilt the message DOM",
    );
    check(Math.abs(visibleTranscript().scrollTop - top) < 2, "Returning lost the scroll position");
    check(
      !host.querySelector(".conversation-turn-preview"),
      "Returning revived an abandoned preview",
    );
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

  await run(
    "turn navigation stays current through streamed replies and added turns",
    async (root) => {
      const { a, threads, render } = conversationFixture(root);
      render({ selected: a.id });
      await settle();
      const buttons = () => [...host.querySelectorAll<HTMLButtonElement>(".conversation-tick")];
      const first = required(buttons()[0], "First turn");
      first.focus();
      first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
      await settle();
      check(document.activeElement === buttons()[1], "ArrowDown did not focus the next turn");
      const last = required(a.messages.at(-1), "Last reply");
      threads[a.id] = {
        ...a,
        revision: 2,
        messages: [...a.messages.slice(0, -1), { ...last, text: "Latest streamed response" }],
      };
      render({ selected: a.id });
      const latest = required(buttons().at(-1), "Last turn");
      latest.focus();
      latest.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await until(
        () =>
          Boolean(
            host
              .querySelector(".conversation-turn-preview")
              ?.textContent?.includes("Latest streamed response"),
          ),
        "Current response preview",
      );
      const viewport = visibleTranscript();
      first.click();
      const userId = crypto.randomUUID();
      threads[a.id] = {
        ...threads[a.id],
        revision: 3,
        messages: [
          ...threads[a.id].messages,
          { id: userId, role: "user", text: "A newly added turn", turn: { startedAt: timestamp } },
          { id: crypto.randomUUID(), role: "assistant", text: "The newest answer" },
        ],
      };
      render({ selected: a.id });
      for (let index = 0; index < 10; index++) {
        await frame();
        check(
          viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 40,
          "An old pending jump interrupted following the new turn",
        );
      }
      const added = required(buttons().at(-1), "Added turn");
      check(buttons().length === 5, "Added turn did not get a navigation target");
      check(
        added.getAttribute("aria-label")?.includes("A newly added turn"),
        "Added turn label is stale",
      );
      check(added.offsetTop > latest.offsetTop, "Added turn did not update navigation positions");
      added.focus();
      added.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
      await settle();
      check(document.activeElement === buttons()[3], "ArrowUp used a stale turn index");
      added.focus();
      added.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await settle();
      check(
        host
          .querySelector(".conversation-turn-preview")
          ?.textContent?.includes("The newest answer"),
        "Added turn preview is stale",
      );
      added.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      await settle();
      check(
        !host.querySelector(".conversation-turn-preview"),
        "Escape did not dismiss the preview",
      );
      first.click();
      await until(() => viewport.scrollTop < 2, "First turn scroll settles");
      const previousTop = viewport.scrollTop;
      const target = required(
        viewport.querySelectorAll<HTMLElement>(".conversation-entry")[8],
        "Added prompt",
      );
      const expectedTop = () =>
        Math.min(
          viewport.scrollHeight - viewport.clientHeight,
          viewport.scrollTop +
            target.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top -
            Math.min(24, Number.parseFloat(getComputedStyle(viewport).paddingTop)),
        );
      added.click();
      await settle();
      check(Math.abs(viewport.scrollTop - previousTop) > 2, "Added turn did not scroll");
      await until(
        () => Math.abs(viewport.scrollTop - expectedTop()) < 2,
        "Added turn reaches its current layout position",
      );
    },
  );

  await run(
    "turn markers select short latest turns at the bottom and after resizing",
    async (root) => {
      const { a, threads, render } = conversationFixture(root);
      threads[a.id] = {
        ...a,
        status: "completed",
        messages: [
          a.messages[0],
          { ...a.messages[1], text: "Earlier response paragraph.\n\n".repeat(50) },
          { id: crypto.randomUUID(), role: "user", text: "Short final prompt" },
          { id: crypto.randomUUID(), role: "assistant", text: "Short final reply" },
        ],
      };
      render({ selected: a.id });
      await until(() => Boolean(host.querySelector(".transcript")), "Conversation loads");
      await settle();
      const viewport = visibleTranscript();
      const buttons = () => [...host.querySelectorAll<HTMLButtonElement>(".conversation-tick")];
      const current = () => buttons().findIndex((button) => button.hasAttribute("aria-current"));
      await until(() => current() === 1, "Bottom of a short final turn selects the latest turn");
      required(buttons()[0], "First turn").click();
      await settle();
      required(buttons()[1], "Last turn").click();
      await settle();
      await until(() => current() === 1, "Clamped final turn jump selects the latest turn");
      threads[a.id] = {
        ...threads[a.id],
        messages: threads[a.id].messages.map((message) => ({ ...message, text: "Short" })),
      };
      render({ selected: a.id });
      await settle();
      check(viewport.scrollHeight <= viewport.clientHeight, "Short fixture unexpectedly scrolls");
      check(current() === 0, "First visible prompt was not the current navigation turn");
      check(
        buttons().every((button) => button.dataset.inView === "true"),
        "Visible prompts were not all highlighted",
      );
      viewport.parentElement!.style.height = "180px";
      viewport.parentElement!.style.flex = "none";
      await settle();
      required(buttons()[1], "Latest turn after resize").click();
      await settle();
      await until(() => current() === 1, "Resizing preserves the latest turn selection");
    },
  );

  await run(
    "turn markers follow visible prompts and fall back to the turn being read",
    async (root) => {
      const { a, threads, render } = conversationFixture(root);
      threads[a.id] = {
        ...a,
        status: "completed",
        messages: [
          { id: crypto.randomUUID(), role: "user", text: "First" },
          { id: crypto.randomUUID(), role: "user", text: "Second" },
          a.messages[2],
          { ...a.messages[3], text: "Long response paragraph.\n\n".repeat(50) },
          ...a.messages.slice(4),
        ],
      };
      render({ selected: a.id });
      await settle();
      const viewport = visibleTranscript();
      const buttons = [...host.querySelectorAll<HTMLButtonElement>(".conversation-tick")];
      required(buttons[1], "Second turn").click();
      await settle();
      await until(
        () => buttons[1].hasAttribute("aria-current") && buttons[1].dataset.inView === "true",
        "Jump selects and highlights its visible prompt",
      );
      const finalReply = required(
        viewport.querySelectorAll<HTMLElement>(".conversation-entry")[3],
        "Reply",
      );
      viewport.scrollTop +=
        finalReply.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
      viewport.dispatchEvent(new Event("scroll"));
      await settle();
      await until(
        () => buttons[2].hasAttribute("aria-current"),
        "Reading a response selects its preceding turn",
      );
    },
  );

  await run("turn markers keep a compact overview and precise pointer targets", async (root) => {
    const { a, threads, render } = conversationFixture(root);
    threads[a.id] = { ...makeThread({ count: 160 }), id: a.id, status: "completed" };
    render({ selected: a.id });
    await settle();
    const viewport = visibleTranscript();
    viewport.parentElement!.style.height = "180px";
    viewport.parentElement!.style.flex = "none";
    await settle();
    const buttons = [...host.querySelectorAll<HTMLButtonElement>(".conversation-tick")];
    const list = required(host.querySelector<HTMLElement>(".conversation-ticks"), "Turn list");
    for (const index of [0, 39, 79]) {
      buttons[index].focus();
      buttons[index].dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
      await frame();
      const popup = required(
        host.querySelector<HTMLElement>(".conversation-turn-preview"),
        "Focused turn preview",
      );
      const popupBounds = popup.getBoundingClientRect();
      const conversationBounds = viewport.getBoundingClientRect();
      check(
        popupBounds.top >= conversationBounds.top &&
          popupBounds.bottom <= conversationBounds.bottom,
        "Turn preview extends outside the conversation",
      );
    }
    const bounds = list.getBoundingClientRect();
    for (const index of [0, 1, 39, 78, 79]) {
      const y = bounds.top + (bounds.height * index) / (buttons.length - 1);
      list.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientY: y }));
      await frame();
      check(
        buttons[index].classList.contains("previewing"),
        "Pointer mapping chose the wrong turn",
      );
      list.dispatchEvent(new MouseEvent("click", { bubbles: true, clientY: y, detail: 1 }));
      await settle();
      await until(
        () => buttons[index].dataset.inView === "true",
        "Pointer jump reveals the targeted prompt",
      );
    }
    const before = viewport.scrollTop;
    const wheel = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaY: -2,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
    });
    list.dispatchEvent(wheel);
    await settle();
    check(
      wheel.defaultPrevented && Math.abs(viewport.scrollTop - (before - 32)) < 2,
      "Wheel over the rail did not scroll the conversation in line units",
    );
    required(buttons[39], "Middle marker").click();
    required(buttons[0], "First marker").click();
    await settle();
    check(viewport.scrollTop < 2, "An earlier jump overrode the next navigation action");
    required(buttons[39], "Middle marker").click();
    viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -50 }));
    viewport.scrollTop = 0;
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
    check(viewport.scrollTop < 2, "Jump settling overrode manual scrolling");
    const zoom = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -2,
    });
    list.dispatchEvent(zoom);
    check(!zoom.defaultPrevented, "Rail intercepted browser zoom");
    const end = required(buttons.at(-1), "Last marker");
    end.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
    );
    await settle();
    check(document.activeElement === buttons[0], "Home did not focus the first marker");
    required(buttons[0], "First marker").dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    );
    await settle();
    check(document.activeElement === end, "End did not focus the last marker");
  });

  for (const input of ["wheel", "keyboard", "touch"] as const) {
    await run(`${input} scrolling survives updates before the scroll event`, async (root) => {
      const { a, threads, render } = conversationFixture(root);
      render({ selected: a.id });
      await settle();
      const viewport = visibleTranscript();
      viewport.dispatchEvent(
        input === "wheel"
          ? new WheelEvent("wheel", { bubbles: true, deltaY: -100 })
          : input === "keyboard"
            ? new KeyboardEvent("keydown", { bubbles: true, key: "PageUp" })
            : new Event("touchmove", { bubbles: true }),
      );
      // Scrolling changes the offset before the browser delivers its scroll event.
      viewport.scrollTop -= 100;
      const top = viewport.scrollTop;
      threads[a.id] = { ...a, revision: 2, toolActivities: [] };
      render({ selected: a.id });
      check(Math.abs(viewport.scrollTop - top) < 2, "An update restored a stale offset");
      await settle();
      check(Math.abs(viewport.scrollTop - top) < 2, "A pending measurement undid scrolling");
    });
  }

  await run("small upward scrolls pause following through updates and resizing", async (root) => {
    const { a, threads, render } = conversationFixture(root);
    render({ selected: a.id });
    await settle();
    const viewport = visibleTranscript();
    viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -10 }));
    viewport.scrollTop -= 10;
    viewport.dispatchEvent(new Event("scroll"));
    const top = viewport.scrollTop;
    threads[a.id] = { ...a, revision: 2, messages: [...a.messages] };
    render({ selected: a.id });
    const content = required(viewport.querySelector(".conversation-content"), "Content");
    const delayed = document.createElement("div");
    delayed.style.height = "200px";
    content.append(delayed);
    await settle();
    check(Math.abs(viewport.scrollTop - top) < 2, "Following resumed during an upward scroll");

    viewport.scrollTop = viewport.scrollHeight;
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
    delayed.style.height = "400px";
    await until(
      () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2,
      "Scrolling back down resumes following",
    );
    viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -10 }));
    viewport.scrollTop -= 10;
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
    // A larger scroll exposes the Latest action after a small scroll pauses following.
    viewport.scrollTop -= 50;
    viewport.dispatchEvent(new Event("scroll"));
    await until(() => Boolean(host.querySelector(".latest-message")), "Latest action appears");
    required(host.querySelector<HTMLButtonElement>(".latest-message"), "Latest action").click();
    delayed.style.height = "600px";
    await until(
      () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2,
      "Latest action resumes following",
    );
    delayed.style.height = "200px";
    let shrinkRendered = false;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        shrinkRendered = true;
      }),
    );
    await until(() => shrinkRendered, "Shrunken content renders before growing again");
    delayed.style.height = "400px";
    await until(
      () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2,
      "Following survives content shrinking and growing again",
    );
  });

  await run("downward scrolling resumes following across a pending thread update", async (root) => {
    const { a, threads, render } = conversationFixture(root);
    render({ selected: a.id });
    await until(
      () => Boolean(host.querySelector<HTMLDivElement>(".transcript")?.clientHeight),
      "Scrollable transcript",
    );
    await settle();
    const viewport = visibleTranscript();
    viewport.dispatchEvent(new WheelEvent("wheel", { bubbles: true, deltaY: -100 }));
    viewport.scrollTop -= 100;
    viewport.dispatchEvent(new Event("scroll"));
    await until(
      () => Boolean(host.querySelector(".latest-message")),
      "Upward scrolling pauses following",
    );

    viewport.scrollTop = viewport.scrollHeight;
    // An update measures the new offset before the browser handles the downward scroll.
    threads[a.id] = { ...a, revision: 2, messages: [...a.messages] };
    render({ selected: a.id });
    viewport.dispatchEvent(new Event("scroll"));
    await settle();
    const content = required(viewport.querySelector(".conversation-content"), "Content");
    const delayed = document.createElement("div");
    delayed.style.height = "200px";
    content.append(delayed);
    await until(
      () => viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 2,
      "Following resumes after a thread update precedes the downward scroll event",
    );
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

  await run("view retention evicts old DOM and isolates drafts and access scopes", async (root) => {
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
      visibleTranscript().querySelectorAll("article").length === 2,
      "Project navigation displayed another project's messages",
    );
    render({ selected: other.id, project: other.projectId, scope: "new-account" });
    await settle();
    check(
      host.querySelectorAll(".conversation").length === 1,
      "Access changes retained the previous scope's views",
    );
  });

  await run(
    "project navigation retains bounded transcripts and their scroll position",
    async (root) => {
      const { a, b, threads, render } = conversationFixture(root);
      a.messages = makeThread({ count: 40 }).messages;
      b.projectId = crypto.randomUUID();
      render({ selected: a.id });
      await settle();
      const viewport = visibleTranscript();
      const message = required(viewport.querySelector("article"), "Retained message");
      viewport.scrollTop = 180;
      viewport.dispatchEvent(new Event("scroll"));
      render({ selected: b.id, project: b.projectId });
      await settle();
      check(visibleTranscript() !== viewport, "Other project displayed the previous transcript");
      threads[a.id] = { ...a, revision: 2 };
      render({ selected: a.id });
      check(visibleTranscript() === viewport, "Returning to a project remounted its transcript");
      check(viewport.querySelector("article") === message, "Returning reparsed existing messages");
      await settle();
      check(Math.abs(viewport.scrollTop - 180) < 2, "Returning lost the reader's position");
    },
  );

  await run("collapsed tool logs defer rows and retain expanded output on reopen", async (root) => {
    const output = "one\ntwo\nthree\nfour\nFinal output";
    const activities: ToolActivity[] = Array.from({ length: 10 }, (_, index) => ({
      id: crypto.randomUUID(),
      afterMessageId: crypto.randomUUID(),
      kind: "command",
      title: "Inspect",
      toolName: "Shell",
      status: index === 0 ? "failed" : "completed",
      exitCode: index === 0 ? 1 : 0,
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
    const summary = required(group.querySelector("summary"), "Group summary");
    check(summary.textContent?.includes("10 steps"), "Summary lost the step count");
    check(!/failed/i.test(summary.textContent ?? ""), "Summary promoted an individual failure");
    check(!/failed/i.test(summary.getAttribute("aria-label") ?? ""), "Summary announced failures");
    summary.click();
    await until(
      () => host.querySelectorAll(".tool-call").length === activities.length,
      "Expand tool rows",
    );
    const row = required(group.querySelector<HTMLDetailsElement>(".tool-call"), "Tool row");
    const detail = required(row.querySelector("summary"), "Tool summary");
    check(detail.textContent?.includes("Ran"), "Command did not show that it ran");
    check(detail.textContent?.includes("Failed · exit 1"), "Command lost its outcome");
    check(detail.textContent?.match(/Failed/g)?.length === 1, "Command repeated its failure");
    detail.click();
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
    "workspace renders before agent discovery and keeps the freshest discovery result",
    async (root) => {
      const bootstrap = deferred<Bootstrap>();
      const discovery = deferred<Bootstrap["harnesses"]>();
      const ready: Bootstrap["harnesses"] = [{ id: "codex", name: "Codex", status: "ready" }];
      let current: ReturnType<typeof useWorkspaceState> | undefined;
      const api = {
        ...nativeAPI,
        bootstrap: () => bootstrap.promise,
        checkHarnesses: () => discovery.promise,
        onEvent: () => () => {},
      };
      function Probe() {
        const navigation = useRef(0);
        current = useWorkspaceState({ api, navigation, onError: () => {} });
        return null;
      }
      flushSync(() => root.render(<Probe />));
      bootstrap.resolve({ projects: [], activeProject: null, harnesses: [] });
      await until(() => current?.loading === false, "Workspace before slow discovery");
      check(current?.harnesses.length === 0, "Invented a harness status before discovery");
      discovery.resolve(ready);
      await until(() => current?.harnesses === ready, "Background discovery");

      // Discovery may also beat a slow project snapshot on the next mount.
      const slowBootstrap = deferred<Bootstrap>();
      api.bootstrap = () => slowBootstrap.promise;
      flushSync(() => root.render(<Probe key="fresh" />));
      await until(() => current?.harnesses === ready, "Discovery before slow workspace");
      slowBootstrap.resolve({ projects: [], activeProject: null, harnesses: [] });
      await until(() => current?.loading === false, "Slow workspace");
      check(current?.harnesses === ready, "Older bootstrap erased completed discovery");
    },
  );

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

  await run("cached project refreshes cannot erase newer design events", async (root) => {
    const { initial, state, emit } = await workspaceFixture(root);
    const before = required(state().snapshots[projectId], "Initial project snapshot");
    const design = {
      id: crypto.randomUUID(),
      name: "New design",
      path: "/fixture/design",
      updatedAt: timestamp,
    };
    emit({ type: "designs", projectId, designs: [design], folders: [] });
    const refreshed = { ...before, threads: [summarizeThread({ ...initial, revision: 2 })] };
    flushSync(() => state().applySnapshot(refreshed, true, before));
    check(state().snapshots[projectId].designs[0] === design, "Late refresh erased the newer file");
    check(
      state().snapshots[projectId].threads[0]?.revision === 2,
      "Design event discarded refreshed threads",
    );
    const current = state().snapshots[projectId];
    flushSync(() => state().applySnapshot({ ...current, designs: [] }, true, current));
    check(
      state().snapshots[projectId].designs.length === 0,
      "Unchanged cached snapshot did not refresh",
    );
  });

  await run(
    "thread events preserve concurrent edits while other snapshot fields refresh",
    async (root) => {
      const { initial, state, emit } = await workspaceFixture(root);
      const before = required(state().snapshots[projectId], "Initial project snapshot");
      const live = { ...initial, title: "Live title", revision: 3 };
      emit({ type: "thread", thread: live });
      const design = {
        id: crypto.randomUUID(),
        name: "Refreshed design",
        path: "/fixture/design",
        updatedAt: timestamp,
      };
      flushSync(() =>
        state().applySnapshot(
          { ...before, designs: [design], threads: [summarizeThread({ ...initial, revision: 3 })] },
          false,
          before,
        ),
      );
      check(
        state().snapshots[projectId].designs[0] === design,
        "Thread event discarded refreshed designs",
      );
      check(
        state().snapshots[projectId].threads[0]?.title === live.title,
        "Equal-revision refresh erased an intervening edit",
      );
      flushSync(() =>
        state().applySnapshot(
          { ...before, designs: [design], threads: [summarizeThread({ ...initial, revision: 4 })] },
          false,
          before,
        ),
      );
      check(
        state().snapshots[projectId].threads[0]?.revision === 4,
        "Newer refresh revision was discarded",
      );
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
    "dragging clipped threads preserves order until they move within the list",
    async (root) => {
      const summaries = Array.from({ length: 8 }, () => summarizeThread(makeThread({ count: 1 })));
      flushSync(() =>
        root.render(
          <div style={{ display: "flex", height: 240 }}>
            <ThreadSidebar
              projectId={projectId}
              threads={summaries}
              search=""
              renderThread={(thread, controls) => (
                <button
                  className="thread-select"
                  style={{ display: "block", height: 64, width: 200 }}
                  onPointerDown={controls?.onPointerDown}
                >
                  {thread.title}
                </button>
              )}
            />
          </div>,
        ),
      );
      const list = required(host.querySelector<HTMLElement>(".sidebar-list"), "Thread list");
      const scroll = required(list.parentElement, "Thread viewport");
      list.setPointerCapture = () => {};
      const rows = () => [...list.querySelectorAll<HTMLElement>("[data-thread-id]")];
      const order = () =>
        rows()
          .map((row) => row.dataset.threadId)
          .join();
      const initial = order();
      function moveAndRelease(row: HTMLElement, startY: number, delta: number) {
        const button = required(row.querySelector("button"), "Thread button");
        const pointer = { bubbles: true, pointerId: 1, isPrimary: true, button: 0 };
        flushSync(() => {
          button.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientY: startY }));
          window.dispatchEvent(
            new PointerEvent("pointermove", { ...pointer, clientY: startY + delta }),
          );
          window.dispatchEvent(new PointerEvent("pointerup", pointer));
        });
      }
      scroll.scrollTop = 32;
      const top = scroll.getBoundingClientRect().top;
      check(rows()[0].getBoundingClientRect().top < top, "First row must start clipped");
      moveAndRelease(rows()[0], top + 20, -6);
      check(order() === initial, "Picking up the clipped top row swapped it downward");
      scroll.scrollTop = 0;
      const bottom = scroll.getBoundingClientRect().bottom;
      check(rows()[3].getBoundingClientRect().bottom > bottom, "Fourth row must start clipped");
      moveAndRelease(rows()[3], bottom - 10, 6);
      check(order() === initial, "Picking up the clipped bottom row swapped it upward");
      check(
        localStorage.getItem(`tidy:thread-order:${projectId}`) ===
          JSON.stringify(summaries.map((thread) => thread.id)),
        "Releasing a clipped row persisted an unintended order",
      );
      moveAndRelease(rows()[0], rows()[0].getBoundingClientRect().top + 20, 64);
      check(
        rows()[1].dataset.threadId === summaries[0].id,
        "A single move must still reorder rows",
      );
    },
  );

  await run(
    "done section stays at the sidebar bottom with short and scrolling lists",
    async (root) => {
      const active = Array.from({ length: 50 }, () => summarizeThread(makeThread({ count: 0 })));
      const done = Array.from({ length: 20 }, () =>
        summarizeThread({ ...makeThread({ count: 0 }), doneAt: timestamp }),
      );
      for (const height of [700, 360]) {
        for (const count of [2, 50]) {
          flushSync(() =>
            root.render(
              <div style={{ display: "flex", flexDirection: "column", height, width: 244 }}>
                <header style={{ height: 100, flexShrink: 0 }}>Threads</header>
                <ThreadSidebar
                  projectId={projectId}
                  threads={[...active.slice(0, count), ...done]}
                  search=""
                  renderThread={(thread) => (
                    <button style={{ display: "block", height: 48 }}>{thread.title}</button>
                  )}
                />
                <footer data-sidebar-footer style={{ height: 40, flexShrink: 0 }}>
                  Settings
                </footer>
              </div>,
            ),
          );
          const disclosure = required(
            host.querySelector<HTMLDetailsElement>(".done-threads"),
            "Done section",
          );
          disclosure.open = false;
          await settle();
          const summary = required(disclosure.querySelector("summary"), "Done disclosure");
          const footer = required(host.querySelector("[data-sidebar-footer]"), "Sidebar footer");
          const scroll = required(host.querySelector(".sidebar-scroll"), "Active thread scroller");
          const footerTop = footer.getBoundingClientRect().top;
          const bottomGap = footerTop - summary.getBoundingClientRect().bottom;
          check(bottomGap >= 0 && bottomGap <= 12, "Done did not stay above the sidebar footer");
          if (count === 50) {
            check(scroll.scrollHeight > scroll.clientHeight, "Active threads did not scroll");
            const top = summary.getBoundingClientRect().top;
            scroll.scrollTop = scroll.scrollHeight;
            check(
              Math.abs(summary.getBoundingClientRect().top - top) < 1,
              "Scrolling active threads moved Done",
            );
          }
          disclosure.open = true;
          await settle();
          const list = required(host.querySelector(".done-thread-list"), "Done thread scroller");
          check(list.scrollHeight > list.clientHeight, "Expanded Done threads were not bounded");
          check(
            list.getBoundingClientRect().bottom <= footerTop + 1,
            "Expanded Done rows overlapped the footer",
          );
          check(
            disclosure.getBoundingClientRect().bottom <= footerTop + 1,
            "Expanded Done overlapped the footer",
          );
          check(scroll.clientHeight > 40, "Expanded Done displaced the active thread area");
        }
      }
    },
  );

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

  await run(
    "working clocks persist through tool activity and pause their loader for permission",
    async (root) => {
      const { a, threads, render } = conversationFixture(root);
      const startedAt = new Date(Date.now() - 5000).toISOString();
      a.messages = [{ ...a.messages[0], turn: { startedAt } }];
      a.activity = "Thinking";
      render({ selected: a.id });
      await until(() => Boolean(host.querySelector(".working-matrix")), "Working indicator mounts");
      const first = host.querySelector(".turn-status-time")?.textContent;
      await until(
        () => host.querySelector(".turn-status-time")?.textContent !== first,
        "Elapsed clock advances",
      );
      const thinkingRow = required(host.querySelector(".activity-row"), "Thinking row");
      const thinkingBox = thinkingRow.getBoundingClientRect();
      const tool: ToolActivity = {
        id: crypto.randomUUID(),
        kind: "read",
        title: "Reading styles",
        toolName: "Read",
        status: "running",
        startedAt,
        afterMessageId: a.messages[0].id,
      };
      threads[a.id] = { ...a, activity: tool.title, toolActivities: [tool] };
      render({ selected: a.id });
      check(
        Boolean(host.querySelector(".working-matrix")),
        "Tool activity removed the working clock",
      );
      const commandRow = required(
        host.querySelector(".tool-activity-group > summary"),
        "Activity summary",
      );
      check(
        Math.abs(commandRow.getBoundingClientRect().top - thinkingBox.top) < 1 &&
          Math.abs(commandRow.getBoundingClientRect().height - thinkingBox.height) < 1,
        "Switching from thinking to tool activity moved the activity row",
      );
      check(
        host.querySelectorAll(".activity-summary-text").length === 1,
        "Tool label was duplicated",
      );
      threads[a.id] = {
        ...threads[a.id],
        pendingApprovals: [
          {
            id: "permission",
            title: "Run command",
            choices: ["allow", "deny"],
          },
        ],
      };
      render({ selected: a.id });
      check(
        !host.querySelector(".turn-status[data-active]"),
        "Loader kept moving while waiting for permission",
      );
      check(
        host.textContent?.includes("Waiting for permission"),
        "Permission state was hidden by a running tool",
      );
      threads[a.id] = {
        ...a,
        status: "completed",
        activity: undefined,
        messages: [
          {
            ...a.messages[0],
            turn: { startedAt, endedAt: new Date(Date.parse(startedAt) + 8000).toISOString() },
          },
        ],
      };
      render({ selected: a.id });
      check(
        host.querySelector(".turn-status-time")?.textContent === "Worked for 8s",
        "Completed turn lost its duration",
      );
      check(!host.querySelector(".working-matrix"), "Completed turn kept its loader");
    },
  );

  await run("thread tables wrap, scroll at narrow widths and expand in place", async (root) => {
    const { a, threads, render } = conversationFixture(root);
    const text = [
      "| Harness | What its own interfaces show | What Tidy can access |",
      "| --- | --- | --- |",
      ...Array.from(
        { length: 16 },
        () =>
          "| **Claude Code** | Subscription usage bars, session tokens and estimated cost, activity breakdowns, and usage-credit spending where applicable. | Initialization includes subscription information. Streamed rate-limit events expose status and optional utilization/reset time. [Usage](https://example.com/usage) |",
      ),
      "\n| Other table | Value |\n| --- | --- |\n| Small | Separate |",
    ].join("\n");
    const reply = { id: crypto.randomUUID(), role: "assistant" as const, text };
    threads[a.id] = { ...a, status: "completed", messages: [a.messages[0], reply] };
    render({ selected: a.id });
    await settle();
    const message = required(host.querySelector<HTMLElement>(".message-markdown"), "Message");
    message.style.width = "360px";
    await settle();
    const scroller = required(
      message.querySelector<HTMLDivElement>(".markdown-table-scroll"),
      "Table scroller",
    );
    const table = required(scroller.querySelector("table"), "Table");
    const firstColumn = required(table.querySelector("th"), "First column");
    check(
      scroller.scrollWidth <= scroller.clientWidth + 1,
      "Table did not wrap within the available message width",
    );
    message.style.width = "240px";
    await settle();
    check(
      scroller.scrollWidth > scroller.clientWidth,
      "Narrow table did not overflow horizontally",
    );
    check(
      firstColumn.clientWidth >= parseFloat(getComputedStyle(firstColumn).minWidth) - 1,
      "Table squeezed its label column",
    );
    check(message.scrollWidth <= message.clientWidth + 1, "Table widened the message");
    scroller.scrollLeft = 120;
    const left = scroller.scrollLeft;
    check(left > 0, "Table could not scroll");
    check(!document.querySelector(".markdown-table-dialog"), "Collapsed table duplicated its DOM");
    const expand = required(
      message.querySelector<HTMLButtonElement>('[aria-label="Expand table"]'),
      "Expand table",
    );
    expand.focus();
    expand.click();
    await until(
      () => Boolean(document.querySelector(".markdown-table-dialog[open]")),
      "Expand table",
    );
    const dialog = required(
      document.querySelector<HTMLDialogElement>(".markdown-table-dialog"),
      "Expanded table",
    );
    check(dialog.parentElement === document.body, "Expanded table remained inside the transcript");
    check(dialog.clientWidth > message.clientWidth, "Expanded table did not use more space");
    check(dialog.querySelectorAll("tbody tr").length === 16, "Expanded the wrong table");
    check(
      dialog.querySelector("a")?.getAttribute("href") === "https://example.com/usage",
      "Table lost its link",
    );
    check(dialog.querySelector("strong")?.textContent === "Claude Code", "Table lost formatting");
    check(document.activeElement?.textContent === "Close", "Expanded table did not receive focus");
    const expandedScroll = required(
      dialog.querySelector<HTMLDivElement>(".markdown-table-scroll"),
      "Expanded scroller",
    );
    check(
      dialog.getBoundingClientRect().height <= innerHeight * 0.9 + 1,
      "Dialog exceeded the viewport",
    );
    check(
      expandedScroll.scrollHeight > expandedScroll.clientHeight,
      "Long table did not scroll vertically",
    );
    threads[a.id] = {
      ...threads[a.id],
      messages: [a.messages[0], { ...reply, text: text + "\n\nNext paragraph." }],
    };
    render({ selected: a.id });
    check(
      document.querySelector(".markdown-table-dialog") === dialog && dialog.open,
      "Message update reset expansion",
    );
    required(dialog.querySelector<HTMLButtonElement>("button"), "Close table").click();
    await until(() => !document.querySelector(".markdown-table-dialog"), "Close table");
    check(document.activeElement === expand, "Closing did not restore focus");
    check(
      scroller.scrollLeft === left && scroller.querySelector("table") === table,
      "Expansion reset the inline table",
    );
    expand.click();
    await until(
      () => Boolean(document.querySelector(".markdown-table-dialog[open]")),
      "Reopen table",
    );
    const reopened = required(
      document.querySelector<HTMLDialogElement>(".markdown-table-dialog"),
      "Reopened table",
    );
    reopened.requestClose();
    await until(() => !document.querySelector(".markdown-table-dialog"), "Dismiss table");
  });

  await run(
    "streaming reveals coherent sections, retains their DOM and flushes the final tail",
    async (root) => {
      const { a, threads, render } = conversationFixture(root);
      const replyId = crypto.randomUUID();
      a.messages = [a.messages[0], { id: replyId, role: "assistant", text: "" }];
      a.activity = "Replying";
      render({ selected: a.id });
      await settle();
      const update = (text: string) => {
        threads[a.id] = {
          ...threads[a.id],
          messages: [a.messages[0], { id: replyId, role: "assistant", text }],
        };
        render({ selected: a.id });
      };
      update("A **clear");
      await settle();
      check(!host.querySelector(".message-markdown")?.textContent, "A partial paragraph leaked");
      const paragraph = "A **clear** [response](https://example.com).\n\n";
      update(paragraph);
      await until(
        () => host.querySelector(".message-markdown strong")?.textContent === "clear",
        "Completed paragraph appears",
      );
      const first = required(host.querySelector(".message-markdown > p"), "First paragraph");
      const link = required(first.querySelector("a"), "Response link");
      link.focus();
      update(`${paragraph}### Details\n`);
      await settle();
      check(!host.querySelector(".message-markdown h3"), "A heading appeared without content");
      const list = `${paragraph}### Details\n\n- First item\n- Sec`;
      update(list);
      await until(
        () => host.querySelector(".message-markdown li")?.textContent === "First item",
        "Completed list item appears",
      );
      check(host.querySelectorAll(".message-markdown li").length === 1, "A partial item leaked");
      const listBlock = required(host.querySelector(".message-markdown > ul"), "List block");
      check(
        getComputedStyle(required(listBlock.querySelector("li"), "List item"))
          .transitionDuration === "0s",
        "A list item has its own fade",
      );
      check(host.querySelector(".message-markdown > p") === first, "An earlier block remounted");
      check(
        first.querySelector("a") === link && document.activeElement === link,
        "Streaming replaced or unfocused an earlier link",
      );
      const code = `${paragraph}### Details\n\n- First item\n- Second item\n\n\`\`\`css\n.item {`;
      update(code);
      await until(
        () => host.querySelectorAll(".message-markdown li").length === 2,
        "Second list item appears",
      );
      check(!host.querySelector(".message-markdown pre"), "An open code fence leaked");
      check(
        host.querySelector(".message-markdown > ul") === listBlock,
        "Appending an item remounted its list",
      );
      const closed = `${code}\n  color: red;\n}\n\`\`\``;
      update(closed);
      await until(
        () => Boolean(host.querySelector(".message-markdown pre")?.textContent?.includes("red")),
        "Closed code block appears",
      );
      const codeBlock = host.querySelector(".message-markdown pre");
      update(`${closed}\n\nFinal **finished** sentence.`);
      await settle();
      check(
        !host.querySelector(".message-markdown")?.textContent?.includes("Final"),
        "A final partial section leaked",
      );
      threads[a.id] = { ...threads[a.id], status: "completed", activity: undefined };
      render({ selected: a.id });
      check(
        host.querySelector(".message-markdown")?.textContent?.endsWith("Final finished sentence."),
        "Completion left the final section hidden",
      );
      check(host.querySelector(".message-markdown > p") === first, "Completion remounted text");
      check(host.querySelector(".message-markdown pre") === codeBlock, "Completion remounted code");
      check(
        !host.querySelector(".message-markdown[data-streaming]"),
        "Completed text kept its fade",
      );
      check(
        Boolean(host.querySelector(".message-markdown[data-revealing]")),
        "Completion removed the final section's reveal before it could finish",
      );
      await until(
        () => !host.querySelector(".message-markdown[data-revealing]"),
        "Final reveal settles",
      );
    },
  );
  await run("historical replies mount fully visible without replaying reveals", async (root) => {
    const { a, render } = conversationFixture(root);
    a.status = "completed";
    a.activity = undefined;
    render({ selected: a.id });
    await settle();
    check(Boolean(host.querySelector(".message-markdown p")), "History did not render");
    check(
      !host.querySelector(".message-markdown[data-revealing]"),
      "Opening history replayed a reveal",
    );
  });
  await run("activity transitions never hide text that is already visible", async (root) => {
    const { a, threads, render } = conversationFixture(root);
    const replyId = crypto.randomUUID();
    a.messages = [a.messages[0], { id: replyId, role: "assistant", text: "An existing fragment" }];
    a.activity = "Thinking";
    render({ selected: a.id });
    await settle();
    check(
      host.querySelector(".message-markdown")?.textContent === "An existing fragment",
      "Existing text was held back",
    );
    threads[a.id] = {
      ...a,
      activity: "Replying",
      messages: [
        a.messages[0],
        { id: replyId, role: "assistant", text: "An existing fragment grows" },
      ],
    };
    render({ selected: a.id });
    check(
      host.querySelector(".message-markdown")?.textContent?.startsWith("An existing fragment"),
      "Resuming streaming hid text",
    );
    await until(
      () => host.querySelector(".message-markdown")?.textContent === "An existing fragment grows",
      "An already visible section can continue growing",
    );
  });
  await run(
    "command groups stay anchored above replies and preserve the reader's place",
    async (root) => {
      const { a, threads, render } = conversationFixture(root);
      a.messages = [{ ...a.messages[0], turn: { startedAt: timestamp } }];
      const tool: ToolActivity = {
        id: crypto.randomUUID(),
        afterMessageId: a.messages[0].id,
        kind: "command",
        toolName: "Shell",
        title: "bun run typecheck",
        input: "bun run typecheck\nbun run lint",
        status: "completed",
        startedAt: timestamp,
        endedAt: timestamp,
        output: "All checks passed",
      };
      a.toolActivities = [tool];
      a.activity = "Thinking";
      render({ selected: a.id });
      await settle();
      const group = required(
        host.querySelector<HTMLDetailsElement>(".tool-activity-group"),
        "Activity group",
      );
      required(group.querySelector("summary"), "Activity summary").click();
      await until(() => Boolean(group.querySelector(".tool-call")), "Expand commands");
      const row = required(group.querySelector<HTMLDetailsElement>(".tool-call"), "Command");
      const summary = required(row.querySelector("summary"), "Command summary");
      const title = required(row.querySelector(".tool-call-title"), "Command title").textContent;
      const height = summary.getBoundingClientRect().height;
      summary.click();
      await until(() => Boolean(row.querySelector("pre")), "Expand command details");
      check(
        row.querySelector(".tool-call-title")?.textContent === title &&
          summary.getBoundingClientRect().height === height,
        "Opening details changed the command label or row height",
      );
      const reply = {
        id: crypto.randomUUID(),
        role: "assistant" as const,
        text: "The checks passed. I am checking the sidebar next.",
      };
      const next = {
        ...tool,
        id: crypto.randomUUID(),
        afterMessageId: reply.id,
        title: "bun test sidebar.test.ts",
        status: "running" as const,
        endedAt: undefined,
      };
      threads[a.id] = {
        ...a,
        messages: [...a.messages, reply],
        toolActivities: [tool, next],
        activity: "Replying",
      };
      render({ selected: a.id });
      check(
        host.querySelectorAll(".tool-activity-group").length === 1 &&
          host.querySelector(".tool-activity-group") === group,
        "New commands moved or recreated the turn's group",
      );
      const response = required(host.querySelector(".message-assistant"), "Reply");
      check(
        Boolean(group.compareDocumentPosition(response) & Node.DOCUMENT_POSITION_FOLLOWING),
        "Commands appeared below the reply",
      );
      const many = Array.from({ length: 35 }, () => ({ ...tool, id: crypto.randomUUID() }));
      threads[a.id] = { ...threads[a.id], toolActivities: [...many, next] };
      render({ selected: a.id });
      const list = required(
        group.querySelector<HTMLDivElement>(".tool-activity-list"),
        "Command list",
      );
      check(
        list.clientHeight <= Math.min(320, innerHeight * 0.45) + 1 &&
          list.scrollHeight > list.clientHeight,
        "Expanded commands exceeded their scroll boundary",
      );
      list.scrollTop = 0;
      list.dispatchEvent(new Event("scroll"));
      threads[a.id] = {
        ...threads[a.id],
        toolActivities: [...many, next, { ...tool, id: crypto.randomUUID() }],
      };
      render({ selected: a.id });
      check(list.scrollTop === 0, "A new command pulled the reader away from earlier output");
    },
  );
  await run(
    "project switcher preloads machines and only navigates on project selection",
    async (root) => {
      const local = {
        id: crypto.randomUUID(),
        path: "/local/tidy",
        name: "tidy",
        openedAt: timestamp,
      };
      const remoteProject = { ...local, id: crypto.randomUUID(), path: "/remote/tidy" };
      const remoteId = crypto.randomUUID();
      let loads = 0;
      const choices: { machine: string; project?: string }[] = [];
      let added = 0;
      let cancelled = 0;
      const renderPicker = (disabled = false) =>
        flushSync(() =>
          root.render(
            <ProjectSwitcher
              machines={[
                { id: "local", label: "This machine", status: null },
                { id: remoteId, label: "Mac", status: { kind: "connected", target: "mac" } },
              ]}
              projects={[{ ...local, id: crypto.randomUUID() }, local]}
              projectId={local.id}
              disabled={disabled}
              loadProjects={async () => {
                loads++;
                return [remoteProject];
              }}
              onChoose={async (machine, project) => {
                choices.push({ machine, project });
              }}
              onCancelNavigation={() => {
                cancelled++;
              }}
              onAddMachine={() => {
                added++;
              }}
              cloudWorkspaces={[]}
              onCloudChange={() => {}}
            />,
          ),
        );
      renderPicker();
      await until(() => loads === 1, "Remote projects preloaded");
      await settle();
      const trigger = required(
        host.querySelector<HTMLButtonElement>("[aria-label='Switch project']"),
        "Switcher trigger",
      );
      trigger.click();
      await settle();
      let dialog = required(
        host.querySelector<HTMLDivElement>("[popover][role=dialog]"),
        "Project switcher",
      );
      check(dialog.matches(":popover-open"), "Project switcher did not open");
      check(!host.querySelector("dialog[open]"), "Project picker opened a modal");
      const anchor = trigger.getBoundingClientRect();
      const popup = dialog.getBoundingClientRect();
      check(
        Math.abs(popup.left - Math.max(8, anchor.left)) < 2 && popup.top >= anchor.bottom,
        "Project dropdown is not anchored below its trigger",
      );
      check(!dialog.querySelector("input"), "Project switcher contains a search field");
      let groups = dialog.querySelectorAll<HTMLDetailsElement>("details");
      check(
        groups[0].querySelectorAll(".machine-project-row").length === 1 &&
          groups[0].querySelector(".machine-project-row")?.getAttribute("aria-current") === "page",
        "The same project folder appeared twice or lost its active selection",
      );
      required(groups[0].querySelector("summary"), "Local machine heading").click();
      await settle();
      check(!groups[0].open, "Local machine did not collapse");
      trigger.click();
      await settle();
      trigger.click();
      await settle();
      dialog = required(
        host.querySelector<HTMLDivElement>("[popover][role=dialog]"),
        "Reopened dropdown",
      );
      groups = dialog.querySelectorAll<HTMLDetailsElement>("details");
      const localHeading = required(groups[0].querySelector("summary"), "Local machine heading");
      check(document.activeElement === localHeading, "Reopening tried to focus a hidden project");
      localHeading.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      const remoteHeading = required(groups[1].querySelector("summary"), "Remote machine heading");
      check(
        document.activeElement === remoteHeading,
        "Arrow navigation skipped a collapsed machine",
      );
      remoteHeading.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
      );
      check(
        document.activeElement === localHeading,
        "Arrow navigation entered a collapsed machine",
      );
      remoteHeading.click();
      await settle();
      check(choices.length === 0, "Expanding a machine changed workspaces");
      const project = required(
        groups[1].querySelector<HTMLButtonElement>(".machine-project-row"),
        "Remote project",
      );
      check(project.title === "/remote/tidy", "Project metadata was not preloaded");
      const cancelledBeforeSelection = cancelled;
      project.click();
      await until(() => !dialog.matches(":popover-open"), "Project opens and closes switcher");
      check(
        cancelled === cancelledBeforeSelection,
        "Completed selection cancelled its background refresh",
      );
      check(
        choices[0]?.machine === remoteId && choices[0]?.project === remoteProject.id,
        "Project opened on the wrong machine",
      );
      await until(() => document.activeElement === trigger, "Closing restores trigger focus");
      trigger.click();
      await settle();
      const outside = document.createElement("button");
      document.body.append(outside);
      try {
        outside.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        await until(
          () => !host.querySelector("[popover]:popover-open"),
          "Click away closes dropdown",
        );
        check(Number(choices.length) === 1, "Click away changed the selected project");
      } finally {
        outside.remove();
      }
      trigger.click();
      await settle();
      const reopened = required(
        host.querySelector<HTMLDivElement>("[popover][role=dialog]"),
        "Reopened dropdown",
      );
      required(
        reopened.querySelector<HTMLButtonElement>(".machine-project-footer .machine-project-add"),
        "Add machine",
      ).click();
      await until(() => !reopened.matches(":popover-open"), "Add machine closes dropdown");
      check(
        added === 1 && !reopened.matches(":popover-open"),
        "Add machine did not dismiss the switcher",
      );
      trigger.click();
      await settle();
      renderPicker(true);
      await until(
        () => !host.querySelector("[popover]:popover-open"),
        "Disabling closes the dropdown",
      );
      renderPicker();
      await settle();
      check(
        !host.querySelector("[popover]:popover-open"),
        "Re-enabling reopened a dismissed dropdown",
      );
    },
  );

  await run(
    "project switcher retains failed catalogs and cancels pending selections on Escape",
    async (root) => {
      const remoteId = crypto.randomUUID();
      const project = {
        id: crypto.randomUUID(),
        path: "/remote/tidy",
        name: "tidy",
        openedAt: timestamp,
      };
      let fail = true;
      let cancel = 0;
      let resolve: () => void = () => {};
      const pending = new Promise<void>((done) => {
        resolve = done;
      });
      flushSync(() =>
        root.render(
          <ProjectSwitcher
            machines={[
              { id: remoteId, label: "Mac", status: { kind: "connected", target: "mac" } },
            ]}
            projects={[]}
            disabled={false}
            loadProjects={async () => {
              if (fail) throw new Error("Unavailable");
              return [project];
            }}
            onChoose={() => pending}
            onCancelNavigation={() => {
              cancel++;
            }}
            cloudWorkspaces={[]}
            onCloudChange={() => {}}
          />,
        ),
      );
      const trigger = required(
        host.querySelector<HTMLButtonElement>("[aria-label='Switch project']"),
        "Switcher trigger",
      );
      trigger.click();
      await settle();
      const dialog = required(
        host.querySelector<HTMLDivElement>("[popover][role=dialog]"),
        "Project switcher",
      );
      required(dialog.querySelector("summary"), "Machine heading").click();
      await until(
        () => Boolean(dialog.querySelector(".machine-project-retry")),
        "Failed catalog retry",
      );
      fail = false;
      required(dialog.querySelector<HTMLButtonElement>(".machine-project-retry"), "Retry").click();
      await until(() => Boolean(dialog.querySelector(".machine-project-row")), "Catalog recovers");
      required(dialog.querySelector<HTMLButtonElement>(".machine-project-row"), "Project").click();
      await settle();
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await until(() => !dialog.matches(":popover-open"), "Escape closes dropdown");
      check(
        !dialog.matches(":popover-open") && cancel === 1,
        "Escape did not cancel the pending selection",
      );
      resolve();
      await settle();
      check(
        !dialog.matches(":popover-open") && cancel === 1,
        "Late selection changed the dismissed dialog",
      );
    },
  );

  await run("project removal is immediate, machine-scoped and recoverable", async (root) => {
    const project = {
      id: crypto.randomUUID(),
      path: "/project",
      name: "Project",
      openedAt: timestamp,
    };
    const remoteId = crypto.randomUUID();
    let rejectRemoval: (error: Error) => void = () => {};
    const calls: string[] = [];
    flushSync(() =>
      root.render(
        <ProjectSwitcher
          machines={[
            { id: "local", label: "This machine", status: null },
            { id: remoteId, label: "Mac", status: { kind: "connected", target: "mac" } },
          ]}
          projects={[project]}
          projectId={project.id}
          disabled={false}
          loadProjects={async () => [project]}
          onChoose={async () => {}}
          onRemove={(machine, id) => {
            calls.push(`${machine}:${id}`);
            if (calls.length > 1) return Promise.resolve();
            return new Promise<void>((_, reject) => {
              rejectRemoval = reject;
            });
          }}
          cloudWorkspaces={[]}
          onCloudChange={() => {}}
        />,
      ),
    );
    await settle();
    required(
      host.querySelector<HTMLButtonElement>("[aria-label='Switch project']"),
      "Trigger",
    ).click();
    await settle();
    const dialog = required(
      host.querySelector<HTMLDivElement>("[popover][role=dialog]"),
      "Dropdown",
    );
    const headings = dialog.querySelectorAll("summary");
    const remoteHeading = required(headings[1], "Remote machine");
    remoteHeading.click();
    await settle();
    const remove = required(
      dialog.querySelector<HTMLButtonElement>("[aria-label='Remove Project from Mac']"),
      "Remove action",
    );
    remove.focus();
    remove.click();
    await settle();
    check(document.activeElement === remoteHeading, "Removal lost focus outside the dropdown");
    check(
      calls.length === 1 && calls[0] === `${remoteId}:${project.id}`,
      "Removal targeted a different machine",
    );
    check(
      dialog.querySelectorAll(".machine-project-row").length === 1,
      "Removed row remained visible or removed the local copy",
    );
    check(dialog.matches(":popover-open"), "Removal dismissed the dropdown");
    const updateMessage = "Update Tidy on this machine to remove projects.";
    rejectRemoval(new UserFacingError(updateMessage));
    await until(
      () => dialog.querySelectorAll(".machine-project-row").length === 2,
      "Failed removal restores row",
    );
    check(
      dialog.querySelector("[role=alert]")?.textContent === updateMessage,
      "Removal failure was hidden",
    );
    remoteHeading.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    check(
      document.activeElement ===
        remoteHeading.closest("details")?.querySelector(".machine-project-row"),
      "Restored project was not reachable with the keyboard",
    );
    required(
      dialog.querySelector<HTMLButtonElement>("[aria-label='Remove Project from Mac']"),
      "Retry removal",
    ).click();
    await until(
      () => dialog.querySelectorAll(".machine-project-row").length === 1,
      "Removal succeeds",
    );
    await settle();
    check(!dialog.querySelector("[role=alert]"), "Successful retry retained its error");
    check(Number(calls.length) === 2, "Removal could not be retried after failure");
    check(document.activeElement === remoteHeading, "Successful removal lost keyboard focus");
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await until(() => !dialog.matches(":popover-open"), "Escape closes after project removal");
  });

  await run("draft sidebar motion stays brief, interruptible and accessible", async (root) => {
    const threads = [makeThread({ count: 1 }), makeThread({ count: 1 })];
    const originalMatchMedia = window.matchMedia;
    let reduced = false;
    window.matchMedia = (query) => {
      const media = originalMatchMedia.call(window, query);
      if (query === "(prefers-reduced-motion: reduce)")
        Object.defineProperty(media, "matches", { get: () => reduced });
      return media;
    };
    const render = (text: string, project = projectId) =>
      flushSync(() =>
        root.render(
          <StrictMode>
            <ThreadSidebar
              projectId={project}
              threads={threads}
              search=""
              draft={{ text, selected: false, onSelect() {} }}
              renderThread={(thread) => <button>{thread.title}</button>}
            />
          </StrictMode>,
        ),
      );
    const list = () => required(host.querySelector<HTMLElement>(".sidebar-list"), "Sidebar list");
    const animations = () => list().getAnimations({ subtree: true });
    const pointer = () =>
      document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    try {
      render("");
      check(animations().length === 0, "Initial sidebar animated");
      pointer();
      render("A saved draft");
      check(animations().length === 3, "Draft and displaced rows did not animate together");
      const animation = required(animations()[0], "Draft animation");
      check(animation.effect?.getTiming().duration === 150, "Draft motion exceeds its time budget");
      for (const animation of animations()) animation.currentTime = 60;
      render("");
      const ghost = required(
        list().querySelector<HTMLElement>('[aria-hidden="true"]'),
        "Exiting draft",
      );
      check(
        ghost.inert && ghost.style.pointerEvents === "none",
        "Exiting draft accepts interactions",
      );
      check(!ghost.classList.contains("thread-select"), "Exiting draft is still selectable");
      render("Another saved draft");
      check(!list().contains(ghost), "Interrupted exit left a duplicate draft");
      for (const animation of animations()) animation.finish();
      await frame();
      check(animations().length === 0, "Completed draft motion stayed active");
      render("");
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      render("Keyboard draft");
      check(animations().length === 0, "Keyboard navigation animated");
      pointer();
      reduced = true;
      render("");
      check(animations().length === 0, "Reduced motion moved sidebar rows");
      reduced = false;
      render("Project draft", crypto.randomUUID());
      check(animations().length === 0, "Project switch animated unrelated rows");
      render("");
      check(animations().length === 0, "Project scope did not reset its baseline");
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  for (const anchoring of ["auto", "none"] as const) {
    await run(
      `draft sidebar motion preserves scrolled rows with ${anchoring} anchoring`,
      async (root) => {
        const originalMatchMedia = window.matchMedia;
        window.matchMedia = (query) => {
          const media = originalMatchMedia.call(window, query);
          if (query === "(prefers-reduced-motion: reduce)")
            Object.defineProperty(media, "matches", { value: false });
          return media;
        };
        try {
          const threads = Array.from({ length: 100 }, (_, index) => ({
            ...makeThread({ count: 1 }),
            title: `Workspace review ${index + 1}`,
          }));
          const render = (text: string) =>
            flushSync(() =>
              root.render(
                <div style={{ height: 240, width: 264, display: "flex" }}>
                  <ThreadSidebar
                    projectId={projectId}
                    threads={threads}
                    search=""
                    draft={{ text, selected: false, onSelect() {} }}
                    renderThread={(thread) => (
                      <button style={{ height: 36 }}>{thread.title}</button>
                    )}
                  />
                </div>,
              ),
            );
          render("");
          await frame();
          const scroll = required(
            host.querySelector<HTMLElement>(".sidebar-scroll"),
            "Scrollable sidebar",
          );
          scroll.style.overflowAnchor = anchoring;
          scroll.scrollTop = 1200;
          scroll.dispatchEvent(new Event("scroll"));
          await frame();
          const row = required(
            [...host.querySelectorAll<HTMLElement>("[data-thread-id]")].find((item) => {
              const bounds = item.getBoundingClientRect();
              const viewport = scroll.getBoundingClientRect();
              return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
            }),
            "Visible scrolled row",
          );
          const before = row.getBoundingClientRect().top;
          const previousScroll = scroll.scrollTop;
          document.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
          render("Recover this workspace prompt");
          const animations = scroll.getAnimations({ subtree: true });
          for (const animation of animations) {
            animation.pause();
            animation.currentTime = 0;
          }
          check(animations.length < 12, "Draft animated offscreen thread rows");
          const after = row.getBoundingClientRect().top;
          check(
            Math.abs(after - before) < 1,
            `Draft insertion jumped the visible row: ${JSON.stringify({
              before,
              after,
              previousScroll,
              scrollTop: scroll.scrollTop,
              offsetTop: row.offsetTop,
              transform: getComputedStyle(row).transform,
              reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
              animations: animations.map((animation) => ({
                target:
                  animation.effect instanceof KeyframeEffect
                    ? animation.effect.target?.getAttribute("data-thread-id")
                    : null,
                time: animation.currentTime,
                state: animation.playState,
                keyframes:
                  animation.effect instanceof KeyframeEffect ? animation.effect.getKeyframes() : [],
              })),
            })}`,
          );
          if (anchoring === "auto") {
            check(scroll.scrollTop > previousScroll, "Browser anchoring did not run");
            check(animations.length === 0, "Anchored rows received a redundant animation");
          } else check(animations.length > 0, "Unanchored visible rows did not animate");
          for (const animation of animations) animation.finish();
          await frame();
          check(
            scroll.getAnimations({ subtree: true }).length === 0,
            "Scrolled motion did not finish",
          );
          check(!scroll.querySelector('[aria-hidden="true"]'), "Scrolled motion left a ghost row");
        } finally {
          window.matchMedia = originalMatchMedia;
        }
      },
    );
  }

  for (const withExistingFile of [false, true]) {
    await run(
      `pasted images survive thread navigation, text updates and history recall (${withExistingFile ? "existing file" : "empty draft"})`,
      async (root) => {
        const { App } = await import("../app");
        const project = {
          id: crypto.randomUUID(),
          path: "/synthetic/paste-project",
          name: "Paste fixture",
          openedAt: timestamp,
        };
        const previous: Thread = {
          ...makeThread({ count: 2 }),
          projectId: project.id,
          title: "Previous conversation",
          status: "completed",
        };
        const snapshot: ProjectSnapshot = {
          project,
          threads: [summarizeThread(previous)],
          designs: [],
          folders: [],
        };
        const harnesses: Bootstrap["harnesses"] = [{ id: "codex", name: "Codex", status: "ready" }];
        const bootstrap: Bootstrap = { projects: [project], activeProject: snapshot, harnesses };
        const existing: AttachedFile[] = withExistingFile
          ? [{ id: crypto.randomUUID(), name: "Notes.txt", mimeType: "text/plain", size: 5 }]
          : [];
        const stored = new Map(existing.map((file) => [file.id, file]));
        const uploads: string[] = [];
        const gate = deferred<void>();
        const drafts = new Map<string, Record<string, Draft>>();
        const png =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSkcAAAAASUVORK5CYII=";
        let submitted: Parameters<DesktopAPI["startThread"]>[0] | undefined;
        let started: Thread | undefined;
        const api: DesktopAPI = {
          ...nativeAPI,
          cloud: undefined,
          browser: undefined,
          bootstrap: async () => bootstrap,
          checkHarnesses: async () => harnesses,
          selectProject: async () => snapshot,
          onEvent: () => () => {},
          onUpdate: () => () => {},
          updateState: async () => ({ status: "unsupported" }),
          repositoryContext: async () => ({
            machine: "Fixture",
            repository: false,
            branch: null,
            branches: [],
          }),
          skills: async () => ({ skills: [] }),
          harnessDetails: async () => ({
            models: [],
            windows: [],
            updatedAt: timestamp,
            usagePage: "subscription",
          }),
          harnessUsage: async () => ({
            windows: [],
            state: "unknown",
            updatedAt: timestamp,
            usagePage: "subscription",
          }),
          warmThread: async () => {},
          threadPorts: async () => [],
          async addAttachment(projectId, name, dataUrl) {
            check(projectId === project.id, "Upload used the wrong project");
            check(dataUrl === `data:image/png;base64,${png}`, "Paste lost image bytes");
            uploads.push(name);
            await gate.promise;
            const file = {
              id: crypto.randomUUID(),
              name,
              mimeType: "image/png",
              size: 68,
              previewUrl: dataUrl,
            };
            stored.set(file.id, file);
            return file;
          },
          readAttachment: async (_projectId, id) => required(stored.get(id), "Stored attachment"),
          readThread: async (_projectId, id) =>
            id === previous.id ? previous : required(started, "Started thread"),
          async startThread(input) {
            submitted = input;
            started = {
              id: required(input.threadId, "Thread ID"),
              projectId: project.id,
              harness: "codex",
              designIds: [],
              title: "Pasted images",
              status: "idle",
              revision: 2,
              updatedAt: timestamp,
              messages: [
                { id: crypto.randomUUID(), role: "user", text: "Earlier text-only request" },
                {
                  id: required(input.messageId, "Message ID"),
                  role: "user",
                  text: input.prompt,
                  attachments: input.attachmentIds?.map((id) =>
                    required(stored.get(id), "Sent file"),
                  ),
                },
              ],
            };
            return started;
          },
        };
        const machine = { id: "local" as const, label: "Fixture", status: null };
        flushSync(() =>
          root.render(
            <App
              workspaceAPI={api}
              machine={{
                current: machine,
                machines: [machine],
                connected: true,
                switching: false,
                select() {},
                navigate() {},
                cancelProjectNavigation() {},
                projects: async () => [project],
                openProject: async () => {},
              }}
              cloud={{
                busy: false,
                error: "",
                state: undefined,
                account: undefined,
                signIn: async () => {},
                signOut: async () => {},
                retry() {},
              }}
              initial={{
                bootstrap,
                relation: "matching",
                draft: {
                  text: "",
                  harness: "codex",
                  designIds: [],
                  ...(withExistingFile ? { attachments: existing } : {}),
                },
              }}
              draftCache={drafts}
            />,
          ),
        );
        await settle();
        const current = () => required(drafts.get("local"), "Draft cache");
        const draft = () => required(current()[`${project.id}:new`], "New draft");
        const editor = () => required(host.querySelector<HTMLElement>("#thread-prompt"), "Editor");
        function key(value: string) {
          const range = document.createRange();
          range.selectNodeContents(editor());
          range.collapse(value === "ArrowUp");
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
          flushSync(() =>
            editor().dispatchEvent(
              new KeyboardEvent("keydown", {
                key: value,
                bubbles: true,
                cancelable: true,
              }),
            ),
          );
        }
        function paste() {
          editor().focus();
          const range = document.createRange();
          range.selectNodeContents(editor());
          range.collapse(false);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
          const data = new DataTransfer();
          data.items.add(
            new File([Uint8Array.from(atob(png), (c) => c.charCodeAt(0))], "image.png", {
              type: "image/png",
            }),
          );
          flushSync(() =>
            editor().dispatchEvent(
              new ClipboardEvent("paste", {
                bubbles: true,
                cancelable: true,
                clipboardData: data,
              }),
            ),
          );
        }
        paste();
        check(draft().attachments?.length === existing.length + 1, "Paste discarded its image");
        flushSync(() => document.execCommand("insertText", false, " Describe these "));
        paste();
        check(draft().attachments?.length === existing.length + 2, "Second paste lost files");
        check(host.querySelectorAll(".composer-body img").length === 2, "Missing instant previews");
        const start = required(host.querySelector<HTMLButtonElement>(".composer-submit"), "Start");
        check(start.disabled, "Sending was enabled before images were stored");
        const expand = required(
          host.querySelector<HTMLButtonElement>('.composer-body [aria-label="Preview image.png"]'),
          "Preview pasted image",
        );
        flushSync(() => {
          expand.focus();
          expand.click();
        });
        const preview = required(
          document.querySelector('dialog[open][aria-label="Image preview: image.png"]'),
          "Pasted image preview",
        );
        check(preview.matches(":modal"), "Image preview did not open as a modal");
        const temporarySource = required(expand.querySelector("img"), "Temporary thumbnail").src;
        check(temporarySource.startsWith("blob:"), "Upload did not start with a temporary source");
        gate.resolve();
        await until(() => uploads.length === 2 && !start.disabled, "Both images stored");
        check(preview.isConnected && preview.matches(":modal"), "Upload closed the image preview");
        check(expand.isConnected, "Upload replaced the thumbnail button");
        check(
          expand.querySelector("img")?.src === `data:image/png;base64,${png}`,
          "Thumbnail retained the temporary source",
        );
        check(
          preview.querySelector("img")?.src === `data:image/png;base64,${png}`,
          "Image preview retained the temporary source",
        );
        required(
          preview.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]'),
          "Close pasted image",
        ).click();
        await until(() => !preview.isConnected, "Close pasted image preview");
        check(document.activeElement === expand, "Closing preview lost thumbnail focus");
        const draftText = draft().text;
        const composerText = editor().textContent;
        const composerHTML = editor().innerHTML;
        const draftButton = () =>
          required(
            [...host.querySelectorAll<HTMLButtonElement>(".sidebar-list > .thread-select")].find(
              (button) => button.textContent?.includes("Draft · Not sent"),
            ),
            "Unsent draft",
          );
        check(
          !host.querySelector(".sidebar-list > .thread-select"),
          "Typing published the draft before navigation",
        );
        flushSync(() =>
          required(
            host.querySelector<HTMLButtonElement>(`[data-thread-id="${previous.id}"] button`),
            "Previous conversation",
          ).click(),
        );
        await until(() => editor().textContent === "", "Previous thread's empty reply composer");
        check(draftButton().textContent?.includes("Describe these"), "Draft has no text preview");
        check(draftButton().getAttribute("aria-current") !== "true", "Draft remained selected");
        flushSync(() => draftButton().click());
        check(draft().text === draftText, "Returning to the draft changed its stored text");
        check(editor().textContent === composerText, "Returning to the draft lost its text");
        check(document.activeElement === editor(), "Returning did not focus the mounted composer");
        check(draftButton().getAttribute("aria-current") === "true", "Draft is not selected");
        const sidebarText = draftButton().textContent;
        flushSync(() => {
          editor().textContent = "Revised prompt";
          editor().dispatchEvent(new InputEvent("input", { bubbles: true }));
        });
        check(draft().text === "Revised prompt", "Editing the resumed draft lost input");
        check(draftButton().textContent === sidebarText, "Resumed typing changed the sidebar");
        flushSync(() =>
          required(
            host.querySelector<HTMLButtonElement>(`[data-thread-id="${previous.id}"] button`),
            "Previous conversation",
          ).click(),
        );
        check(
          draftButton().textContent?.includes("Revised prompt"),
          "Navigation kept the old title",
        );
        flushSync(() => draftButton().click());
        flushSync(() => {
          editor().innerHTML = composerHTML;
          editor().dispatchEvent(new InputEvent("input", { bubbles: true }));
        });
        const ids = draft().attachments?.map((file) => file.id) ?? [];
        check(
          ids.every((id) => stored.has(id)),
          "Draft kept temporary IDs after upload",
        );
        flushSync(() => start.click());
        await until(() => Boolean(submitted), "Submission");
        check(JSON.stringify(submitted?.attachmentIds) === JSON.stringify(ids), "Send lost files");
        check(submitted?.prompt.includes("Describe these"), "Send lost text between images");
        check(
          !host.querySelector(".sidebar-list > .thread-select"),
          "Sending left an unsent draft in the sidebar",
        );
        check(
          ids
            .slice(existing.length)
            .every((id) => submitted?.prompt.includes(`[[attachment:${id}]]`)),
          "Send did not remap pasted references to stored IDs",
        );
        await until(
          () => Boolean(started && current()[`${project.id}:${started.id}`]),
          "Reply draft",
        );
        await settle();
        await until(
          () => host.querySelectorAll(".message-text .attachment-reference").length === 2,
          "Sent images render as attachment chips",
        );
        check(
          !host.querySelector(".transcript")?.textContent?.includes("[[attachment:"),
          "Transcript exposed an unresolved attachment reference",
        );
        const sentThumbnail = required(
          host.querySelector<HTMLButtonElement>('.transcript [aria-label="Preview image.png"]'),
          "Preview sent image",
        );
        flushSync(() => {
          sentThumbnail.focus();
          sentThumbnail.click();
        });
        const sentPreview = required(
          document.querySelector<HTMLDialogElement>(
            'dialog[open][aria-label="Image preview: image.png"]',
          ),
          "Sent image preview",
        );
        check(
          sentPreview.querySelector("img")?.src === `data:image/png;base64,${png}`,
          "Sent image preview used the wrong source",
        );
        sentPreview.requestClose();
        await until(() => !sentPreview.isConnected, "Dismiss sent image preview");
        check(document.activeElement === sentThumbnail, "Sent preview lost thumbnail focus");
        editor().focus();
        key("ArrowUp");
        const reply = () => required(current()[`${project.id}:${started!.id}`], "Reply draft");
        check(reply().attachments?.length === ids.length, "Recall lost sent attachments");
        key("ArrowUp");
        check(reply().text === "Earlier text-only request", "Earlier message was not recalled");
        check(reply().attachments?.length === 0, "Text-only recall retained stale attachments");
        key("ArrowDown");
        check(reply().attachments?.length === ids.length, "Forward recall lost attachments");
        key("ArrowDown");
        check(
          !reply().text && reply().attachments?.length === 0,
          "Recall did not restore empty draft",
        );
      },
    );
  }

  await run(
    "skill picker exposes Retry to keyboard users and keeps selection visible on resize",
    async (root) => {
      let retries = 0;
      const catalog = Array.from({ length: 200 }, (_, index) => ({
        id: String(index),
        name: `review-${String(index).padStart(3, "0")}`,
        description: "Review changes",
      }));
      function Composer({ error }: { error: boolean }) {
        const [text, setText] = useState("$");
        return (
          <form
            className="composer"
            style={{
              position: "relative",
              containerType: "inline-size",
              containerName: "composer",
              width: 720,
              marginTop: 350,
            }}
          >
            <SkillPrompt
              value={text}
              onChange={setText}
              skills={error ? [] : catalog}
              status={error ? "error" : "ready"}
              retry={() => {
                retries++;
              }}
            />
            <button type="button">Model</button>
          </form>
        );
      }
      flushSync(() => root.render(<Composer error />));
      const editor = required(host.querySelector<HTMLElement>("[role=textbox]"), "Editor");
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      flushSync(() => editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
      await settle();
      const retry = required(
        host.querySelector<HTMLButtonElement>(".skill-picker button"),
        "Retry",
      );
      flushSync(() =>
        editor.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
        ),
      );
      await settle();
      check(retry.isConnected && document.activeElement === retry, "Tab cannot reach Retry");
      flushSync(() => retry.click());
      check(retries === 1 && document.activeElement === editor, "Retry lost editor focus");
      flushSync(() => root.render(<Composer error={false} />));
      await settle();
      flushSync(() =>
        editor.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
        ),
      );
      await settle();
      const owner = required(host.querySelector<HTMLElement>("form"), "Composer");
      const picker = required(host.querySelector<HTMLElement>(".skill-picker"), "Picker");
      owner.style.width = "400px";
      await until(() => {
        const selected = picker.querySelector<HTMLElement>('[aria-selected="true"]');
        return Boolean(
          selected &&
          selected.getBoundingClientRect().height === 52 &&
          selected.getBoundingClientRect().bottom <= picker.getBoundingClientRect().bottom,
        );
      }, "Resize keeps selected skill visible");
      picker.scrollTop = 2000;
      picker.dispatchEvent(new Event("scroll"));
      await settle();
      check(picker.scrollTop === 2000, "Manual scrolling snaps back to the selected skill");
      const active = editor.getAttribute("aria-activedescendant");
      check(
        Boolean(active && document.getElementById(active)),
        "Scrolling removed the active accessibility target",
      );
      check(
        picker.querySelectorAll('[role="option"]').length < 40,
        "Large catalog renders every option",
      );
    },
  );

  await run(
    "inline skills preserve surrounding text and attach above the composer",
    async (root) => {
      let value = "Please use $rev and keep this";
      function Composer() {
        const [text, setText] = useState(value);
        return (
          <form className="composer" style={{ position: "relative", marginTop: 350, width: 500 }}>
            <SkillPrompt
              value={text}
              onChange={(next) => {
                value = next;
                setText(next);
              }}
              skills={[{ id: "review", name: "review", description: "Review changes" }]}
              status="ready"
              retry={() => {}}
            />
          </form>
        );
      }
      flushSync(() => root.render(<Composer />));
      const editor = required(
        host.querySelector<HTMLElement>("[role=textbox]"),
        "Inline skill editor",
      );
      editor.focus();
      const range = document.createRange();
      range.setStart(required(editor.firstChild, "Prompt text"), 15);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      flushSync(() => editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
      await settle();
      const picker = required(host.querySelector<HTMLElement>(".skill-picker"), "Inline picker");
      check(
        picker.getBoundingClientRect().bottom <= editor.getBoundingClientRect().top + 1,
        "Picker covers editor",
      );
      flushSync(() =>
        editor.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        ),
      );
      check(value === "Please use $review and keep this", "Inline selection lost surrounding text");
      check(!host.querySelector(".skill-picker"), "Selection left picker open");
    },
  );

  await run(
    "prompt history recalls messages and attachments without consuming editor navigation",
    async (root) => {
      const file: AttachedFile = {
        id: crypto.randomUUID(),
        name: "reference.png",
        mimeType: "image/png",
        size: 20,
      };
      const history = [
        { text: "First request" },
        { text: "Multiline\nrequest" },
        { text: `Latest [[attachment:${file.id}]] request`, attachments: [file] },
      ];
      const draftFile = { ...file, id: crypto.randomUUID(), name: "draft.png" };
      let current: { text: string; attachments: AttachedFile[] } = {
        text: "",
        attachments: [draftFile],
      };
      function Composer() {
        const [draft, setDraft] = useState(current);
        current = draft;
        return (
          <SkillPrompt
            value={draft.text}
            files={draft.attachments}
            history={history}
            onChange={(text) => setDraft((draft) => ({ ...draft, text }))}
            onRecall={(entry) =>
              setDraft({ text: entry.text, attachments: entry.attachments ?? [] })
            }
            skills={[]}
            status="ready"
            retry={() => {}}
            style={{ whiteSpace: "pre-wrap", width: 500 }}
          />
        );
      }
      flushSync(() => root.render(<Composer />));
      const editor = required(host.querySelector<HTMLElement>("[role=textbox]"), "Prompt editor");
      editor.focus();
      function key(key: string, options: KeyboardEventInit = {}) {
        const event = new KeyboardEvent("keydown", {
          key,
          bubbles: true,
          cancelable: true,
          ...options,
        });
        flushSync(() => editor.dispatchEvent(event));
        return event.defaultPrevented;
      }
      function cursor(end: boolean) {
        const range = document.createRange();
        range.selectNodeContents(editor);
        range.collapse(!end);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }
      cursor(false);
      check(!key("ArrowDown"), "Empty draft consumed Down Arrow");
      check(!key("ArrowUp", { shiftKey: true }), "History consumed text selection shortcut");
      check(!key("ArrowUp", { isComposing: true }), "History consumed IME navigation");
      check(key("ArrowUp") && current.text === history[2].text, "Up did not recall latest request");
      check(current.attachments[0]?.id === file.id, "Recall lost message attachments");
      check(
        key("ArrowUp") && current.text === history[1].text,
        "Repeated Up did not recall older request",
      );
      check(!key("ArrowUp"), "History consumed movement inside a multiline request");
      cursor(false);
      check(
        key("ArrowUp") && current.text === history[0].text,
        "Up at the first line did not recall oldest request",
      );
      check(
        key("ArrowUp") && current.text === history[0].text,
        "History wrapped past oldest request",
      );
      check(
        key("ArrowDown") && current.text === history[1].text,
        "Down did not recall newer request",
      );
      check(
        key("ArrowDown") && current.text === history[2].text,
        "Down did not return to latest request",
      );
      check(
        key("ArrowDown") && !current.text && current.attachments[0]?.id === draftFile.id,
        "Down did not restore draft",
      );
      check(!key("ArrowDown"), "History stayed active after restoring draft");
      key("ArrowUp");
      flushSync(() => document.execCommand("insertText", false, " edited"));
      check(String(current.text).endsWith(" edited"), "Recalled request was not editable");
      check(!key("ArrowDown"), "History overwrote an edited request");
      cursor(false);
      check(!key("ArrowUp"), "History overwrote a nonempty draft");
      await settle();
    },
  );

  await run(
    "prompt history respects skills, wrapped lines, selection and disabled inputs",
    async (root) => {
      const recalled: string[] = [];
      const history = [{ text: "Older" }, { text: "/review" }];
      function render(value: string, disabled = false) {
        flushSync(() =>
          root.render(
            <SkillPrompt
              value={value}
              onChange={() => {}}
              onRecall={(entry) => {
                recalled.push(entry.text);
                render(entry.text);
              }}
              history={history}
              skills={[
                { id: "review", name: "review", description: "Review changes" },
                { id: "test", name: "test", description: "Run tests" },
              ]}
              status="ready"
              retry={() => {}}
              disabled={disabled}
              style={{ whiteSpace: "pre-wrap", width: 120 }}
            />,
          ),
        );
      }
      function key(key: string) {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
        flushSync(() => editor.dispatchEvent(event));
        return event.defaultPrevented;
      }
      render("/");
      const editor = required(host.querySelector<HTMLElement>("[role=textbox]"), "Prompt editor");
      flushSync(() => editor.focus());
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      flushSync(() => editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
      check(key("ArrowUp") && !recalled.length, "History consumed skill picker navigation");
      render("");
      range.selectNodeContents(editor);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      check(key("ArrowUp") && recalled[0] === "/review", "History did not recall skill command");
      check(!host.querySelector("[role=listbox]"), "Recall opened skill picker over history");
      range.selectNodeContents(editor);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      check(!key("ArrowUp"), "History consumed navigation with selected text");
      render("", true);
      check(!key("ArrowUp"), "Disabled editor recalled history");
      history[1] = { text: "A long request that wraps across several lines in the prompt editor" };
      render("");
      flushSync(() => editor.focus());
      range.selectNodeContents(editor);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      check(key("ArrowUp"), "Wrapped request was not recalled");
      check(!key("ArrowUp"), "History consumed Up Arrow inside wrapped text");
      await settle();
    },
  );

  for (const bootstrapFails of [false, true]) {
    await run(
      `startup with a partial sidebar cache preserves the selected thread${bootstrapFails ? " after a failed reload" : ""}`,
      async (root) => {
        const { App } = await import("../app");
        const scope = crypto.randomUUID();
        const selected = { ...makeThread(), status: "completed" as const };
        const cached = makeThread();
        const project = { id: projectId, name: "Project", path: "/fixture", openedAt: timestamp };
        const snapshot: ProjectSnapshot = {
          project,
          threads: [summarizeThread(cached), summarizeThread(selected)],
          designs: [],
          folders: [],
        };
        writeSidebarCache({
          scope,
          projects: [project],
          activeProject: { ...snapshot, threads: [summarizeThread(cached)] },
        });
        sessionStorage.setItem(`tidy:navigation:${scope}:mode`, JSON.stringify("code"));
        const selectionKey = `tidy:navigation:${scope}:threads`;
        sessionStorage.setItem(selectionKey, JSON.stringify({ [projectId]: selected.id }));
        const pending = deferred<Bootstrap>();
        const harnesses: Bootstrap["harnesses"] = [{ id: "codex", name: "Codex", status: "ready" }];
        const api: DesktopAPI = {
          ...nativeAPI,
          cloud: undefined,
          browser: undefined,
          bootstrap: () => pending.promise,
          checkHarnesses: async () => harnesses,
          selectProject: async () => snapshot,
          onEvent: () => () => {},
          onUpdate: () => () => {},
          updateState: async () => ({ status: "unsupported" }),
          repositoryContext: async () => ({
            machine: "Fixture",
            repository: false,
            branch: null,
            branches: [],
          }),
          skills: async () => ({ skills: [] }),
          harnessDetails: async () => ({
            models: [],
            windows: [],
            updatedAt: timestamp,
            usagePage: "subscription",
          }),
          harnessUsage: async () => ({
            windows: [],
            state: "unknown",
            updatedAt: timestamp,
            usagePage: "subscription",
          }),
          warmThread: async () => {},
          threadPorts: async () => [],
          readThread: async (_projectId, id) => (id === selected.id ? selected : cached),
        };
        const machine = { id: "local" as const, label: "Fixture", status: null };
        flushSync(() =>
          root.render(
            <NavigationScope value={scope}>
              <App
                workspaceAPI={api}
                machine={{
                  current: machine,
                  machines: [machine],
                  connected: true,
                  switching: false,
                  select() {},
                  navigate() {},
                  cancelProjectNavigation() {},
                  projects: async () => [project],
                  openProject: async () => {},
                }}
                cloud={{
                  busy: false,
                  error: "",
                  state: undefined,
                  account: undefined,
                  signIn: async () => {},
                  signOut: async () => {},
                  retry() {},
                }}
              />
            </NavigationScope>,
          ),
        );
        await settle();
        check(
          sessionStorage.getItem(selectionKey) === JSON.stringify({ [projectId]: selected.id }),
          "Partial cache cleared the selected thread before bootstrap",
        );
        if (bootstrapFails) {
          pending.reject(new Error("Workspace unavailable"));
          await settle();
          check(
            sessionStorage.getItem(selectionKey) === JSON.stringify({ [projectId]: selected.id }),
            "Failed reload cleared the cached thread selection",
          );
          return;
        }
        pending.resolve({ projects: [project], activeProject: snapshot, harnesses });
        await until(
          () =>
            Boolean(
              host.querySelector(
                `[data-thread-id="${selected.id}"] .thread-select[aria-current="true"]`,
              ),
            ),
          "Selected thread after bootstrap",
        );
      },
    );
  }

  await run(
    "agent assignments show queued work, open child transcripts, return to the parent and update live",
    async (root) => {
      const parent = makeThread({ count: 2 });
      const children = [
        makeThread({ count: 80 }),
        makeThread({ count: 2 }),
        makeThread({ count: 2 }),
      ];
      parent.title = "Checkout review";
      children[0].title = "Design review";
      children[1].title = "Security review";
      const threads = Object.fromEntries(
        [parent, ...children].map((thread) => [thread.id, thread]),
      );
      const listeners = new Set<(event: DesktopEvent) => void>();
      let calls = 0;
      let fail = true;
      let tasks: ThreadTask[] = children.map((child, index) => ({
        id: crypto.randomUUID(),
        childThreadId: child.id,
        originatingMessageId: parent.messages[0].id,
        sequence: index + 1,
        label: ["Review design", "Review security", "Review performance"][index],
        state: index === 2 ? "queued" : "running",
        kind: "initial",
        harness: "codex",
        model: "Selected model",
        effort: "high",
        createdAt: timestamp,
      }));
      const api: DesktopAPI = {
        ...nativeAPI,
        onEvent(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async readThreadTasks(input) {
          calls++;
          if (fail) throw new Error("Synthetic connection failure");
          return {
            tasks: input.threadId === parent.id ? tasks : [],
            parent:
              input.threadId === parent.id ? null : { threadId: parent.id, title: parent.title },
            nextCursor: null,
          };
        },
      };
      function Scene() {
        const [selected, setSelected] = useState(parent.id);
        return (
          <Conversations
            projectId={projectId}
            selected={selected}
            threads={threads}
            summaries={[parent, ...children.slice(0, 2)].map((thread, index) => ({
              ...summarizeThread(thread),
              ...(index === 2 ? { pendingApprovalCount: 1 } : {}),
            }))}
            api={api}
            active
            onOpenThread={(project, id) => {
              check(project === projectId, "Agent navigation crossed project scope");
              setSelected(id);
            }}
          />
        );
      }
      flushSync(() => root.render(<Scene />));
      await until(
        () => Boolean(host.querySelector(".agent-task-recovery")),
        "Actionable task refresh error",
      );
      fail = false;
      required(
        host.querySelector<HTMLButtonElement>(".agent-task-recovery button"),
        "Retry action",
      ).click();
      await until(() => host.querySelectorAll(".agent-task").length === 3, "Three agent rows");
      check(
        required(
          [...host.querySelectorAll<HTMLButtonElement>(".agent-task")].find((button) =>
            button.textContent?.includes("Review performance"),
          ),
          "Queued assignment",
        ).disabled,
        "Queued agent opened a nonexistent child",
      );
      check(
        visibleTranscript().textContent?.includes("Needs approval"),
        "Child approval was not surfaced in the parent group",
      );
      check(
        Boolean(
          visibleTranscript()
            .closest(".conversation")
            ?.querySelector('[aria-label="Security review · Needs approval"]'),
        ),
        "Child permission request was hidden from its parent",
      );
      const before = visibleTranscript();
      required(
        [...host.querySelectorAll<HTMLButtonElement>(".agent-task")].find((button) =>
          button.textContent?.includes("Design review"),
        ),
        "Agent row",
      ).click();
      await until(
        () => Boolean(visibleTranscript().closest(".conversation")?.querySelector(".agent-parent")),
        "Child parent navigation",
      );
      check(
        visibleTranscript().closest(".conversation")?.querySelector(".agent-parent")
          ?.textContent === parent.title &&
          visibleTranscript().closest(".conversation")?.querySelector('[aria-current="page"]')
            ?.textContent === children[0].title,
        "Breadcrumb did not identify the parent and child threads",
      );
      check(
        visibleTranscript().textContent?.includes(children[0].messages[0].text),
        "Agent row did not open the child transcript",
      );
      await settle();
      const breadcrumb = required(
        visibleTranscript()
          .closest(".conversation")
          ?.querySelector<HTMLElement>(".agent-breadcrumb"),
        "Child breadcrumb",
      ).getBoundingClientRect();
      const viewport = visibleTranscript().getBoundingClientRect();
      check(
        breadcrumb.bottom <= viewport.top + 1 && breadcrumb.height > 0,
        "Long child scrolled the breadcrumb out of view",
      );
      required(
        visibleTranscript()
          .closest(".conversation")
          ?.querySelector<HTMLButtonElement>(".agent-parent"),
        "Parent navigation",
      ).click();
      await until(() => visibleTranscript() === before, "Retained parent conversation");
      tasks = tasks.map((task, index) =>
        index === 0
          ? { ...task, state: "completed", sequence: 100, summary: "Reported design findings" }
          : task,
      );
      flushSync(() => {
        for (const listener of listeners)
          listener({
            type: "thread-summary",
            thread: { ...summarizeThread(parent), taskSequence: 100 },
          });
      });
      await until(
        () =>
          Boolean(
            visibleTranscript()
              .closest(".conversation")
              ?.querySelector('.agent-task[data-state="completed"]'),
          ),
        "Live completion status",
      );
      const beforeStreaming = calls;
      flushSync(() => {
        for (let index = 0; index < 20; index++)
          for (const listener of listeners)
            listener({
              type: "thread-summary",
              thread: {
                ...summarizeThread(children[1]),
                revision: index + 10,
                activity: "Inspecting styles",
              },
            });
      });
      await settle();
      check(calls === beforeStreaming, "Child streaming polled task storage");
      flushSync(() => root.render(<div />));
      check(listeners.size === 0, "Agent views leaked event subscriptions");
    },
  );

  await run(
    "subagents stay out of sidebar search, done lists and ordering while ordinary threads remain",
    async (root) => {
      const parent = makeThread({ count: 2 });
      const child = {
        ...makeThread({ count: 2 }),
        parentThreadId: parent.id,
        title: "Unique agent work",
      };
      const doneChild = { ...child, id: crypto.randomUUID(), doneAt: timestamp };
      const ordinary = {
        ...makeThread({ count: 2 }),
        title: "Independent work",
        acceptsThreadWork: true,
      };
      const summaries = [parent, child, doneChild, ordinary].map(summarizeThread);
      const render = (search: string) =>
        flushSync(() =>
          root.render(
            <ThreadSidebar
              projectId={projectId}
              threads={summaries}
              search={search}
              renderThread={(thread) => <button>{thread.title}</button>}
            />,
          ),
        );
      render("");
      check(
        host.querySelectorAll(".thread-order-row").length === 2,
        "Subagents entered the primary sidebar",
      );
      check(!host.querySelector(".done-threads"), "Completed subagent entered Done");
      check(!host.textContent?.includes(child.title), "Subagent visible in sidebar");
      check(
        host.textContent?.includes(ordinary.title),
        "Ordinary receiver disappeared from sidebar",
      );
      render("Unique agent");
      check(
        host.querySelectorAll(".thread-order-row").length === 0 &&
          host.textContent?.includes("No matching threads"),
        "Search exposed hidden child rows",
      );
      render("Independent");
      check(
        host.querySelectorAll(".thread-order-row").length === 1,
        "Ordinary thread search regressed",
      );
    },
  );

  await run(
    "incoming work permission updates instantly and serializes rapid reversals",
    async (root) => {
      const thread = makeThread({ count: 2 });
      const requests: { enabled: boolean; resolve(value: Thread): void }[] = [];
      const api: DesktopAPI = {
        ...nativeAPI,
        setThreadWorkPermission: async (_project, _thread, enabled) => {
          const pending = deferred<Thread>();
          requests.push({ enabled, resolve: pending.resolve });
          return pending.promise;
        },
      };
      flushSync(() =>
        root.render(<ThreadWorkPermission api={api} thread={summarizeThread(thread)} />),
      );
      const trigger = () =>
        required(host.querySelector<HTMLButtonElement>("button"), "Incoming work menu");
      const select = async (label: string) => {
        trigger().click();
        await settle();
        required(
          [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
            (button) => button.textContent?.includes(label),
          ),
          "Permission choice",
        ).click();
        await settle();
      };
      await select("Allow other threads");
      check(trigger().textContent?.includes("allowed"), "Permission waited for persistence");
      await select("Block other threads");
      check(
        trigger().textContent?.includes("blocked"),
        "Rapid reversal did not update immediately",
      );
      check(
        requests.length === 1 && requests[0].enabled,
        "Permission mutations were not serialized",
      );
      requests[0].resolve({ ...thread, acceptsThreadWork: true });
      await until(() => requests.length === 2, "Queued permission reversal");
      check(!requests[1].enabled, "Last permission choice was lost");
      requests[1].resolve({ ...thread, acceptsThreadWork: false });
      await settle();
      check(trigger().textContent?.includes("blocked"), "Late response undid the next interaction");
      flushSync(() =>
        root.render(
          <ThreadWorkPermission
            api={api}
            thread={{ ...summarizeThread(thread), parentThreadId: crypto.randomUUID() }}
          />,
        ),
      );
      check(!host.querySelector("button"), "Subagent exposed ordinary recipient permission");
    },
  );

  await run(
    "loaded older live assignments refresh with bounded IDs and failed launches show their reason",
    async (root) => {
      const parent = makeThread({ count: 2 });
      const tasks: ThreadTask[] = Array.from({ length: 52 }, (_, index) => ({
        id: crypto.randomUUID(),
        childThreadId: crypto.randomUUID(),
        sequence: index + 1,
        label: index === 0 ? "Older live task" : `Review ${index}`,
        originatingMessageId: parent.messages[0].id,
        state: index === 0 ? "running" : "completed",
        kind: "initial",
        harness: "codex",
        createdAt: new Date(Date.parse(timestamp) + index).toISOString(),
      }));
      const listeners = new Set<(event: DesktopEvent) => void>();
      const targeted: string[][] = [];
      const api: DesktopAPI = {
        ...nativeAPI,
        onEvent(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        async readThreadTasks(input) {
          if (input.taskIds) targeted.push(input.taskIds);
          const end = input.before ?? tasks.length;
          const start = Math.max(0, end - 50);
          return {
            parent: null,
            tasks: input.taskIds
              ? tasks.filter((task) => input.taskIds?.includes(task.id))
              : tasks.slice(start, end),
            nextCursor: input.taskIds ? null : start || null,
          };
        },
      };
      const render = (active = true) =>
        flushSync(() =>
          root.render(
            <Conversations
              projectId={projectId}
              selected={parent.id}
              threads={{ [parent.id]: parent }}
              api={api}
              active={active}
              onOpenThread={() => {}}
            />,
          ),
        );
      const revealLoaded = async () => {
        for (let page = 0; page < 10; page++) {
          const more = host.querySelector<HTMLButtonElement>(".agent-task-more");
          if (!more) return;
          more.click();
          await settle();
        }
      };
      render();
      await until(() => Boolean(host.querySelector(".agent-tasks")), "Latest assignments");
      required(
        host.querySelector<HTMLElement>(".agent-tasks summary"),
        "Assignment disclosure",
      ).click();
      await settle();
      required(
        [...host.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Show earlier assignments",
        ),
        "Earlier assignments",
      ).click();
      await until(() => Boolean(host.textContent?.includes("52 agents")), "Loaded history count");
      await revealLoaded();
      check(host.querySelectorAll(".agent-task").length === 52, "Loaded history");
      render(false);
      await settle();
      render();
      await settle();
      check(
        host.querySelectorAll(".agent-task").length === 52,
        "Returning to a parent discarded its loaded assignment history",
      );
      tasks[0] = {
        ...tasks[0],
        state: "failed",
        sequence: 100,
        error: "Permission changed before agent launch",
      };
      flushSync(() => {
        for (const listener of listeners)
          listener({
            type: "thread-summary",
            thread: { ...summarizeThread(parent), taskSequence: 100 },
          });
      });
      await until(
        () => Boolean(host.querySelector('.agent-task[data-state="failed"]')),
        "Older terminal update",
      );
      check(
        targeted.some((ids) => ids.includes(tasks[0].id)),
        "Older loaded task was not refreshed",
      );
      check(
        host.textContent?.includes("Permission changed before agent launch"),
        "Failed launch hid its reason",
      );
      check(
        host
          .querySelector<HTMLButtonElement>('.agent-task[data-state="failed"]')
          ?.title.includes("Failed"),
        "Failed launch was labeled queued",
      );
      render(false);
      await settle();
      tasks.push(
        ...Array.from({ length: 60 }, (_, index) => ({
          ...tasks[1],
          id: crypto.randomUUID(),
          childThreadId: crypto.randomUUID(),
          sequence: 101 + index,
          createdAt: new Date(Date.parse(timestamp) + 100 + index).toISOString(),
        })),
      );
      render();
      await until(
        () => Boolean(host.textContent?.includes("102 agents")),
        "Newest assignments merged with retained history",
      );
      await revealLoaded();
      required(
        [...host.querySelectorAll<HTMLButtonElement>("button")].find(
          (button) => button.textContent === "Show earlier assignments",
        ),
        "Gap in assignments created while away",
      ).click();
      await until(
        () => Boolean(host.textContent?.includes("112 agents")),
        "Intervening assignment count",
      );
      await revealLoaded();
      check(
        host.querySelectorAll(".agent-task").length === 112,
        "Intervening assignments remain reachable",
      );
    },
  );

  await run(
    "task history pages preserve active identities and cancellation recovery",
    async (root) => {
      const child = makeThread({ count: 2 });
      child.title = "Aleksandra Wiśniewska-Kowalczyk — accessibility review";
      const tasks: ThreadTask[] = Array.from({ length: 1000 }, (_, index) => ({
        id: crypto.randomUUID(),
        childThreadId: crypto.randomUUID(),
        sequence: index,
        label: `Release accessibility review ${index + 1}`,
        state: "completed",
        kind: "initial",
        harness: "codex",
        createdAt: timestamp,
      }));
      tasks[999] = {
        ...tasks[999],
        state: "failed",
        sequence: 2000,
        error: "Permission changed before launch",
      };
      const running: ThreadTask = {
        ...tasks[0],
        id: crypto.randomUUID(),
        childThreadId: child.id,
        label: child.title,
        state: "running",
      };
      tasks.push(running, {
        ...running,
        id: crypto.randomUUID(),
        state: "queued",
        kind: "followup",
      });
      const request = deferred<void>();
      const previousWidth = host.style.width;
      host.style.width = "128px";
      try {
        flushSync(() =>
          root.render(
            <AgentTasks
              tasks={tasks}
              summaries={
                new Map([[child.id, { ...summarizeThread(child), pendingApprovalCount: 1 }]])
              }
              projectId={projectId}
              onOpenThread={() => {}}
              onCancel={() => request.promise}
            />,
          ),
        );
        await settle();
        check(
          host.querySelectorAll(".agent-task").length === 26,
          "History was not bounded to 25 destinations",
        );
        check(
          host
            .querySelector('.agent-task[data-state="failed"]')
            ?.textContent?.includes(tasks[999].label),
          "Recent failure was hidden behind older history",
        );
        const active = required(
          host.querySelector<HTMLButtonElement>(`[aria-label="${child.title} · Needs approval"]`),
          "Active approval identity",
        );
        const name = required(
          active.querySelector<HTMLElement>(".agent-task-label"),
          "Visible task name",
        );
        const state = required(
          active.querySelector<HTMLElement>(".agent-task-state"),
          "Visible approval status",
        );
        const stop = required(
          host.querySelector<HTMLButtonElement>(`[aria-label="Stop ${child.title}"]`),
          "Active stop action",
        );
        check(name.getBoundingClientRect().width > 20, "Narrow task identity disappeared");
        check(
          state.getBoundingClientRect().bottom <= stop.getBoundingClientRect().top,
          "Narrow approval status overlapped Stop",
        );
        check(
          !required(host.querySelector<HTMLDetailsElement>(".agent-task-queue"), "Secondary queue")
            .open,
          "Queue expanded by default",
        );
        stop.click();
        await settle();
        required(
          host.querySelector<HTMLButtonElement>(".agent-task-more"),
          "Next history page",
        ).click();
        await settle();
        check(
          host.querySelectorAll(".agent-task").length === 51,
          "Next page did not add 25 history destinations",
        );
        check(
          stop.isConnected && stop.disabled && active.textContent?.includes("Stopping"),
          "Paging reset optimistic cancellation",
        );
        request.reject(new Error("Synthetic cancellation failure"));
        await settle();
        const retry = required(
          host.querySelector<HTMLButtonElement>(`[aria-label="Retry stopping ${child.title}"]`),
          "Cancellation retry",
        );
        required(
          host.querySelector<HTMLButtonElement>(".agent-task-more"),
          "Another history page",
        ).click();
        await settle();
        check(retry.isConnected && !retry.disabled, "Paging discarded cancellation recovery");
        check(
          host.querySelectorAll(".agent-task").length === 76,
          "History paging lost its boundary",
        );
        check(
          host.querySelectorAll(".model-provider-icon").length === 76,
          "Queued assignments duplicated provider identity",
        );
      } finally {
        host.style.width = previousWidth;
        request.resolve();
      }
    },
  );

  await run(
    "sidebar keeps full PR identifiers and child approval on separate wrapped lines",
    async (root) => {
      const thread = makeThread({ count: 2 });
      thread.pullRequests = Array.from(
        { length: 20 },
        (_, index) =>
          `https://github.com/example/platform/pull/${index === 19 ? "9007199254740991" : index + 1}`,
      );
      const previousWidth = host.style.width;
      host.style.width = "244px";
      let approvals = 0;
      try {
        flushSync(() =>
          root.render(
            <ThreadCard
              thread={summarizeThread(thread)}
              api={nativeAPI}
              selected
              loaded
              now={Date.now()}
              pending={false}
              childApprovalCount={2}
              onSelect={() => {}}
              onDone={() => {}}
              onOpenChildApproval={() => {
                approvals++;
              }}
            />,
          ),
        );
        await settle();
        const link = required(
          host.querySelector<HTMLAnchorElement>(".thread-pull-requests a"),
          "Latest PR link",
        );
        const number = required(link.querySelector<HTMLElement>("span"), "Full numeric identifier");
        const approval = required(
          host.querySelector<HTMLButtonElement>(".thread-card-status"),
          "Child approval action",
        );
        const a = link.getBoundingClientRect(),
          b = approval.getBoundingClientRect();
        check(number.scrollWidth <= number.clientWidth + 1, "Numeric PR identifier was clipped");
        check(link.textContent?.includes("#9007199254740991"), "Latest PR identifier changed");
        check(
          a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom,
          "PR and approval actions overlapped",
        );
        check(
          host.querySelectorAll(".thread-pull-requests").length === 1,
          "PR destination was duplicated",
        );
        approval.click();
        check(approvals === 1, "Wrapped approval action was unreachable");
        let doneCalls = 0;
        for (const variant of [
          { urls: [], approvals: 0 },
          { urls: ["https://github.com/example/platform/pull/260"], approvals: 0 },
          { urls: [], approvals: 2 },
          { urls: ["https://github.com/example/platform/pull/260"], approvals: 2 },
          { urls: thread.pullRequests ?? [], approvals: 2 },
        ]) {
          flushSync(() =>
            root.render(
              <ThreadCard
                thread={{ ...summarizeThread(thread), status: "idle", pullRequests: variant.urls }}
                api={nativeAPI}
                selected
                loaded
                now={Date.now()}
                pending={false}
                childApprovalCount={variant.approvals}
                onSelect={() => {}}
                onDone={() => {
                  doneCalls++;
                }}
                onOpenChildApproval={() => {}}
              />,
            ),
          );
          await settle();
          const card = required(host.querySelector<HTMLElement>(".thread-item"), "Sidebar row");
          const select = required(
            host.querySelector<HTMLButtonElement>(".thread-select"),
            "Thread destination",
          );
          const metadata = host.querySelector<HTMLElement>(".thread-card-trailing");
          const done = required(
            host.querySelector<HTMLButtonElement>(".thread-done"),
            "Done action",
          );
          check(
            card.getBoundingClientRect().height >= select.getBoundingClientRect().height,
            "Metadata shrank the normal thread row",
          );
          if (metadata) {
            check(
              metadata.getBoundingClientRect().bottom <= card.getBoundingClientRect().bottom,
              "Wrapped metadata escaped its row",
            );
            check(
              done.getBoundingClientRect().bottom <= metadata.getBoundingClientRect().top + 1,
              "Done overlapped metadata",
            );
          } else
            check(!variant.urls.length && !variant.approvals, "Actionable metadata disappeared");
          done.focus();
          check(document.activeElement === done, "Done was not keyboard reachable");
          done.click();
        }
        check(doneCalls === 5, "Metadata variants blocked Done");
      } finally {
        host.style.width = previousWidth;
      }
    },
  );

  await run(
    "repeated assignments show one destination per agent or independent thread",
    async (root) => {
      const child = makeThread({ count: 2 });
      const ordinary = makeThread({ count: 2 });
      let tasks: ThreadTask[] = [child, ordinary].flatMap((thread, group) =>
        Array.from({ length: 3 }, (_, index) => ({
          id: crypto.randomUUID(),
          childThreadId: thread.id,
          sequence: group * 3 + index,
          label: "Review",
          state: index === 0 ? "running" : "queued",
          kind: group ? "message" : index ? "followup" : "initial",
          harness: "codex",
          createdAt: new Date(Date.parse(timestamp) + index).toISOString(),
        })),
      );
      const summaries = new Map(
        [child, ordinary].map((thread) => [thread.id, summarizeThread(thread)]),
      );
      const render = () =>
        flushSync(() =>
          root.render(
            <AgentTasks
              tasks={tasks}
              summaries={summaries}
              projectId={projectId}
              onOpenThread={() => {}}
            />,
          ),
        );
      render();
      check(
        host.querySelectorAll(".agent-task").length === 2,
        "Follow-ups duplicated destination rows",
      );
      check(
        host.textContent?.includes("1 agent") && host.textContent?.includes("1 thread"),
        "Assignment count inflated destination count",
      );
      check(
        host.querySelectorAll('.agent-task[data-state="running"]').length === 2,
        "Queued follow-ups hid active destination work",
      );
      tasks = tasks.map((task, index) => ({
        ...task,
        state: index % 3 === 2 ? "running" : "completed",
        sequence: task.sequence + 20,
      }));
      render();
      check(
        host.querySelectorAll(".agent-task").length === 2 &&
          host.querySelectorAll('.agent-task[data-kind="followup"]').length === 1,
        "Destination did not advance to its active follow-up",
      );
    },
  );

  await run(
    "agent rows expose actionable states, focus queued work and recover individual stop failures",
    async (root) => {
      const child = makeThread({ count: 2 });
      child.title = "Visual review";
      const queuedName = `Queued ${"layout review ".repeat(12)}`.slice(0, 160);
      let tasks: ThreadTask[] = [
        {
          id: crypto.randomUUID(),
          childThreadId: crypto.randomUUID(),
          sequence: 1,
          label: queuedName,
          state: "queued",
          kind: "initial",
          harness: "codex",
          createdAt: timestamp,
        },
        {
          id: crypto.randomUUID(),
          childThreadId: child.id,
          sequence: 2,
          label: "Review layout",
          state: "running",
          kind: "initial",
          harness: "codex",
          createdAt: timestamp,
        },
      ];
      const opened: string[] = [];
      const requests: {
        project: string;
        taskId: string;
        resolve(): void;
        reject(error: Error): void;
      }[] = [];
      const requestCount = () => requests.length;
      const summaries = new Map([
        [child.id, { ...summarizeThread(child), pendingApprovalCount: 1 }],
      ]);
      const render = () =>
        flushSync(() =>
          root.render(
            <AgentTasks
              tasks={tasks}
              summaries={summaries}
              projectId={projectId}
              onOpenThread={(_project, id) => opened.push(id)}
              onCancel={(project, taskId) =>
                new Promise<void>((resolve, reject) => {
                  requests.push({ project, taskId, resolve, reject });
                })
              }
            />,
          ),
        );
      const previousWidth = host.style.width;
      host.style.width = "320px";
      try {
        render();
        await settle();
        const queued = required(
          host.querySelector<HTMLButtonElement>(`[aria-label="${queuedName} · Queued"] button`),
          "Queued identity",
        );
        const queuedGroup = required(queued.closest<HTMLElement>('[role="group"]'), "Queued row");
        queuedGroup.focus();
        check(
          document.activeElement === queuedGroup && queuedGroup.tabIndex === 0,
          "Queued identity could not receive keyboard focus",
        );
        check(
          queuedGroup.getAttribute("aria-label")?.includes("Queued") &&
            queuedGroup.textContent?.includes(queuedName),
          "Queued row did not expose its identity and state",
        );
        queued.click();
        check(opened.length === 0, "Queued identity opened a nonexistent child");
        const approval = required(
          host.querySelector<HTMLButtonElement>('[aria-label="Visual review · Needs approval"]'),
          "Specific child approval",
        );
        check(
          approval.textContent?.includes("Needs approval"),
          "Approval was available only in a tooltip",
        );
        const childGroup = required(approval.closest<HTMLElement>('[role="group"]'), "Child row");
        check(
          childGroup
            .querySelector('[role="status"]')
            ?.textContent?.includes("Visual review · Needs approval"),
          "Live status omitted the affected child's identity",
        );
        const stop = required(
          queuedGroup.querySelector<HTMLButtonElement>(`[aria-label="Stop ${queuedName}"]`),
          "Stop queued assignment",
        );
        stop.focus();
        check(document.activeElement === stop, "Queued stop action was not keyboard reachable");
        stop.click();
        await settle();
        check(
          requestCount() === 1 &&
            requests[0].taskId === tasks[0].id &&
            requests[0].project === projectId,
          "Stop did not target exactly the owned task",
        );
        check(
          stop.disabled && queuedGroup.textContent?.includes("Stopping"),
          "Stop did not respond optimistically",
        );
        stop.click();
        check(requestCount() === 1, "Pending cancellation was submitted twice");
        const childStop = required(
          childGroup.querySelector<HTMLButtonElement>('[aria-label="Stop Visual review"]'),
          "Independent stop action",
        );
        check(!childStop.disabled, "Stopping one assignment blocked another");
        childStop.click();
        await settle();
        check(
          requestCount() === 2 && requests[1].taskId === tasks[1].id,
          "The next stop targeted the wrong assignment",
        );
        check(opened.length === 0, "Stopping an assignment also opened its transcript");
        requests[0].reject(new Error("Synthetic cancellation failure"));
        await settle();
        const retry = required(
          queuedGroup.querySelector<HTMLButtonElement>(
            `[aria-label="Retry stopping ${queuedName}"]`,
          ),
          "Retry cancellation",
        );
        check(
          !retry.disabled &&
            queuedGroup.querySelector('[role="alert"]')?.textContent?.includes("Could not stop"),
          "Cancellation failure had no recovery",
        );
        check(
          queued.textContent?.includes("Queued") && !queued.textContent?.includes("Stopping"),
          "Failed cancellation hid the actual task state",
        );
        retry.click();
        await settle();
        check(
          requestCount() === 3 && requests[2].taskId === tasks[0].id,
          "Retry changed the cancellation target",
        );
        requests[1].resolve();
        requests[2].resolve();
        tasks = tasks.map((task) => ({
          ...task,
          state: "cancelled",
          sequence: task.sequence + 10,
        }));
        render();
        await settle();
        check(
          host.querySelectorAll(".agent-task-stop").length === 0,
          "Terminal assignments retained stop controls",
        );
        check(
          queuedGroup.textContent?.includes("Stopped") &&
            queuedGroup.querySelector('[role="status"]')?.textContent?.includes("Stopped"),
          "Confirmed cancellation was not visible or announced",
        );
        check(
          queuedGroup.scrollWidth <= queuedGroup.clientWidth + 1,
          "Long queued identity overflowed a narrow conversation",
        );
      } finally {
        host.style.width = previousWidth;
        for (const request of requests) request.resolve();
      }
    },
  );

  await run(
    "incoming work links its source and conversation controls cancel only their owned task",
    async (root) => {
      const sender = makeThread({ count: 2 });
      sender.title = "Design coordinator";
      const recipient = makeThread({ count: 2 });
      recipient.messageSources = { [recipient.messages[0].id]: { threadId: sender.id } };
      const task: ThreadTask = {
        id: crypto.randomUUID(),
        childThreadId: crypto.randomUUID(),
        sequence: 1,
        label: "Queued typography review",
        state: "queued",
        kind: "initial",
        harness: "codex",
        createdAt: timestamp,
        originatingMessageId: recipient.messages[0].id,
      };
      const opened: string[] = [];
      const cancellations: string[][] = [];
      const api: DesktopAPI = {
        ...nativeAPI,
        readThreadTasks: async () => ({ parent: null, tasks: [task], nextCursor: null }),
        cancelThreadTask: async (project, parent, id) => {
          cancellations.push([project, parent, id]);
        },
      };
      flushSync(() =>
        root.render(
          <Conversation
            thread={recipient}
            identity={recipient.id}
            api={api}
            active
            summaries={[summarizeThread(sender)]}
            onOpenThread={(_project, id) => opened.push(id)}
          />,
        ),
      );
      await until(
        () => Boolean(host.querySelector('[aria-label="Work from another thread"]')),
        "Incoming source projection",
      );
      const source = required(
        [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          button.textContent?.includes("From Design coordinator"),
        ),
        "Source thread link",
      );
      source.click();
      check(opened.length === 1 && opened[0] === sender.id, "Source link opened the wrong thread");
      await until(
        () => Boolean(host.querySelector(`[aria-label="Stop ${task.label}"]`)),
        "Queued stop control",
      );
      required(
        host.querySelector<HTMLButtonElement>(`[aria-label="Stop ${task.label}"]`),
        "Queued stop",
      ).click();
      await settle();
      check(
        cancellations.length === 1 &&
          cancellations[0].join(":") === [recipient.projectId, recipient.id, task.id].join(":"),
        "Conversation cancellation lost its parent/task identity",
      );
      check(opened.length === 1, "Stopping work navigated away from the current thread");
    },
  );

  await run("touch sidebar Done and Reopen remain visible and hit-testable", async (root) => {
    if (!matchMedia("(hover: none), (pointer: coarse)").matches) return;
    const thread = makeThread({ count: 2 });
    thread.pullRequests = ["https://github.com/example/platform/pull/9007199254740991"];
    const previousWidth = host.style.width;
    host.style.width = "244px";
    let actions = 0,
      selections = 0;
    try {
      for (const doneAt of [undefined, timestamp]) {
        flushSync(() =>
          root.render(
            <ThreadCard
              thread={{ ...summarizeThread(thread), doneAt }}
              api={nativeAPI}
              selected
              loaded
              now={Date.now()}
              pending={false}
              childApprovalCount={2}
              onSelect={() => {
                selections++;
              }}
              onDone={() => {
                actions++;
              }}
              onOpenChildApproval={() => {}}
            />,
          ),
        );
        await settle();
        const done = required(
          host.querySelector<HTMLButtonElement>(".thread-done"),
          "Touch completion action",
        );
        const style = getComputedStyle(done);
        check(
          style.opacity === "1" && style.pointerEvents === "auto",
          "Touch action required hover or keyboard focus",
        );
        const time = required(host.querySelector<HTMLElement>(".thread-time"), "Timestamp");
        check(
          getComputedStyle(time).visibility === "hidden",
          "Timestamp overlapped the touch action",
        );
        const box = done.getBoundingClientRect();
        const target = document
          .elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
          ?.closest<HTMLButtonElement>(".thread-done");
        check(target === done, "Touch action failed hit testing");
        check(
          done.textContent?.includes(doneAt ? "Reopen" : "Done"),
          "Completion action showed the wrong state",
        );
        target.click();
      }
      check(
        actions === 2 && selections === 0,
        "Touch completion action selected the thread instead",
      );
    } finally {
      host.style.width = previousWidth;
    }
  });

  await run("sidebar approval status and touch actions retain separate hit areas", async (root) => {
    const previousWidth = host.style.width;
    host.style.width = "250px";
    try {
      flushSync(() =>
        root.render(
          <ThreadCard
            thread={summarizeThread(makeThread({ count: 2 }))}
            selected
            loaded
            now={Date.now()}
            pending={false}
            childApprovalCount={1}
            onSelect={() => {}}
            onDone={() => {}}
          />,
        ),
      );
      await settle();
      const status = required(
        host.querySelector<HTMLElement>(".thread-card-status"),
        "Agent approval status",
      );
      const done = required(host.querySelector<HTMLElement>(".thread-done"), "Thread done action");
      if (matchMedia("(hover: none), (pointer: coarse)").matches) {
        const a = status.getBoundingClientRect(),
          b = done.getBoundingClientRect();
        check(
          a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom,
          "Approval status overlapped the Done control",
        );
      }
    } finally {
      host.style.width = previousWidth;
    }
  });

  await run(
    "parent approval action reaches its child without changing normal thread navigation",
    async (root) => {
      let parentOpens = 0,
        childOpens = 0;
      const counts = () => ({ parent: parentOpens, child: childOpens });
      const thread = makeThread({ count: 2 });
      flushSync(() =>
        root.render(
          <ThreadCard
            thread={summarizeThread(thread)}
            selected
            loaded
            now={Date.now()}
            pending={false}
            childApprovalCount={1}
            onSelect={() => {
              parentOpens++;
            }}
            onDone={() => {}}
            onOpenChildApproval={() => {
              childOpens++;
            }}
          />,
        ),
      );
      await settle();
      const approval = required(
        host.querySelector<HTMLButtonElement>(
          `[aria-label="Open agent approval for ${thread.title}"]`,
        ),
        "Direct child approval action",
      );
      approval.focus();
      check(document.activeElement === approval, "Child approval was not keyboard reachable");
      approval.click();
      check(
        counts().child === 1 && counts().parent === 0,
        "Child approval selected the wrong destination",
      );
      required(
        host.querySelector<HTMLButtonElement>(".thread-select"),
        "Parent destination",
      ).click();
      check(counts().parent === 1 && counts().child === 1, "Normal parent navigation changed");
    },
  );

  await run(
    "queued followups and ordinary thread messages stop individually without duplicating destinations",
    async (root) => {
      for (const kind of ["followup", "message"] as const) {
        const child = makeThread({ count: 2 });
        child.title = "Destination review";
        let tasks: ThreadTask[] = Array.from({ length: 3 }, (_, index) => ({
          id: crypto.randomUUID(),
          childThreadId: child.id,
          sequence: index + 1,
          label: ["Active request", "First queued request", "Second queued request"][index],
          state: index ? "queued" : "running",
          kind: kind === "followup" && !index ? "initial" : kind,
          harness: "codex",
          createdAt: new Date(Date.parse(timestamp) + index).toISOString(),
        }));
        const summaries = new Map([[child.id, summarizeThread(child)]]);
        const requests: {
          project: string;
          taskId: string;
          resolve(): void;
          reject(error: Error): void;
        }[] = [];
        const requestCount = () => requests.length;
        const opened: string[] = [];
        const onOpenThread = (_project: string, id: string) => opened.push(id);
        const onCancel = (project: string, taskId: string) =>
          new Promise<void>((resolve, reject) => {
            requests.push({ project, taskId, resolve, reject });
          });
        const render = () =>
          flushSync(() =>
            root.render(
              <AgentTasks
                key={kind}
                tasks={tasks}
                summaries={summaries}
                projectId={projectId}
                onOpenThread={onOpenThread}
                onCancel={onCancel}
              />,
            ),
          );
        try {
          render();
          await settle();
          check(
            host.querySelectorAll(".agent-task").length === 1 &&
              host.querySelectorAll(".model-provider-icon").length === 1,
            "Queued work duplicated the destination's provider or title row",
          );
          const disclosure = required(
            host.querySelector<HTMLDetailsElement>(".agent-task-queue"),
            "Queued assignment disclosure",
          );
          check(!disclosure.open, "Secondary assignments expanded by default");
          const summary = required(
            disclosure.querySelector<HTMLElement>("summary"),
            "Queue summary",
          );
          summary.focus();
          check(document.activeElement === summary, "Queue disclosure was not keyboard reachable");
          check(
            summary.textContent?.includes("2 queued assignments"),
            "Queue summary did not count both pending assignments",
          );
          summary.click();
          await settle();
          check(
            disclosure.open && host.querySelectorAll(".agent-queued-task").length === 2,
            "Expanding the queue omitted pending assignments",
          );
          const firstStop = required(
            disclosure.querySelector<HTMLButtonElement>('[aria-label="Stop First queued request"]'),
            "First queued stop",
          );
          const secondStop = required(
            disclosure.querySelector<HTMLButtonElement>(
              '[aria-label="Stop Second queued request"]',
            ),
            "Second queued stop",
          );
          const secondRow = required(
            secondStop.closest<HTMLElement>('[role="group"]'),
            "Second queued row",
          );
          check(
            secondRow.textContent?.includes("Second queued request") &&
              secondRow.textContent?.includes("Queued"),
            "Queued row omitted the individual prompt or state",
          );
          secondStop.focus();
          check(
            document.activeElement === secondStop,
            "Queued assignment stop was not keyboard reachable",
          );
          secondStop.click();
          await settle();
          check(
            requestCount() === 1 &&
              requests[0].project === projectId &&
              requests[0].taskId === tasks[2].id,
            "Stopping the second queued request targeted its active or first sibling",
          );
          check(
            secondStop.disabled &&
              secondRow.textContent?.includes("Stopping") &&
              !firstStop.disabled,
            "Queued stop did not isolate optimistic feedback to its own request",
          );
          requests[0].reject(new Error("Synthetic queued cancellation failure"));
          await settle();
          const retry = required(
            secondRow.querySelector<HTMLButtonElement>(
              '[aria-label="Retry stopping Second queued request"]',
            ),
            "Queued cancellation retry",
          );
          check(
            secondRow.querySelector('[role="alert"]')?.textContent?.includes("Could not stop") &&
              !retry.disabled,
            "Queued cancellation failure did not recover",
          );
          retry.click();
          await settle();
          check(
            requestCount() === 2 && requests.every((request) => request.taskId === tasks[2].id),
            "Retry cancelled an active or unrelated queued request",
          );
          tasks = tasks.map((task, index) =>
            index === 2
              ? { ...task, state: "cancel_requested", sequence: task.sequence + 10 }
              : task,
          );
          render();
          await settle();
          check(
            host
              .querySelector<HTMLButtonElement>('.agent-task[data-state="running"]')
              ?.textContent?.includes(child.title),
            "A queued cancellation replaced the actually running destination",
          );
          check(
            disclosure.open && secondRow.textContent?.includes("Stopping"),
            "Queued stop feedback vanished during host confirmation",
          );
          requests[1].resolve();
          tasks = tasks.map((task, index) =>
            index === 2 ? { ...task, state: "cancelled", sequence: task.sequence + 10 } : task,
          );
          render();
          await settle();
          check(
            disclosure.textContent?.includes("1 queued assignment") &&
              disclosure.querySelectorAll(".agent-queued-task").length === 1,
            "Confirmed cancellation removed the wrong queued assignment",
          );
          check(
            !firstStop.disabled && host.querySelectorAll(".agent-task").length === 1,
            "Cancelling a queued request disrupted its active destination or sibling",
          );
          required(
            host.querySelector<HTMLButtonElement>('.agent-task[data-state="running"]'),
            "Active destination",
          ).click();
          check(
            opened.length === 1 && opened[0] === child.id,
            "The single destination no longer opened its transcript",
          );
        } finally {
          for (const request of requests) request.resolve();
        }
      }
    },
  );
  await runDraftNavigationTests(run, { host, nativeAPI });

  return passed;
}

Object.assign(window, { runThreadLoadingTests });
