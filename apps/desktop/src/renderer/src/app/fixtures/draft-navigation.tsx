import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import type { Bootstrap, DesktopAPI, Thread } from "../../../../shared/contracts/desktop";
import { summarizeThread } from "../../../../shared/models/thread-updates";
import type { Draft } from "../../features/composer/machine-context";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function required<T>(value: T | null | undefined, label: string): T {
  check(value !== null && value !== undefined, `${label} is missing`);
  return value;
}

async function until(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 3000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

export async function runDraftNavigationTests(
  run: (name: string, test: (root: Root) => Promise<void>) => Promise<void>,
  { host, nativeAPI }: { host: HTMLElement; nativeAPI: DesktopAPI },
) {
  for (const destination of [
    "stay",
    "thread",
    "settings",
    "new",
    "reply",
    "started",
    "status-retry",
    "existing-send",
  ] as const) {
    const name =
      destination === "started" || destination === "status-retry" || destination === "existing-send"
        ? `new thread status waits for startup: ${destination}`
        : `failed draft submission recovers after ${destination} navigation`;
    await run(name, async (root) => {
      const { App } = await import("../app");
      const timestamp = "2026-10-20T12:00:00.000Z";
      const project = {
        id: crypto.randomUUID(),
        path: "/synthetic/draft-navigation",
        name: "Draft navigation",
        openedAt: timestamp,
      };
      const previous: Thread = {
        id: crypto.randomUUID(),
        projectId: project.id,
        title: "Previous conversation",
        harness: "codex",
        status: "completed",
        designIds: [],
        revision: 1,
        updatedAt: timestamp,
        messages: [],
      };
      const snapshot = {
        project,
        threads: [summarizeThread(previous)],
        designs: [],
        folders: [],
      };
      const harnesses: Bootstrap["harnesses"] = [{ id: "codex", name: "Codex", status: "ready" }];
      const bootstrap: Bootstrap = { projects: [project], activeProject: snapshot, harnesses };
      let rejectStart: (reason: Error) => void = () => {};
      let resolveStart: (thread: Thread) => void = () => {};
      let resolveSend: (thread: Thread) => void = () => {};
      let sent = false;
      const pendingSend = new Promise<Thread>((resolve) => {
        resolveSend = resolve;
      });
      let starting: Thread | undefined;
      let persisted = false;
      let statusUnavailable = true;
      const statusReads: string[] = [];
      let submitted = false;
      const pendingStart = new Promise<Thread>((resolve, reject) => {
        resolveStart = resolve;
        rejectStart = reject;
      });
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
        readThread: async () => previous,
        readThreadTasks: async ({ threadId }) => {
          statusReads.push(threadId);
          if (threadId === starting?.id) {
            check(persisted, "Status read raced thread creation");
            if (statusUnavailable) throw new Error("Fixture status unavailable");
          }
          return { parent: null, tasks: [], nextCursor: null };
        },
        startThread(input) {
          submitted = true;
          starting = {
            ...previous,
            id: required(input.threadId, "New thread ID"),
            title: "Recover this prompt",
            status: destination === "existing-send" ? "completed" : "running",
            messages: [{ id: crypto.randomUUID(), role: "user", text: input.prompt }],
          };
          return pendingStart;
        },
        sendMessage() {
          sent = true;
          return pendingSend;
        },
      };
      const machine = { id: "local" as const, label: "Fixture", status: null };
      const drafts = new Map<string, Record<string, Draft>>();
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
              draft: { text: "Recover this prompt", harness: "codex", designIds: [] },
            }}
            draftCache={drafts}
          />,
        ),
      );
      const editor = () => required(host.querySelector<HTMLElement>("#thread-prompt"), "Editor");
      const draftButton = () =>
        host.querySelector<HTMLButtonElement>(".sidebar-list > .thread-select");
      const previousButton = () =>
        required(
          host.querySelector<HTMLButtonElement>(`[data-thread-id="${previous.id}"] button`),
          "Previous conversation",
        );
      const submit = () =>
        required(host.querySelector<HTMLButtonElement>(".composer-submit"), "Submit");
      await until(() => !submit().disabled, "Submission ready");
      flushSync(() => submit().click());
      await until(() => submitted, "Deferred submission");
      await until(() => Boolean(host.querySelector(".transcript")), "Optimistic conversation");
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      check(
        !statusReads.includes(required(starting, "Starting thread").id),
        "Task status was requested before startup settled",
      );
      check(!host.querySelector(".agent-task-recovery"), "Startup showed a status error");
      check(!draftButton(), "Submitting left a draft row");
      if (
        destination === "started" ||
        destination === "status-retry" ||
        destination === "existing-send"
      ) {
        persisted = true;
        statusUnavailable = destination === "status-retry";
        resolveStart(required(starting, "Starting thread"));
        await until(() => statusReads.includes(starting!.id), "Automatic status after startup");
        if (destination === "existing-send") {
          const initialReads = statusReads.length;
          try {
            flushSync(() => {
              editor().textContent = "Continue the existing thread";
              editor().dispatchEvent(new InputEvent("input", { bubbles: true }));
            });
            await until(() => !submit().disabled, "Existing thread submission ready");
            flushSync(() => submit().click());
            await until(() => sent, "Existing thread send pending");
            window.dispatchEvent(new Event("focus"));
            await until(
              () => statusReads.length > initialReads,
              "Existing thread status refreshes before send completes",
            );
            check(!host.querySelector(".agent-task-recovery"), "Existing send showed an error");
          } finally {
            resolveSend({ ...required(starting, "Existing thread"), revision: 3 });
          }
          return;
        }
        if (destination === "started") {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          check(!host.querySelector(".agent-task-recovery"), "Successful startup showed an error");
          check(
            statusReads.filter((id) => id === starting?.id).length === 1,
            "Successful startup issued duplicate status requests",
          );
          return;
        }
        await until(
          () => Boolean(host.querySelector(".agent-task-recovery")),
          "Genuine status failure remains recoverable",
        );
        statusUnavailable = false;
        required(
          host.querySelector<HTMLButtonElement>(".agent-task-recovery button"),
          "Status retry",
        ).click();
        await until(() => !host.querySelector(".agent-task-recovery"), "Status retry clears error");
        check(
          statusReads.filter((id) => id === starting?.id).length === 2,
          "Startup or retry issued duplicate status requests",
        );
        return;
      }
      if (destination === "reply") {
        flushSync(() => {
          editor().textContent = "Include the latest details";
          editor().dispatchEvent(new InputEvent("input", { bubbles: true }));
        });
      }
      if (destination === "thread" || destination === "reply") {
        flushSync(() => previousButton().click());
        await until(
          () => previousButton().getAttribute("aria-current") === "true",
          "Thread selection",
        );
      } else if (destination === "settings") {
        flushSync(() =>
          required(
            host.querySelector<HTMLButtonElement>('[aria-label="Settings"]'),
            "Settings",
          ).click(),
        );
      } else if (destination === "new") {
        flushSync(() =>
          required(
            host.querySelector<HTMLButtonElement>('[aria-label="New thread"]'),
            "New thread",
          ).click(),
        );
        flushSync(() => {
          editor().textContent = "Continue with another idea";
          editor().dispatchEvent(new InputEvent("input", { bubbles: true }));
        });
      }
      rejectStart(new Error("Fixture start failed"));
      const expected =
        destination === "new"
          ? "Recover this prompt\n\nContinue with another idea"
          : destination === "reply"
            ? "Recover this prompt\n\nInclude the latest details"
            : "Recover this prompt";
      await until(
        () => drafts.get("local")?.[`${project.id}:new`]?.text === expected,
        "Recovered unsent text",
      );
      check(
        !statusReads.includes(required(starting, "Starting thread").id),
        "Failed or abandoned startup issued a status request",
      );
      check(!host.querySelector(".agent-task-recovery"), "Failed startup showed a status error");
      if (destination === "thread" || destination === "settings" || destination === "reply") {
        check(
          draftButton()?.textContent?.includes("Recover this prompt"),
          "Recovery hid the abandoned draft",
        );
        if (destination === "reply")
          check(
            drafts.get("local")?.[`${project.id}:new`]?.sidebarText === expected,
            "Published recovery omitted the pending follow-up",
          );
        if (destination !== "settings")
          check(
            previousButton().getAttribute("aria-current") === "true",
            "Failure stole thread selection",
          );
        else
          flushSync(() =>
            required(host.querySelector<HTMLButtonElement>(".settings-back"), "Back").click(),
          );
        flushSync(() => required(draftButton(), "Recovered draft").click());
        check(editor().textContent === expected, "Recovered draft did not restore composer text");
      } else {
        check(!draftButton(), "Active failure published a draft before navigation");
        check(editor().textContent === expected, "Failure lost current composer text");
        flushSync(() => previousButton().click());
        check(
          draftButton()?.textContent?.includes("Recover this prompt"),
          "Leaving recovery did not publish its draft",
        );
      }
    });
  }
}
