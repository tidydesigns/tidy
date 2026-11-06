import { createRef, useState } from "react";
import { flushSync } from "react-dom";
import type { Root } from "react-dom/client";
import { SkillPrompt } from "../../features/composer/skill-prompt";
import { promptSkill, type Skill } from "../../../../shared/contracts/skills";
import { type PromptEditorHandle } from "../../features/composer/prompt-editor";

const longestName = `review-0000-${"changes-".repeat(23)}done`;
const demo: Skill[] = [{ id: "current", name: "review", description: "Review changes" }];
const worst: Skill[] = Array.from({ length: 2000 }, (_, index) => ({
  id: `current-${index}`,
  name: index === 0 ? longestName : `review-${String(index).padStart(4, "0")}`,
  description: index === 0 ? "Review architecture — 检查 👩🏽‍💻 ".repeat(400).slice(0, 10_000) : "",
}));

export const skillSelectionFixtures = {
  "Demo data": demo,
  "Worst case": worst,
  Empty: [],
  One: [worst[0]],
} satisfies Record<string, Skill[]>;

export async function runSkillSelectionTests(root: Root) {
  const host = document.getElementById("root");
  if (!host) throw new Error("Missing test root");
  const check = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 40));
  const input = createRef<PromptEditorHandle>();
  let edited = "";
  function Editable({ initial }: { initial: string }) {
    const [text, setText] = useState(initial);
    return (
      <SkillPrompt
        ref={input}
        value={text}
        skills={demo}
        status="ready"
        retry={() => {}}
        onChange={(next) => {
          edited = next;
          setText(next);
        }}
      />
    );
  }
  flushSync(() => root.render(<Editable key="plain" initial="Plain draft" />));
  const plainEditor = host.querySelector<HTMLElement>('[role="textbox"]');
  if (!plainEditor) throw new Error("Missing plain editor");
  const originalText = plainEditor.firstChild;
  input.current?.focus();
  input.current?.setSelectionRange(11, 11);
  flushSync(() => document.execCommand("insertText", false, "!"));
  check(edited === "Plain draft!", "Plain typing lost content");
  check(plainEditor.firstChild === originalText, "Plain typing rebuilt native editable nodes");
  flushSync(() => document.execCommand("undo"));
  check(edited === "Plain draft", "Plain typing broke native undo");

  for (const prefix of ["/", "$"]) {
    const initial = `Before ${prefix}review after`;
    flushSync(() => root.render(<Editable key={prefix} initial={initial} />));
    const editor = host.querySelector<HTMLElement>('[role="textbox"]');
    const token = editor?.querySelector<HTMLElement>("[data-skill-command]");
    if (!editor || !token) throw new Error("Missing skill editor");
    input.current?.focus();
    const range = document.createRange();
    range.selectNode(token);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    const clipboardData = new DataTransfer();
    editor.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, clipboardData }));
    check(
      clipboardData.getData("text/plain") === `${prefix}review`,
      "Copying a skill lost its invocation",
    );
    flushSync(() => document.execCommand("delete"));
    check(edited === "Before  after", "Deleting a skill damaged surrounding text");
    flushSync(() => document.execCommand("undo"));
    check(edited === initial, "Deleting a skill broke native undo");
  }
  for (const skills of [demo, worst]) {
    for (const width of [320, 720, 2560]) {
      for (const prefix of ["/", "$"]) {
        for (const action of ["Enter", "Tab", "click"]) {
          const before = "👩🏽‍💻 Please use ";
          const after = " and keep 王秀英";
          let value = `${before}${prefix}rev${after}`;
          let remembered: Pick<Skill, "id" | "name"> | undefined;
          let submitted: ReturnType<typeof promptSkill> | undefined;
          let forwarded = 0;
          function Composer() {
            const [text, setText] = useState(value);
            return (
              <form
                className="composer"
                dir={width === 720 ? "rtl" : "ltr"}
                style={{
                  position: "relative",
                  marginTop: 350,
                  width,
                  containerType: "inline-size",
                  containerName: "composer",
                  fontSize: width === 320 ? "200%" : undefined,
                  colorScheme: width === 720 ? "dark" : "light",
                }}
                onSubmit={(event) => {
                  event.preventDefault();
                  submitted = promptSkill(text, skills, remembered);
                }}
              >
                <SkillPrompt
                  value={text}
                  onChange={(next) => {
                    value = next;
                    remembered = promptSkill(next, skills).skill;
                    setText(next);
                  }}
                  skills={skills}
                  status="ready"
                  retry={() => {}}
                  onKeyDown={(event) => {
                    forwarded++;
                    if (event.key === "Enter") event.currentTarget.closest("form")?.requestSubmit();
                  }}
                />
              </form>
            );
          }
          flushSync(() =>
            root.render(<Composer key={`${skills.length}-${width}-${prefix}-${action}`} />),
          );
          const editor = host.querySelector<HTMLElement>('[role="textbox"]');
          if (!editor?.firstChild) throw new Error("Missing editor text");
          editor.focus();
          const range = document.createRange();
          range.setStart(editor.firstChild, before.length + 4);
          range.collapse(true);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
          flushSync(() => editor.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
          await settle();
          const picker = host.querySelector<HTMLElement>(".skill-picker");
          check(picker, "Inline picker did not open");
          if (!picker) throw new Error("Missing picker");
          check(picker.scrollWidth <= picker.clientWidth + 1, "Skill data overflows picker width");
          check(
            picker.querySelectorAll('[role="option"]').length <= 100,
            "Large catalog was not virtualized",
          );
          const key = (key: string, extra: KeyboardEventInit = {}) =>
            flushSync(() =>
              editor.dispatchEvent(
                new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra }),
              ),
            );
          key("Enter", { isComposing: true });
          key("Enter", { keyCode: 229 });
          check(
            !forwarded && value.includes(`${prefix}rev${after}`),
            "IME selected or sent a skill",
          );
          if (action === "click") {
            const option = picker.querySelector<HTMLElement>('[aria-selected="true"]');
            if (!option) throw new Error("Missing selected option");
            flushSync(() => option.click());
          } else key(action);
          check(
            value === `${before}${prefix}${skills[0].name}${after}`,
            `Skill selection lost surrounding text (${skills.length}, ${width}, ${prefix}, ${action}): ${value}`,
          );
          check(!host.querySelector(".skill-picker"), "Picker remained open after selection");
          const skillToken = host.querySelector<HTMLElement>("[data-prompt-token=skill]");
          check(
            skillToken?.textContent === skills[0].name &&
              skillToken.getAttribute("aria-label") === `Skill: ${skills[0].name}`,
            "Skill token was not rendered",
          );
          check(
            skillToken?.dataset.skillCommand === `${prefix}${skills[0].name}`,
            "Skill token lost its invocation prefix",
          );
          check(
            Boolean(skillToken && skillToken.getBoundingClientRect().width <= editor.clientWidth),
            "Long skill names overflow the editor",
          );
          check(!forwarded, "Selection also submitted the message");
          check(document.activeElement === editor, "Selection lost composer focus");
          key("Enter");
          check(submitted?.skill?.id === skills[0].id, "Submission used an outdated skill id");
          check(forwarded === 1, "Submission was not forwarded exactly once");
        }
      }
    }
  }
}
