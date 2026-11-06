import type { AttachedFile } from "../../../../shared/contracts/attachments";
import {
  useEffect,
  useCallback,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type Ref,
} from "react";
import { useVirtualWindow } from "../repository/virtual-window";
import { createPortal } from "react-dom";
import { PromptEditor, type PromptEditorHandle } from "./prompt-editor";
import { Button } from "@tidy/ui/button";
import { codeScrollbarClassName } from "../../styles/code-ui";
import {
  matchingSkills,
  skillCommands,
  skillQuery,
  type Skill,
} from "../../../../shared/contracts/skills";
import type { Message } from "../../../../shared/contracts/desktop";
import { showToast } from "@tidy/ui/toast";

type HistoryEntry = Pick<Message, "text"> & { attachments?: AttachedFile[] };

type Props = Omit<ComponentProps<typeof PromptEditor>, "ref" | "skill" | "skills"> & {
  ref?: Ref<PromptEditorHandle>;
  skills: Skill[];
  status: "loading" | "ready" | "error";
  retry(): void;
  history?: readonly HistoryEntry[];
  historyDisabled?: boolean;
  onRecall?(entry: HistoryEntry): void;
  rememberedSkill?: Pick<Skill, "id" | "name">;
};

export function SkillPrompt({
  ref,
  value,
  onChange,
  skills,
  status,
  retry,
  onKeyDown,
  history = [],
  historyDisabled = false,
  onRecall,
  rememberedSkill,
  ...props
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const input = useRef<PromptEditorHandle>(null);
  const assignInput = useCallback(
    (value: PromptEditorHandle | null) => {
      input.current = value;
      if (typeof ref === "function") ref(value);
      else if (ref) ref.current = value;
    },
    [ref],
  );
  const menu = useRef<HTMLDivElement>(null);
  const selection = useRef<{ text: string; cursor: number } | null>(null);
  const browsing = useRef<{
    entries: readonly HistoryEntry[];
    index: number;
    draft: HistoryEntry;
  } | null>(null);
  const id = useId();
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const query = skillQuery(value, cursor);
  const catalog = useMemo(() => new Map(skills.map((skill) => [skill.name, skill])), [skills]);
  const invokedSkills = useMemo(() => {
    const names = new Set(skillCommands(value).map((command) => command.name));
    return Array.from(names).flatMap((name) => {
      const skill =
        catalog.get(name) ?? (rememberedSkill?.name === name ? rememberedSkill : undefined);
      return skill ? [skill] : [];
    });
  }, [value, catalog, rememberedSkill]);
  const matches = useMemo(
    () => (query === null ? [] : matchingSkills(skills, query)),
    [skills, query],
  );
  const [rowHeight, setRowHeight] = useState(34);
  const virtualized = matches.length > 100;
  const virtual = useVirtualWindow(virtualized ? matches.length : 0, rowHeight);
  const attachMenu = useCallback(
    (node: HTMLDivElement | null) => {
      menu.current = node;
      virtual.attach(node);
    },
    [virtual.attach],
  );
  const visible = focused && !props.disabled && !dismissed && query !== null;
  const selected = matches[active] ?? matches[0];
  const selectedIndex = selected ? matches.indexOf(selected) : -1;
  const renderedIndices = virtualized
    ? Array.from({ length: virtual.end - virtual.start }, (_, offset) => virtual.start + offset)
    : matches.map((_, index) => index);
  if (virtualized && selectedIndex >= 0 && !renderedIndices.includes(selectedIndex))
    renderedIndices.push(selectedIndex);

  useEffect(() => {
    setActive(0);
  }, [query, skills]);

  useLayoutEffect(() => {
    const current = browsing.current;
    if (current && current.entries[current.index]?.text !== value) browsing.current = null;
    const pending = selection.current;
    selection.current = null;
    if (pending?.text === value) {
      input.current?.focus();
      input.current?.setSelectionRange(pending.cursor, pending.cursor);
    }
  }, [value]);

  useLayoutEffect(() => {
    if (!visible) return;
    const owner = container.current?.closest<HTMLElement>(".composer") ?? container.current;
    if (!owner) return;
    setAnchor(owner);
    const update = () => {
      const picker = menu.current;
      if (!picker) return;
      const bounds = owner.getBoundingClientRect();
      setRowHeight(bounds.width <= 600 ? 52 : 34);
      const lip = owner.querySelector<HTMLElement>(".composer-lip:not([inert])");
      const top = Math.min(bounds.top, lip?.getBoundingClientRect().top ?? bounds.top);
      picker.style.bottom = `calc(100% + ${bounds.top - top - 1}px)`;
      picker.style.maxHeight = `${Math.max(0, Math.min(284, top - 12))}px`;
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(owner);
    const lip = owner.querySelector(".composer-lip");
    if (lip) observer.observe(lip);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [visible, anchor]);

  useLayoutEffect(() => {
    if (visible && virtualized) virtual.reveal(selectedIndex);
    if (visible)
      menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [visible, anchor, selectedIndex, virtualized, rowHeight]);

  function choose(skill: Skill) {
    if (query === null) return;
    const start = cursor - query.length - 1;
    const prefix = value.slice(0, start);
    const trigger = value[start];
    const rest = value.slice(cursor);
    const token = `${trigger}${skill.name}`;
    const next = `${prefix}${token}${rest.startsWith(" ") ? rest : ` ${rest}`}`;
    if (next.length > (props.maxLength ?? 32_000)) {
      showToast(`Keep messages under ${(props.maxLength ?? 32_000).toLocaleString()} characters.`);
      return;
    }
    input.current?.focus();
    input.current?.setSelectionRange(start, cursor);
    input.current?.insertText(`${token}${rest.startsWith(" ") ? "" : " "}`);
    setDismissed(true);
  }

  return (
    <div
      ref={container}
      className="skill-prompt relative"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          (!event.currentTarget.contains(event.relatedTarget) &&
            !menu.current?.contains(event.relatedTarget))
        )
          setFocused(false);
      }}
    >
      {visible &&
        anchor &&
        createPortal(
          <div
            className={`skill-picker absolute inset-x-3 z-3 overflow-y-auto overscroll-contain scroll-py-[5px] rounded-t-xl border border-border bg-(--desktop-surface) p-[5px] shadow-[0_-8px_24px_light-dark(#00000006,#0000001a)] ${codeScrollbarClassName}`}
            ref={attachMenu}
            data-virtual={virtualized || undefined}
          >
            <div
              id={id}
              role="listbox"
              aria-label="Skills"
              style={
                virtualized
                  ? { position: "relative", height: matches.length * rowHeight }
                  : undefined
              }
            >
              {renderedIndices.map((index) => {
                const skill = matches[index];
                return (
                  <div
                    key={skill.id}
                    id={`${id}-${index}`}
                    role="option"
                    aria-posinset={index + 1}
                    aria-setsize={matches.length}
                    style={
                      virtualized
                        ? {
                            position: "absolute",
                            insetInline: 0,
                            top: index * rowHeight,
                            height: rowHeight,
                          }
                        : undefined
                    }
                    aria-selected={index === selectedIndex}
                    className="skill-option flex min-h-[34px] cursor-pointer items-center rounded-[5px] px-2.5 py-[7px] aria-selected:bg-hover-surface"
                    title={skill.description ? `${skill.name} — ${skill.description}` : skill.name}
                    onPointerMove={() => setActive(index)}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => choose(skill)}
                  >
                    <span className="flex min-w-0 flex-1 items-baseline gap-4 [@container_composer_(max-width:600px)]:flex-col [@container_composer_(max-width:600px)]:items-stretch [@container_composer_(max-width:600px)]:gap-0.5">
                      <span
                        className={`skill-option-name min-w-0 flex-[0_1_40%] overflow-hidden text-[13px] leading-[18px] font-medium text-ellipsis whitespace-nowrap text-ink [@container_composer_(max-width:600px)]:flex-auto ${virtualized ? "" : "[@container_composer_(max-width:600px)]:wrap-anywhere [@container_composer_(max-width:600px)]:whitespace-normal"}`}
                      >
                        <span className="me-0.5 font-normal text-muted-ink" aria-hidden="true">
                          {value[cursor - (query?.length ?? 0) - 1]}
                        </span>
                        {skill.name}
                      </span>
                      {skill.description && (
                        <span className="min-w-0 flex-1 overflow-hidden text-xs leading-4 text-ellipsis whitespace-nowrap text-muted-ink">
                          {skill.description}
                        </span>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            {!matches.length && (
              <div
                className="flex min-h-11 items-center justify-between gap-3 px-2.5 py-2 text-[13px] text-muted-ink"
                role="status"
              >
                {status === "loading"
                  ? "Loading skills…"
                  : status === "error"
                    ? "Could not load skills."
                    : skills.length
                      ? "No matching skills"
                      : "No skills available"}
                {(status === "error" || (status === "ready" && !skills.length)) && (
                  <Button
                    type="button"
                    className="quiet-button"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={() => {
                      input.current?.focus();
                      retry();
                    }}
                  >
                    Retry
                  </Button>
                )}
              </div>
            )}
          </div>,
          anchor,
        )}
      <PromptEditor
        {...props}
        ref={assignInput}
        value={value}
        skills={invokedSkills}
        role="textbox"
        aria-autocomplete="list"
        aria-haspopup="listbox"
        aria-controls={visible ? id : undefined}
        aria-activedescendant={visible && selected ? `${id}-${selectedIndex}` : undefined}
        onFocus={() => {
          setFocused(true);
          setCursor(input.current?.cursor() ?? 0);
        }}
        onCursorChange={setCursor}
        onChange={(text) => {
          browsing.current = null;
          onChange(text);
          setDismissed(false);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
          if (visible && event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            setDismissed(true);
            return;
          }
          if (
            visible &&
            !selected &&
            event.key === "Tab" &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            const retryButton = menu.current?.querySelector<HTMLButtonElement>("button");
            if (retryButton) {
              event.preventDefault();
              retryButton.focus();
              return;
            }
          }
          if (visible && matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            setActive(
              (selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
                matches.length,
            );
            return;
          }
          if (
            visible &&
            selected &&
            (event.key === "Enter" || event.key === "Tab") &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey
          ) {
            event.preventDefault();
            choose(selected);
            return;
          }
          if (
            !props.disabled &&
            !historyDisabled &&
            !event.defaultPrevented &&
            !event.shiftKey &&
            !event.metaKey &&
            !event.ctrlKey &&
            !event.altKey &&
            (event.key === "ArrowUp" || event.key === "ArrowDown")
          ) {
            const direction = event.key === "ArrowUp" ? "up" : "down";
            if (!browsing.current && direction === "up" && !value) {
              const entries = history.filter(
                (entry) => entry.text.length <= (props.maxLength ?? 32_000),
              );
              if (entries.length)
                browsing.current = {
                  entries,
                  index: entries.length,
                  draft: { text: value, attachments: props.files },
                };
            }
            const current = browsing.current;
            if (current && input.current?.atBoundary(direction)) {
              event.preventDefault();
              current.index = Math.max(
                0,
                Math.min(current.entries.length, current.index + (direction === "up" ? -1 : 1)),
              );
              const entry = current.entries[current.index] ?? current.draft;
              selection.current = { text: entry.text, cursor: entry.text.length };
              setCursor(entry.text.length);
              setDismissed(true);
              if (onRecall) onRecall(entry);
              else onChange(entry.text);
              if (current.index === current.entries.length) browsing.current = null;
              return;
            }
          }
          onKeyDown?.(event);
        }}
      />
    </div>
  );
}
