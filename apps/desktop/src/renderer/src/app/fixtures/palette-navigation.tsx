import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import type { Bootstrap, DesktopAPI, Thread } from "../../../../shared/contracts/desktop";
import { summarizeThread } from "../../../../shared/models/thread-updates";
import type { TerminalShortcut } from "../../../../shared/contracts/terminal";

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

export async function runPaletteNavigationTests(root: Root, nativeAPI: DesktopAPI) {
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
  const other = { ...project, id: crypto.randomUUID(), name: "Other project" };
  let second: Thread = {
    ...previous,
    id: crypto.randomUUID(),
    projectId: other.id,
    title: "Other discovered thread",
  };
  const empty = { ...snapshot, threads: [] };
  const otherEmpty = { ...empty, project: other };
  const uncached = { ...project, id: crypto.randomUUID(), name: "Uncached project" };
  const bootstrap: Bootstrap = {
    projects: [project, other, uncached],
    activeProject: empty,
    harnesses,
  };
  const snapshots = [empty, otherEmpty, { ...empty, project: uncached }];
  let discovered = false;
  const shortcuts: { dispatch?: (action: TerminalShortcut) => void } = {};

  const api: DesktopAPI = {
    ...nativeAPI,
    cloud: undefined,
    browser: undefined,
    bootstrap: async () => bootstrap,
    checkHarnesses: async () => harnesses,
    selectProject: async (id) => {
      if (id === uncached.id) await new Promise((resolve) => setTimeout(resolve, 100));
      return required(
        snapshots.find((item) => item.project.id === id),
        "Snapshot",
      );
    },
    projectSnapshot: async (id) => {
      if (id === uncached.id) throw new Error("Snapshot unavailable");
      const current = required(
        snapshots.find((item) => item.project.id === id),
        "Snapshot",
      );
      return discovered
        ? { ...current, threads: [summarizeThread(id === project.id ? previous : second)] }
        : current;
    },
    terminal: nativeAPI.terminal
      ? {
          ...nativeAPI.terminal,
          focus() {},
          onShortcut(listener) {
            shortcuts.dispatch = listener;
            return () => {};
          },
        }
      : undefined,
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
    readThread: async (_projectId, id) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return id === previous.id ? previous : second;
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
          draft: { text: "", harness: "codex", designIds: [] },
        }}
      />,
    ),
  );

  const palette = () => document.querySelector('dialog[aria-label="Command palette"]');
  const open = async () => {
    flushSync(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { code: "KeyK", key: "k", ctrlKey: true, bubbles: true }),
      ),
    );
    await until(() => Boolean(palette()), "Palette opens");
  };
  const choose = async (title: string) => {
    await until(
      () =>
        [...document.querySelectorAll<HTMLElement>('[role="option"]')].some((item) =>
          item.textContent?.includes(title),
        ),
      title,
    );
    const option = required(
      [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) =>
        item.textContent?.includes(title),
      ),
      title,
    );
    flushSync(() => option.click());
    if (title !== "New thread in…") await until(() => !palette(), "Palette closes");
  };
  await until(() => Boolean(document.querySelector("#thread-prompt")), "App ready");
  await open();
  flushSync(() => {
    const dispatch = required(shortcuts.dispatch, "Native shortcut listener");
    dispatch("toggle");
    dispatch("new");
  });
  check(
    document.querySelector<HTMLElement>(".terminal-dock")?.hidden,
    "Native shortcut opened terminal behind modal",
  );
  check(
    !document.querySelector(".terminal-tab"),
    "Native shortcut created a terminal behind modal",
  );
  await choose("Other project");
  await open();
  await choose("Draft navigation");
  discovered = true;
  // Expire the palette cache without delaying the test.
  const now = Date.now;
  Date.now = () => now() + 31_000;
  try {
    await open();
    await choose(second.title);
    await until(
      () =>
        [...document.querySelectorAll("h1")].some(
          (heading) => heading.textContent === second.title,
        ),
      "Cached destination retains discovered thread",
    );
    second = { ...second, id: crypto.randomUUID(), title: "Current project discovered thread" };
    Date.now = () => now() + 62_000;
    await open();
    await choose(second.title);
    await until(
      () =>
        [...document.querySelectorAll("h1")].some(
          (heading) => heading.textContent === second.title,
        ),
      "Current project retains discovered thread",
    );
  } finally {
    Date.now = now;
  }
  await open();
  await choose("New thread in…");
  await choose("Uncached project");
  await until(
    () => document.querySelector(".project-picker")?.textContent?.includes(uncached.name) === true,
    "Uncached project opens",
  );
  await until(
    () => document.activeElement?.id === "thread-prompt",
    "Uncached project composer receives focus",
  );
}
