import { useState } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { ChatLink } from "../../components/chat-link";
import { FileNavigationContext } from "../../features/repository/file-navigation";
import {
  WorkspaceSurfaces,
  type SurfaceRequest,
} from "../../features/workspace/workspace-surfaces";
import type { RepositoryAPI } from "../../features/repository/use-repository-files";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function until(predicate: () => boolean, label: string) {
  const deadline = performance.now() + 5000;
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function nextPaint() {
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
}
export async function runFileNavigationTests(root: Root) {
  const projectId = crypto.randomUUID();
  let revealInFolder = 0;
  let missingReads = 0;
  let directoryReads = 0;
  const folderError =
    "The folder cache is full. Collapse some folders, then refresh to continue browsing.";
  const manual = "manual.ts";
  let release: ((path: string) => void) | undefined;
  const api: RepositoryAPI = {
    onEvent: () => () => {},
    resolveRepositoryLink: async (_, href) => {
      if (href === "slow.ts:3")
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      if (href === "../outside.ts") throw new Error("This file is outside this project.");
      return href.split(":")[0];
    },
    repositoryDirectory: async () => {
      if (directoryReads++ === 0) throw new Error(folderError);
      return {
        entries: [{ path: "manual.ts", name: "manual.ts", kind: "file" }],
        limited: false,
      };
    },
    repositoryChanges: async () => ({ repository: false, head: null, changes: [] }),
    repositoryFile: async (_, path) =>
      path === "missing.ts" && missingReads++ === 0
        ? { kind: "unavailable", reason: "missing" }
        : {
            kind: "text",
            text: Array.from(
              { length: 400 },
              (_, index) => `export const line${index + 1} = ${index + 1};`,
            ).join("\n"),
            view: "file",
            comparison: "none",
          },
  };
  function Fixture() {
    const [request, setRequest] = useState<SurfaceRequest>();
    const [open, setOpen] = useState(false);
    return (
      <section
        className="project-workspace surfaces-workspace"
        data-panel-open={open}
        style={{ width: "100%", height: 600 }}
      >
        <FileNavigationContext
          value={(href) => {
            const id = crypto.randomUUID();
            setOpen(true);
            setRequest({ id, surface: "files", file: { id, href } });
          }}
        >
          <div data-chat>
            {[
              "src/example.ts:240:8",
              "src/example.ts:12",
              "src/example.ts:900",
              "slow.ts:3",
              "missing.ts:2",
              "../outside.ts",
            ].map((href) => (
              <p key={href}>
                <ChatLink
                  href={href}
                  projectId={projectId}
                  api={{
                    openChatLink: async () => {
                      revealInFolder++;
                    },
                  }}
                >
                  {href}
                </ChatLink>
              </p>
            ))}
          </div>
        </FileNavigationContext>
        <WorkspaceSurfaces
          projectId={projectId}
          repositoryAPI={api}
          active={open}
          open={open}
          request={request}
          onClose={() => setOpen(false)}
        />
      </section>
    );
  }
  flushSync(() => root.render(<Fixture />));
  function click(href: string) {
    const modal = document.querySelector<HTMLDialogElement>("#workspace-side-panel:modal");
    if (modal)
      flushSync(() =>
        modal.querySelector<HTMLButtonElement>('[aria-label="Close side panel"]')?.click(),
      );
    const link = document.querySelector<HTMLAnchorElement>(`a[href="${href}"]`);
    check(link, `Missing file chip ${href}`);
    flushSync(() => link.click());
  }
  function highlighted(line: number) {
    const number = document.querySelector(
      `[data-highlighted=true] [aria-label="New line ${line}"]`,
    );
    if (!number) return false;
    const bounds =
      number
        .closest(".repository-code-row")
        ?.querySelector("[data-file-column]")
        ?.getBoundingClientRect() ?? number.getBoundingClientRect();
    const pane = number.closest(".repository-wrapped-code")?.getBoundingClientRect();
    return pane && bounds.top >= pane.top && bounds.bottom <= pane.bottom;
  }
  click("src/example.ts:240:8");
  await until(() => Boolean(highlighted(240)), "distant line is visible and highlighted");
  check(
    document.querySelector("[data-highlighted=true] mark")?.textContent === "c",
    "Column was not emphasized",
  );
  check(
    document.querySelector('[role="tab"][aria-selected=true]')?.textContent === "Files",
    "Files surface not selected",
  );
  const tab = document.querySelector<HTMLButtonElement>("#workspace-tab-files");
  const content = document.getElementById(tab?.getAttribute("aria-controls") ?? "");
  check(
    content?.contains(document.querySelector(".repository-file-pane:not([hidden])")),
    "Files tab does not identify the visible preview",
  );
  await until(
    () => Boolean(document.body.textContent?.includes(folderError)),
    "folder recovery guidance",
  );
  const folderNotice = [...document.querySelectorAll<HTMLElement>('[role="alert"]')].find((node) =>
    node.textContent?.includes(folderError),
  );
  const retryFolder = folderNotice?.querySelector<HTMLButtonElement>("button");
  check(retryFolder, "Folder notice did not offer Retry");
  flushSync(() => retryFolder.click());
  await until(() => !document.body.textContent?.includes(folderError), "folder retry recovers");
  if (!window.matchMedia("(max-width: 980px)").matches) {
    const code = document.querySelector<HTMLElement>(".repository-wrapped-code");
    check(code, "File preview missing");
    code.scrollTop = 0;
    click("src/example.ts:240:8");
    await until(() => Boolean(highlighted(240)), "repeated click reveals the same line again");
    click("src/example.ts:12");
    await until(() => Boolean(highlighted(12)), "another line in the same file");
    click("src/example.ts:900");
    await until(() => Boolean(highlighted(400)), "outdated line is bounded to end of file");
    check(
      document.body.textContent?.includes("Line 900 is unavailable. Showing line 400."),
      "Missing stale-line explanation",
    );
  }
  click("slow.ts:3");
  await until(() => Boolean(release), "delayed host path resolution");
  click("src/example.ts:12");
  await until(() => Boolean(highlighted(12)), "newer navigation completes");
  release?.("slow.ts");
  await nextPaint();
  check(highlighted(12), "Late host response replaced the newer target");
  click("slow.ts:3");
  await until(
    () => document.body.textContent?.includes("Opening file…") === true,
    "manual selection can interrupt a host request",
  );
  const panel = document.querySelector<HTMLElement>("#workspace-side-panel");
  if (panel && panel.clientWidth <= 420)
    flushSync(() =>
      panel.querySelector<HTMLButtonElement>('[aria-label="Close file preview"]')?.click(),
    );
  const entry = document.querySelector<HTMLButtonElement>(
    `[role="treeitem"][aria-label="${manual}"]`,
  );
  check(entry, "Manual file entry missing");
  flushSync(() => entry.click());
  release?.("slow.ts");
  await nextPaint();
  await until(
    () => document.querySelector(".repository-file-name")?.textContent === manual,
    "manual selection survives a late host response",
  );
  click("../outside.ts");
  await until(
    () => Boolean(document.body.textContent?.includes("outside this project")),
    "outside project error",
  );
  const outsideNotice = [...document.querySelectorAll<HTMLElement>('[role="alert"]')].find((node) =>
    node.textContent?.includes("outside this project"),
  );
  check(
    outsideNotice && !outsideNotice.querySelector("button"),
    "Outside-project restriction offered an ineffective Retry",
  );
  click("missing.ts:2");
  await until(
    () => Boolean(document.body.textContent?.includes("This file isn't available in this folder.")),
    "missing file state",
  );
  const missingNotice = [...document.querySelectorAll<HTMLElement>('[role="status"]')].find(
    (node) => node.textContent?.includes("This file isn't available"),
  );
  check(missingNotice?.querySelector("button"), "Missing file did not offer Retry");
  click("missing.ts:2");
  await until(
    () => Boolean(highlighted(2)),
    "another click retries a missing file that has returned",
  );
  check(revealInFolder === 0, "File references reached the operating system");
}
