import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
} from "react";
import { Button } from "@tidy/ui/button";
import { codeScrollbarClassName } from "../../styles/code-ui";
import { matchingSkills, skillQuery, type Skill } from "../../../../shared/contracts/skills";

type Props = Omit<ComponentProps<"textarea">, "value" | "onChange"> & {
  value: string;
  onChange(value: string): void;
  skills: Skill[];
  status: "loading" | "ready" | "error";
  retry(): void;
};

export function SkillPrompt({
  value,
  onChange,
  skills,
  status,
  retry,
  onKeyDown,
  ...props
}: Props) {
  const input = useRef<HTMLTextAreaElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const selection = useRef<{ text: string; cursor: number } | null>(null);
  const id = useId();
  const [cursor, setCursor] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  const query = skillQuery(value, cursor);
  const matches = useMemo(() => matchingSkills(skills, query ?? ""), [skills, query]);
  const visible = focused && !props.disabled && !dismissed && query !== null;
  const selected = matches[active] ?? matches[0];
  const selectedIndex = selected ? matches.indexOf(selected) : -1;

  useEffect(() => {
    setActive(0);
  }, [query, skills]);
  useLayoutEffect(() => {
    if (visible)
      menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [visible, selectedIndex]);

  useLayoutEffect(() => {
    const pending = selection.current;
    selection.current = null;
    if (pending?.text === value) {
      input.current?.focus();
      input.current?.setSelectionRange(pending.cursor, pending.cursor);
    }
  }, [value]);

  function choose(skill: Skill) {
    const rest = value.slice(cursor);
    const next = `/${skill.name}${rest.startsWith(" ") ? rest : ` ${rest}`}`;
    selection.current = { text: next, cursor: skill.name.length + 2 };
    onChange(next);
    setDismissed(true);
  }

  return (
    <div
      className="skill-prompt"
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (
          !(event.relatedTarget instanceof Node) ||
          !event.currentTarget.contains(event.relatedTarget)
        )
          setFocused(false);
      }}
    >
      {visible && (
        <div className={`skill-picker ${codeScrollbarClassName}`} ref={menu}>
          <div id={id} role="listbox" aria-label="Skills">
            {matches.map((skill, index) => (
              <div
                key={skill.id}
                id={`${id}-${index}`}
                role="option"
                aria-selected={index === selectedIndex}
                className="skill-option"
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(skill)}
              >
                <span className="skill-option-content">
                  <span className="skill-option-name">
                    <span className="skill-option-slash" aria-hidden="true">
                      /
                    </span>
                    {skill.name}
                  </span>
                  {skill.description && (
                    <span className="skill-option-description">{skill.description}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
          {!matches.length && (
            <div className="skill-picker-status" role="status">
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
        </div>
      )}
      <textarea
        {...props}
        ref={input}
        value={value}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? id : undefined}
        aria-activedescendant={visible && selected ? `${id}-${selectedIndex}` : undefined}
        onFocus={() => {
          setFocused(true);
          setCursor(input.current?.selectionStart ?? 0);
        }}
        onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
        onChange={(event) => {
          onChange(event.target.value);
          setCursor(event.target.selectionStart);
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
          onKeyDown?.(event);
        }}
      />
    </div>
  );
}
