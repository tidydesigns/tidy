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
import { RemoteMachines } from "../../features/settings/remote-machines";
import { Settings } from "../../features/settings/settings";
import type { MachineBridge } from "../../../../shared/remote";
import { UserFacingError } from "@tidy/ui/errors";
import { DesignReferencePicker } from "../../features/composer/design-reference-picker";
import {
  cloudReferenceKey,
  type DraftCloudReference,
} from "../../features/composer/cloud-reference";
import type { CloudReferenceLibrary } from "../../features/composer/cloud-reference-catalogs";
import { ProjectSwitcher } from "../../features/workspace/project-switcher";
import { ProjectSetupDialog } from "../../features/composer/project-setup-dialog";
import type { ProjectSetupResult } from "../../../../shared/contracts/workspace-response";
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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

  await run("harness failures deduplicate, queue and clear on retry", runHarnessFailureNoticeTests);

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
      check(close.disabled, "Import can be dismissed before its result is known");
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
      await settle();
      const added = required(buttons().at(-1), "Added turn");
      check(buttons().length === 5, "Added turn did not get a navigation target");
      check(
        added.getAttribute("aria-label")?.includes("A newly added turn"),
        "Added turn label is stale",
      );
      check(added.style.top === "100%", "Added turn did not update navigation positions");
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
      const viewport = visibleTranscript();
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
            Number.parseFloat(getComputedStyle(viewport).paddingTop),
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
      let machineId = "local";
      let cloudChoice = "";
      let remoteConnected = true;
      const renderPicker = (disabled = false) =>
        flushSync(() =>
          root.render(
            <ProjectSwitcher
              machines={[
                { id: "local", label: "Local device", status: null },
                {
                  id: remoteId,
                  label: "Mac",
                  status: remoteConnected ? { kind: "connected", target: "mac" } : null,
                },
              ]}
              machineId={machineId}
              projects={
                machineId === "local"
                  ? [{ ...local, id: crypto.randomUUID() }, local]
                  : [remoteProject]
              }
              projectId={machineId === "local" ? local.id : remoteProject.id}
              disabled={disabled}
              loadProjects={async (id) => {
                loads++;
                return [id === "local" ? local : remoteProject];
              }}
              onChoose={async (machine, project) => {
                choices.push({ machine, project });
                machineId = machine;
                renderPicker();
              }}
              onCancelNavigation={() => {
                cancelled++;
              }}
              onAddMachine={() => {
                added++;
              }}
              cloudWorkspaces={[{ id: "studio", name: "Studio" }]}
              onCloudChange={(id) => {
                cloudChoice = id;
              }}
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
      const dialog = required(
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
      const search = required(dialog.querySelector<HTMLInputElement>("input"), "Project search");
      check(document.activeElement === search, "Search was not focused on open");
      check(
        dialog.querySelectorAll(".machine-project-row[aria-current=page]").length === 1 &&
          dialog.querySelectorAll(".machine-project-row").length === 3,
        "The same project folder appeared twice or lost its active selection",
      );
      const setQuery = (value: string) => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
          search,
          value,
        );
        search.dispatchEvent(new Event("input", { bubbles: true }));
      };
      setQuery("Nothing matches this project");
      await settle();
      check(dialog.textContent?.includes("No matching projects"), "Empty search has no feedback");
      setQuery("Mac");
      await settle();
      check(
        dialog.querySelectorAll(".machine-project-row").length === 1,
        "Machine search did not narrow projects",
      );
      check(choices.length === 0, "Searching changed workspaces");
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      const project = required(
        dialog.querySelector<HTMLButtonElement>(".machine-project-row"),
        "Remote project",
      );
      check(document.activeElement === project, "Arrow navigation skipped the search result");
      project.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }),
      );
      check(document.activeElement === search, "Arrow navigation did not return to search");
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
      remoteConnected = false;
      renderPicker();
      trigger.click();
      await settle();
      const cloudDialog = required(
        host.querySelector<HTMLElement>("[popover]"),
        "Remote project switcher",
      );
      check(
        required(
          cloudDialog.querySelector<HTMLButtonElement>("[aria-label='tidy, Mac']"),
          "Offline project",
        ).disabled,
        "Offline project remains selectable",
      );
      check(
        cloudDialog.textContent?.includes("Mac · Offline"),
        "Offline machine has no visible status",
      );
      required(
        cloudDialog.querySelector<HTMLButtonElement>("[aria-label='Studio cloud workspace']"),
        "Cloud workspace after selecting a remote project",
      ).click();
      await until(() => !cloudDialog.matches(":popover-open"), "Cloud selection closes dropdown");
      check(cloudChoice === "studio", "Cloud workspace is unavailable from a remote project");
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
    const search = required(dialog.querySelector<HTMLInputElement>("input"), "Project search");
    const remove = required(
      dialog.querySelector<HTMLButtonElement>("[aria-label='Remove Project from Mac']"),
      "Remove action",
    );
    remove.focus();
    remove.click();
    await settle();
    check(document.activeElement === search, "Removal lost focus outside the dropdown");
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
    search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    check(
      document.activeElement === dialog.querySelector(".machine-project-row"),
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
    check(document.activeElement === search, "Successful removal lost keyboard focus");
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    await until(() => !dialog.matches(":popover-open"), "Escape closes after project removal");
  });

  await run(
    "cloud reference picker mixes sources, keeps selection instant, and retains failures for retry",
    async (root) => {
      let selected: string[] = [];
      let references: DraftCloudReference[] = [];
      let retried = 0;
      let connected = true;
      const cloudFile = { id: crypto.randomUUID(), name: "Shared button", folderId: "components" };
      const otherFile = { ...cloudFile, id: crypto.randomUUID() };
      const library: CloudReferenceLibrary = {
        accountId: "account",
        retry: () => {},
        refresh: () => {},
        workspaces: [
          {
            id: "org",
            name: "Design team",
            canEdit: true,
            catalog: {
              kind: "ready",
              catalog: { files: [cloudFile], folders: [{ id: "components", name: "Components" }] },
            },
          },
          {
            id: "other",
            name: "Other team",
            canEdit: false,
            catalog: { kind: "ready", catalog: { files: [otherFile], folders: [] } },
          },
        ],
      };
      function render() {
        flushSync(() =>
          root.render(
            <DesignReferencePicker
              designs={[{ id: "local", name: "Project design" }]}
              selected={selected}
              onChange={(ids) => {
                selected = ids;
                render();
              }}
              disabled={false}
              cloud={{
                library,
                selected: references,
                canImport: connected,
                onRetry: () => {
                  retried++;
                },
                onToggle: (reference) => {
                  const key = cloudReferenceKey(reference);
                  references = references.some((item) => cloudReferenceKey(item) === key)
                    ? references.filter((item) => cloudReferenceKey(item) !== key)
                    : [
                        ...references,
                        { ...reference, token: crypto.randomUUID(), kind: "pending" },
                      ];
                  render();
                },
              }}
            />,
          ),
        );
      }
      render();
      const trigger = required(
        host.querySelector<HTMLButtonElement>("[aria-label='Design references']"),
        "Reference trigger",
      );
      trigger.click();
      await settle();
      const popup = required(host.querySelector<HTMLElement>("[popover]"), "References popup");
      check(popup.matches(":popover-open"), "References did not open");
      const search = required(popup.querySelector<HTMLInputElement>("input"), "Design search");
      check(document.activeElement === search, "Search was not focused on open");
      required(
        popup.querySelector<HTMLButtonElement>("[aria-label='Shared button']"),
        "Cloud reference",
      ).click();
      check(
        references.length === 1 && references[0].kind === "pending",
        "Selection waited for the download",
      );
      check(popup.matches(":popover-open"), "Multi-select dismissed the menu");
      check(trigger.textContent?.includes("· 1"), "Pending reference count did not update");
      const local = required(
        popup.querySelector<HTMLButtonElement>("[aria-label='Project design']"),
        "Project reference",
      );
      local.click();
      check(trigger.textContent?.includes("· 2"), "Project and cloud counts are separate");
      references = [{ ...references[0], kind: "error", message: "Offline" }];
      render();
      required(
        popup.querySelector<HTMLButtonElement>("[aria-label='Retry Shared button']"),
        "Retry reference",
      ).click();
      check(retried === 1, "Failed reference has no working retry");
      connected = false;
      render();
      check(
        required(
          popup.querySelector<HTMLButtonElement>("[aria-label='Retry Shared button']"),
          "Offline retry",
        ).disabled,
        "Offline transfer can still start",
      );
      required(
        popup.querySelector<HTMLButtonElement>("[aria-label='Remove Shared button']"),
        "Remove failed reference",
      ).click();
      check(
        references.length === 0 && trigger.textContent?.includes("· 1"),
        "Removing failure changed project references",
      );
      const currentLocal = required(
        popup.querySelector<HTMLButtonElement>("[role=menuitemcheckbox]"),
        "Selected local reference",
      );
      search.focus();
      search.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
      );
      check(
        document.activeElement === currentLocal,
        "Arrow navigation did not enter project designs",
      );
      currentLocal.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
      await settle();
      check(
        !popup.matches(":popover-open") && document.activeElement === trigger,
        "Escape failed to restore focus",
      );
    },
  );

  await run(
    "cloud reference picker searches across workspaces and bounds large lists",
    async (root) => {
      const files = Array.from({ length: 250 }, (_, index) => ({
        id: crypto.randomUUID(),
        name: index === 249 ? "Unique checkout screen" : `Design ${index}`,
        folderId: null,
      }));
      let retried = "";
      const library: CloudReferenceLibrary = {
        accountId: "account",
        retry: (id) => {
          retried = id;
        },
        refresh: () => {},
        workspaces: [
          {
            id: "org",
            name: "Cloud team",
            canEdit: true,
            catalog: { kind: "ready", catalog: { files, folders: [] } },
          },
        ],
      };
      const render = () =>
        flushSync(() =>
          root.render(
            <div style={{ paddingTop: 500 }}>
              <DesignReferencePicker
                designs={[]}
                selected={[]}
                onChange={() => {}}
                disabled={false}
                cloud={{
                  library,
                  selected: [],
                  canImport: true,
                  onToggle: () => {},
                  onRetry: () => {},
                }}
              />
            </div>,
          ),
        );
      render();
      required(
        host.querySelector<HTMLButtonElement>("[aria-label='Design references']"),
        "Trigger",
      ).click();
      await settle();
      const popup = required(host.querySelector<HTMLElement>("[popover]"), "Popup");
      const input = required(popup.querySelector<HTMLInputElement>("input"), "Search");
      const setQuery = (text: string) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, text);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      setQuery("Unique checkout");
      await settle();
      check(
        popup.querySelectorAll("[role=menuitemcheckbox]").length === 1,
        "Search failed to find a design deep in the cloud catalog",
      );
      library.workspaces.push({
        id: "loading",
        name: "Another workspace",
        canEdit: false,
        catalog: { kind: "loading" },
      });
      render();
      setQuery("nothing matches");
      await settle();
      check(popup.textContent?.includes("Loading designs"), "Search hides pending workspaces");
      library.workspaces[1].catalog = {
        kind: "error",
        message: "Could not load another workspace",
      };
      render();
      await settle();
      check(
        popup.textContent?.includes("Could not load cloud designs"),
        "Search reports no matches when a workspace failed to load",
      );
      required(
        popup.querySelector<HTMLButtonElement>(".reference-empty button"),
        "Retry unavailable search source",
      ).click();
      check(retried === "loading", "Search retried the wrong workspace");
      library.workspaces[1].catalog = { kind: "ready", catalog: { files: [], folders: [] } };
      render();
      await settle();
      check(
        popup.textContent?.includes("No matching designs"),
        "No-match search lacks useful feedback",
      );
      setQuery("Cloud team");
      await settle();
      check(
        popup.querySelectorAll("[role=menuitemcheckbox]").length === 250,
        "Workspace name search did not expose its designs",
      );
      const list = required(
        popup.querySelector<HTMLElement>(".select-menu-options"),
        "Cloud designs",
      );
      check(
        list.clientHeight <= 250 && list.scrollHeight > list.clientHeight,
        "Cloud list grows beyond its bounded region",
      );
      check(
        popup.getBoundingClientRect().height <= 402,
        "Reference menu exceeds its maximum height",
      );
    },
  );

  await run(
    "empty, unavailable, and maximum-count reference pickers remain understandable and removable",
    async (root) => {
      let cloudSelected: DraftCloudReference[] = Array.from({ length: 20 }, (_, index) => ({
        accountId: "account",
        organizationId: "org",
        fileId: crypto.randomUUID(),
        name: `Selected ${index}`,
        token: crypto.randomUUID(),
        kind: "error",
        message: "Offline",
      }));
      const library: CloudReferenceLibrary = {
        accountId: "account",
        retry: () => {},
        refresh: () => {},
        workspaces: [
          {
            id: "org",
            name: "Workspace",
            canEdit: true,
            catalog: { kind: "error", message: "Could not load designs" },
          },
        ],
      };
      function render() {
        flushSync(() =>
          root.render(
            <DesignReferencePicker
              designs={[{ id: "local", name: "Local design" }]}
              selected={[]}
              onChange={() => {}}
              disabled={false}
              cloud={{
                library,
                selected: cloudSelected,
                canImport: true,
                onRetry: () => {},
                onToggle: (reference) => {
                  cloudSelected = cloudSelected.filter(
                    (item) => cloudReferenceKey(item) !== cloudReferenceKey(reference),
                  );
                  render();
                },
              }}
            />,
          ),
        );
      }
      render();
      required(
        host.querySelector<HTMLButtonElement>("[aria-label='Design references']"),
        "Trigger",
      ).click();
      await settle();
      const popup = required(host.querySelector<HTMLElement>("[popover]"), "Popup");
      check(
        required(
          popup.querySelector<HTMLButtonElement>(".select-menu-options [role=menuitemcheckbox]"),
          "Local row",
        ).disabled,
        "Local designs can exceed total reference limit",
      );
      check(popup.textContent?.includes("20 reference limit"), "Limit is unexplained");
      required(
        popup.querySelector<HTMLButtonElement>("[aria-label='Remove Selected 0']"),
        "Remove at limit",
      ).click();
      check(
        !required(
          popup.querySelector<HTMLButtonElement>(".select-menu-options [role=menuitemcheckbox]"),
          "Local row",
        ).disabled,
        "Removing a reference did not free capacity",
      );
      flushSync(() =>
        root.render(
          <DesignReferencePicker designs={[]} selected={[]} onChange={() => {}} disabled={false} />,
        ),
      );
      await settle();
      check(
        required(
          host.querySelector<HTMLButtonElement>("[aria-label='Design references']"),
          "Empty reference trigger",
        ).disabled,
        "An empty reference picker still opens an instructional panel",
      );
      check(!popup.matches(":popover-open"), "Empty reference panel remained open");
    },
  );

  return passed;
}

Object.assign(window, { runThreadLoadingTests });

async function runReferenceViewportTests(): Promise<string[]> {
  const original = [
    document.documentElement.style.cssText,
    document.body.style.cssText,
    host.style.cssText,
  ];
  document.documentElement.style.cssText = "width:100%;height:100%";
  document.body.style.cssText = "width:100%;height:100%;margin:0";
  host.style.cssText = "width:100%;height:100%;display:block";
  const root = createRoot(host);
  try {
    const library: CloudReferenceLibrary = {
      accountId: "account",
      retry: () => {},
      refresh: () => {},
      workspaces: [
        {
          id: "org",
          name: "Shared cloud designs",
          canEdit: true,
          catalog: {
            kind: "ready",
            catalog: {
              files: Array.from({ length: 250 }, (_, index) => ({
                id: crypto.randomUUID(),
                name: `Design ${index}`,
                folderId: null,
              })),
              folders: [],
            },
          },
        },
      ],
    };
    flushSync(() =>
      root.render(
        <div style={{ paddingTop: 180, paddingLeft: 160 }}>
          <DesignReferencePicker
            designs={[]}
            selected={[]}
            disabled={false}
            onChange={() => {}}
            cloud={{
              library,
              selected: [],
              canImport: true,
              onRetry: () => {},
              onToggle: () => {},
            }}
          />
        </div>,
      ),
    );
    const trigger = required(
      host.querySelector<HTMLButtonElement>("[aria-label='Design references']"),
      "Reference trigger",
    );
    trigger.click();
    await settle();
    const popup = required(host.querySelector<HTMLElement>("[popover]"), "Reference menu");
    const box = popup.getBoundingClientRect();
    check(
      box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight,
      "Reference picker escapes a narrow viewport",
    );
    const list = required(popup.querySelector<HTMLElement>(".select-menu-options"), "Design list");
    check(list.scrollHeight > list.clientHeight, "Large reference list is not scrollable");
    const search = required(popup.querySelector<HTMLInputElement>("input"), "Search");
    search.focus();
    search.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
    check(
      document.activeElement?.getAttribute("role") === "menuitemcheckbox",
      "Keyboard cannot reach files on a small viewport",
    );
    let cloudChoice = "";
    flushSync(() =>
      root.render(
        <div style={{ paddingTop: 120, paddingLeft: 300 }}>
          <ProjectSwitcher
            projects={[]}
            disabled={false}
            onChoose={async () => {}}
            cloudWorkspaces={Array.from({ length: 12 }, (_, index) => ({
              id: `${index}`,
              name: `Workspace ${index}`,
            }))}
            onCloudChange={(id) => {
              cloudChoice = id;
            }}
          />
        </div>,
      ),
    );
    required(
      host.querySelector<HTMLButtonElement>("[aria-label='Switch project']"),
      "Project trigger",
    ).click();
    await settle();
    const projectPopup = required(host.querySelector<HTMLElement>("[popover]"), "Project popup");
    const projectBox = projectPopup.getBoundingClientRect();
    check(
      projectBox.left >= 0 &&
        projectBox.right <= innerWidth &&
        projectBox.top >= 0 &&
        projectBox.bottom <= innerHeight,
      "Project picker escapes a narrow viewport",
    );
    const projects = required(
      projectPopup.querySelector<HTMLElement>(".machine-project-list"),
      "Project list",
    );
    check(projects.scrollHeight > projects.clientHeight, "Project list is not scrollable");
    const projectSearch = required(
      projectPopup.querySelector<HTMLInputElement>("input"),
      "Project search",
    );
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(
      projectSearch,
      "Workspace 11",
    );
    projectSearch.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    check(
      projectPopup.querySelectorAll(".machine-project-row").length === 1,
      "Search did not narrow cloud workspaces",
    );
    projectSearch.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await settle();
    check(
      cloudChoice === "11" && !projectPopup.matches(":popover-open"),
      "Enter did not choose the matching cloud workspace",
    );
    return ["both pickers fit a narrow window and retain search, scrolling and keyboard access"];
  } finally {
    flushSync(() => root.unmount());
    document.documentElement.style.cssText = original[0];
    document.body.style.cssText = original[1];
    host.style.cssText = original[2];
  }
}
Object.assign(window, { runReferenceViewportTests });
