import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { FileContent } from "../../features/repository/repository-file-preview";
import type { FileLineTarget } from "../../features/repository/file-navigation";
import type { RepositoryFile } from "../../../../shared/contracts/repository-files";

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
export async function runFileLocationTests(root: Root) {
  const positions = new Map<string, number>();
  const path = "long-lines.ts";
  const file: RepositoryFile = {
    kind: "text",
    view: "file",
    comparison: "none",
    text: `${"x".repeat(1100)}👩🏽‍💻e\u0301\nshort\nlast\n${"z".repeat(5000)}`,
  };
  const render = (target: FileLineTarget, content = file) =>
    flushSync(() =>
      root.render(
        <section className="flex h-[420px] w-[300px] flex-col overflow-hidden">
          <input aria-label="Continue chatting" />
          <FileContent
            file={content}
            path={path}
            active
            visible
            positions={positions}
            target={target}
          />
        </section>,
      ),
    );
  const location = (line: number, column?: number, endLine?: number): FileLineTarget => ({
    id: crypto.randomUUID(),
    path,
    line,
    column,
    endLine,
  });
  const target = location(1, 1102);
  render(target);
  const input = document.querySelector<HTMLInputElement>('[aria-label="Continue chatting"]');
  check(input, "Chat input missing");
  input.focus();
  const visibleCharacter = () => {
    const mark = document.querySelector<HTMLElement>("[data-file-column]");
    const pane = mark?.closest(".repository-wrapped-code, .repository-code-pane");
    if (!mark || !pane) return false;
    const character = mark.getBoundingClientRect();
    const area = pane.getBoundingClientRect();
    return (
      character.top >= area.top &&
      character.bottom <= area.bottom &&
      character.left >= area.left &&
      character.right <= area.right
    );
  };
  await until(visibleCharacter, "wrapped column is visible");
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  check(visibleCharacter(), "Wrapped column moved out of view after measuring its row");
  check(document.activeElement === input, "Preparing a preview stole chat focus");
  check(document.querySelector("[data-file-column]")?.textContent === "👩🏽‍💻", "Emoji was split");
  flushSync(() => document.querySelector<HTMLButtonElement>('[aria-label="Wrap lines"]')?.click());
  await until(visibleCharacter, "unwrapped column is visible");
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  check(visibleCharacter(), "Unwrapped column moved out of view after measuring its row");
  render(location(2, 999));
  await until(
    () => document.body.textContent?.includes("Column 999 is unavailable.") === true,
    "missing column explanation",
  );
  check(
    !document.querySelector("[data-file-column]"),
    "Missing column highlighted another character",
  );
  render(location(999, 2));
  await until(
    () => document.body.textContent?.includes("Line 999 is unavailable.") === true,
    "missing line explanation",
  );
  check(
    !document.querySelector("[data-file-column]"),
    "Missing line highlighted another line's character",
  );
  render(location(4, 4500));
  await until(
    () => document.body.textContent?.includes("Column 4500 is outside this preview.") === true,
    "clipped column explanation",
  );
  check(
    !document.querySelector("[data-file-column]"),
    "Clipped column highlighted the clipping notice",
  );
  render(location(2, undefined, 3));
  await until(
    () => document.querySelectorAll("[data-highlighted=true]").length === 2,
    "line range is highlighted",
  );
  render(location(999), { ...file, truncated: true });
  await until(
    () => document.body.textContent?.includes("Line 999 is outside this preview.") === true,
    "preview limit explanation",
  );
}
