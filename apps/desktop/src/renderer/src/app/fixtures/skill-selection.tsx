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
  function Editable({ initial, skills = demo }: { initial: string; skills?: Skill[] }) {
    const [text, setText] = useState(initial);
    return (
      <SkillPrompt
        ref={input}
        value={text}
        skills={skills}
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

  let descriptionReads = 0;
  const measured = [
    {
      ...demo[0],
      get description() {
        descriptionReads++;
        return "Review changes";
      },
    },
  ];
  flushSync(() => root.render(<Editable key="dismissed" initial="/rev /r" skills={measured} />));
  const dismissedEditor = host.querySelector<HTMLElement>('[role="textbox"]');
  if (!dismissedEditor) throw new Error("Missing dismissed-picker editor");
  flushSync(() => {
    input.current?.focus();
    input.current?.setSelectionRange(4, 4);
    dismissedEditor.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  await settle();
  check(host.querySelector('[role="listbox"]'), "Picker did not open before dismissal");
  flushSync(() =>
    dismissedEditor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    ),
  );
  descriptionReads = 0;
  flushSync(() => {
    input.current?.setSelectionRange(7, 7);
    dismissedEditor.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
  check(
    !host.querySelector('[role="listbox"]') && !descriptionReads,
    "Dismissed picker still filters the catalog",
  );
  flushSync(() => document.execCommand("insertText", false, "e"));
  check(
    host.querySelector('[role="listbox"]') && descriptionReads > 0,
    "Typing did not reopen the picker",
  );

  for (const initial of ["/rev", "Before /review", ""]) {
    flushSync(() => root.render(<Editable key={`undo-${initial}`} initial={initial} />));
    input.current?.focus();
    input.current?.setSelectionRange(initial.length, initial.length);
    if (initial === "/rev") {
      for (const letter of "iew")
        flushSync(() => document.execCommand("insertText", false, letter));
    } else flushSync(() => input.current?.insertText(initial ? "." : "/review "));
    const next = edited;
    const editor = host.querySelector<HTMLElement>('[role="textbox"]');
    if (!editor) throw new Error("Missing undo editor");
    flushSync(() =>
      editor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }),
      ),
    );
    check(edited === initial, "Keyboard undo failed across a skill transformation");
    flushSync(() =>
      editor.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "z",
          ctrlKey: true,
          shiftKey: true,
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    check(edited === next, "Keyboard redo failed across a skill transformation");
    flushSync(() =>
      editor.dispatchEvent(
        new InputEvent("beforeinput", {
          inputType: "historyUndo",
          bubbles: true,
          cancelable: true,
        }),
      ),
    );
    check(edited === initial, "Browser history intent failed across a skill transformation");
  }
  for (const [text, count] of [
    ["Use /review, then /review.", 2],
    ["```\n/review\n```", 0],
    ["  ```ts\n/review\n   ```\nUse /review", 1],
    ["Show \\` then /review", 1],
    ["` `` /review ` then /review", 1],
    ["`C:\\temp\\` then /review", 1],
    ["use `foo then /review", 1],
    ["```foo``` then /review", 1],
  ] as const) {
    flushSync(() => root.render(<Editable key={text} initial={text} />));
    check(
      host.querySelectorAll("[data-skill-command]").length === count,
      "Skill tokens disagree with invocation parsing",
    );
    check(
      Boolean(promptSkill(text, demo).skill) === Boolean(count),
      "Selected identity disagrees with literal parsing",
    );
  }

  const backwardText = "Before /review after";
  const backward = () => {
    const editor = host.querySelector<HTMLElement>('[role="textbox"]');
    if (!editor?.firstChild || !editor.lastChild)
      throw new Error("Missing backward selection editor");
    const selected = window.getSelection();
    check(
      selected?.anchorNode === editor.lastChild &&
        selected.anchorOffset === 6 &&
        selected.focusNode === editor.firstChild &&
        selected.focusOffset === 2,
      "Backward selection across a skill lost its anchor or focus",
    );
  };
  flushSync(() => root.render(<Editable key="backward" initial={backwardText} />));
  input.current?.focus();
  input.current?.setSelectionRange(backwardText.length, 2);
  backward();
  flushSync(() => root.render(<Editable key="backward" initial={backwardText} skills={[]} />));
  const undecorated = host.querySelector<HTMLElement>('[role="textbox"]');
  const selection = window.getSelection();
  check(
    selection?.anchorNode === undecorated?.firstChild &&
      selection?.anchorOffset === backwardText.length &&
      selection?.focusNode === undecorated?.firstChild &&
      selection?.focusOffset === 2,
    "Removing skill decoration reversed the selection",
  );
  flushSync(() => root.render(<Editable key="backward" initial={backwardText} />));
  backward();
  flushSync(() => input.current?.insertText("X"));
  check(edited === "BeX", "Replacing a backward selection damaged the draft");
  input.current?.setSelectionRange(3, 1);
  const backwardEditor = host.querySelector<HTMLElement>('[role="textbox"]');
  if (!backwardEditor) throw new Error("Missing backward undo editor");
  flushSync(() =>
    backwardEditor.dispatchEvent(
      new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true }),
    ),
  );
  check(edited === backwardText, "Backward replacement undo lost text");
  backward();
  flushSync(() =>
    backwardEditor.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "z",
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    ),
  );
  const redone = window.getSelection();
  check(
    edited === "BeX" &&
      redone?.anchorNode === backwardEditor.firstChild &&
      redone.anchorOffset === 3 &&
      redone.focusNode === backwardEditor.firstChild &&
      redone.focusOffset === 1,
    "Redo reversed the saved backward selection",
  );

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
  for (const { skills, width, prefix, action } of [
    { skills: demo, width: 320, prefix: "/", action: "Enter" },
    { skills: demo, width: 720, prefix: "$", action: "Tab" },
    { skills: demo, width: 2560, prefix: "/", action: "click" },
    { skills: worst, width: 320, prefix: "$", action: "Enter" },
    { skills: worst, width: 720, prefix: "/", action: "Tab" },
    { skills: worst, width: 2560, prefix: "$", action: "click" },
  ]) {
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
    check(!forwarded && value.includes(`${prefix}rev${after}`), "IME selected or sent a skill");
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
