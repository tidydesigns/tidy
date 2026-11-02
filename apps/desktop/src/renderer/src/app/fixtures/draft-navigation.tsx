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
  for (const destination of ["stay", "thread", "settings", "new", "reply"] as const) {
    await run(`failed draft submission recovers after ${destination} navigation`, async (root) => {
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
      let submitted = false;
      const pendingStart = new Promise<Thread>((_, reject) => {
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
        startThread() {
          submitted = true;
          return pendingStart;
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
      check(!draftButton(), "Submitting left a draft row");
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
