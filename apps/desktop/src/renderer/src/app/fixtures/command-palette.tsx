import { StrictMode } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import type { ProjectSnapshot } from "../../../../shared/contracts/desktop";
import { CommandPalette } from "../../features/command-palette/command-palette";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function settle() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}
function key(value: string, options: KeyboardEventInit = {}) {
  const target = document.activeElement ?? window;
  flushSync(() =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options }),
    ),
  );
}
function query(value: string) {
  const input = document.querySelector<HTMLInputElement>('[role="combobox"]');
  check(input, "Palette search is missing");
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  check(setter, "Native input setter is missing");
  flushSync(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
export async function runCommandPaletteTests(root: Root) {
  const snapshots: ProjectSnapshot[] = ["Studio", "Website"].map((name, index) => {
    const project = {
      id: crypto.randomUUID(),
      name,
      path: `/projects/${name.toLowerCase()}`,
      openedAt: "2026-11-01T12:00:00.000Z",
    };
    return {
      project,
      designs: [],
      folders: [],
      threads: [
        {
          id: crypto.randomUUID(),
          projectId: project.id,
          revision: 1,
          title: index ? "Improve checkout" : "Update typography",
          harness: "codex",
          designIds: [],
          status: "completed",
          updatedAt: project.openedAt,
        },
      ],
    };
  });
  const calls: string[] = [];
  let reads = 0;
  const api = {
    projectSnapshot: async (id: string) => {
      reads++;
      const snapshot = snapshots.find((entry) => entry.project.id === id);
      check(snapshot, "Unknown project requested");
      return snapshot;
    },
  };
  flushSync(() =>
    root.render(
      <StrictMode>
        <button id="palette-focus">Composer</button>
        <CommandPalette
          api={api}
          projects={snapshots.map((entry) => entry.project)}
          project={snapshots[0].project}
          snapshots={{ [snapshots[0].project.id]: snapshots[0] }}
          onProject={(id, snapshot) => {
            check(snapshot, "Project snapshot was not reused");
            calls.push(`project:${id}`);
          }}
          onThread={(id, threadId) => calls.push(`thread:${id}:${threadId}`)}
          onSettings={(page) => calls.push(`settings:${page}`)}
          onAddProject={() => calls.push("add")}
        />
      </StrictMode>,
    ),
  );
  document.getElementById("palette-focus")?.focus();
  key("k", { code: "KeyK", metaKey: true });
  await settle();
  check(
    document.activeElement?.getAttribute("role") === "combobox",
    "Search did not receive focus",
  );
  check(
    document.querySelector('dialog[aria-label="Command palette"]:modal'),
    "Cmd+K failed to open a modal in StrictMode",
  );
  document.getElementById("palette-focus")?.focus();
  check(document.activeElement?.getAttribute("role") === "combobox", "Background accepted focus");
  let backgroundKeys = 0;
  const backgroundShortcut = () => {
    backgroundKeys++;
  };
  window.addEventListener("keydown", backgroundShortcut);
  try {
    key("b", { code: "KeyB", ctrlKey: true, shiftKey: true });
    check(backgroundKeys === 0, "Palette allowed a background shortcut");
  } finally {
    window.removeEventListener("keydown", backgroundShortcut);
  }
  query("checkout");
  await settle();
  check(
    document.querySelector('[role="option"]')?.textContent?.includes("Improve checkout"),
    "Unvisited project's thread was not found",
  );
  const previousReads = reads;
  query("typography");
  query("checkout");
  await settle();
  check(reads === previousReads, "Typing caused extra project reads");
  key("Enter");
  await settle();
  check(
    calls.at(-1) === `thread:${snapshots[1].project.id}:${snapshots[1].threads[0].id}`,
    "Enter opened the wrong thread",
  );
  key("k", { code: "KeyK", ctrlKey: true });
  await settle();
  check(reads === previousReads, "Reopening discarded the catalog cache");
  query("appearance");
  key("Enter");
  await settle();
  check(calls.at(-1) === "settings:appearance", "Settings search opened the wrong page");
  key("k", { code: "KeyK", ctrlKey: true });
  await settle();
  query("new thread in");
  key("ArrowDown");
  key("Enter");
  await settle();
  check(document.querySelector('[aria-label="Back"]'), "Project submenu did not open");
  query("Website");
  key("Enter");
  await settle();
  check(
    calls.at(-1) === `thread:${snapshots[1].project.id}:null`,
    "New thread used the wrong project",
  );
  key("k", { code: "KeyK", ctrlKey: true });
  await settle();
  query("does-not-exist");
  key("ArrowDown");
  key("Enter");
  check(
    document.querySelector('dialog[aria-label="Command palette"]'),
    "Empty results selected an action",
  );
  query("Website");
  key("Enter");
  await settle();
  check(
    calls.at(-1) === `project:${snapshots[1].project.id}`,
    "Project selection did not use prefetched content",
  );
  document.getElementById("palette-focus")?.focus();
  key("k", { code: "KeyK", metaKey: true });
  await settle();
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="Command palette"]');
  check(dialog, "Palette missing before dismissal");
  flushSync(() => dialog.dispatchEvent(new Event("cancel", { cancelable: true })));
  await settle();
  check(document.activeElement?.id === "palette-focus", "Dismissal lost the previous focus");
  flushSync(() => root.render(null));
}
